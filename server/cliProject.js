/**
 * The CLIs as coding agents in a folder the reader chose, rather than as chat
 * models in an empty one.
 *
 * Everything in server/cliModels.js runs a CLI in a scratch directory with its
 * tools off or read-only, on purpose: a chat message must not become a shell
 * command. Project mode is the opt-in exception, and it is fenced three ways:
 *
 *   1. Only folders under CLI_PROJECT_ROOTS (in `.env`, never from the browser)
 *      can be named. Unset, project mode does not exist.
 *   2. Anything past reading and editing inside the folder -- a command, a
 *      write outside it -- is asked about in the browser (`/cli/approvals`),
 *      and declined if nobody answers in ten minutes.
 *   3. The folder is snapshotted into git before the run (without touching the
 *      reader's index, branch or stash), so every run's changes can be shown
 *      as a diff and put back with one click.
 *
 * Also here, because they are about the CLIs as agents rather than as models:
 * racing the three CLIs in git worktrees, the skills/agents/prompts each keeps
 * in its home folder, importing terminal sessions, a daily budget, and a
 * forecast of when each limit window runs out.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { autoApproved } from './workbenchState.js';

const HOME = os.homedir();
const listOf = (value) => String(value || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
const flag = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(on|1|true|yes)$/i.test(String(value).trim());
};
const dataDir = () => (process.env.WEBUI_DATA_DIR
  ? path.resolve(process.env.WEBUI_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));
export const SCRATCH = path.join(os.tmpdir(), 'ollama-webui-cli');
const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

/* ------------------------------------------------------------- the folder */

export const projectRoots = (env = {}) => listOf(env.CLI_PROJECT_ROOTS).map(p => path.resolve(p));

const samePathOrInside = (child, parent) => {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The folder a request names, as a real path under one of the roots, or an
 * error saying why not. Symlinks are resolved first, so a link inside a root
 * cannot point out of it.
 */
export const resolveProject = (dir, env = {}) => {
  const roots = projectRoots(env);
  if (!roots.length) throw new Error('Project mode is off: set CLI_PROJECT_ROOTS in .env to the folders the CLIs may work in.');
  let real;
  try { real = fs.realpathSync(path.resolve(String(dir))); } catch { throw new Error(`No such folder: ${dir}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const allowed = roots.some(root => {
    let r = root;
    try { r = fs.realpathSync(root); } catch { /* a root that does not exist admits nothing real */ }
    return samePathOrInside(real, r);
  });
  if (!allowed) throw new Error(`${dir} is not under CLI_PROJECT_ROOTS.`);
  return real;
};

export const MODES = ['plan', 'edit'];

/** What the headers ask for: `X-Cli-Project`, `X-Cli-Project-Mode`. Null when none. */
export const projectFromHeaders = (headers = {}, env = {}) => {
  const raw = String(headers['x-cli-project'] || '').trim();
  if (!raw) return null;
  let dir = raw;
  try { dir = decodeURIComponent(raw); } catch { /* sent plain */ }
  const mode = MODES.includes(String(headers['x-cli-project-mode'] || '').trim()) ? String(headers['x-cli-project-mode']).trim() : 'edit';
  return { dir: resolveProject(dir, env), mode, maxTurns: maxTurnsOf(env) };
};

export const maxTurnsOf = (env = {}) => {
  const n = Number(env.CLI_MAX_TURNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/* --------------------------------------------------------------- git */

export const git = (cwd, args, { env = {}, input } = {}) => new Promise((resolve) => {
  const child = execFile('git', args, {
    cwd, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  }, (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout || ''), err: String(stderr || error?.message || '') }));
  if (input !== undefined) child.stdin.end(input);
});

const IDENTITY = ['-c', 'user.name=ollama-webui', '-c', 'user.email=cli@ollama-webui.local'];

/* The working tree as a git tree object, untracked files included and
   ignored ones not, written through a throwaway index so the reader's own
   index, HEAD and stash are exactly as they were. */
export const snapshotTree = async (dir) => {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return null;
  const root = path.resolve(top.out.trim());
  const index = path.join(os.tmpdir(), `ollama-webui-index-${id()}`);
  try {
    const real = await git(root, ['rev-parse', '--git-path', 'index']);
    const realIndex = path.resolve(root, real.out.trim());
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);   // faster: unchanged files are not hashed again
    const gitEnv = { GIT_INDEX_FILE: index };
    const added = await git(root, ['add', '-A', '--', '.'], { env: gitEnv });
    if (!added.ok) return null;
    const tree = await git(root, ['write-tree'], { env: gitEnv });
    return tree.ok ? { root, tree: tree.out.trim() } : null;
  } finally {
    fs.rm(index, { force: true }, () => {});
  }
};

/** `{ files: [{ file, added, removed }], diff }` between two trees. */
export const diffTrees = async (root, before, after, { maxBytes = 400 * 1024 } = {}) => {
  if (!before || !after || before === after) return { files: [], diff: '' };
  const stat = await git(root, ['diff', '--numstat', before, after]);
  const files = stat.out.split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...name] = line.split('\t');
    return { file: name.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 };
  });
  const patch = await git(root, ['diff', before, after]);
  const diff = patch.out.length > maxBytes ? `${patch.out.slice(0, maxBytes)}\n… (diff cut at ${Math.round(maxBytes / 1024)} KB)` : patch.out;
  return { files, diff };
};

/* Put the working tree back to a snapshot: files the run added are removed,
   and every file in the snapshot is written as it was. Through a throwaway
   index again, so nothing staged is lost. */
export const restoreTree = async (root, before) => {
  const now = await snapshotTree(root);
  if (!now) throw new Error('Not a git repository any more');
  if (now.tree !== before) {
    const added = await git(root, ['diff', '--name-only', '--diff-filter=A', '-z', before, now.tree]);
    for (const file of added.out.split('\0').filter(Boolean)) {
      const full = path.resolve(root, file);
      if (samePathOrInside(full, root)) fs.rmSync(full, { force: true });
    }
  }
  const index = path.join(os.tmpdir(), `ollama-webui-index-${id()}`);
  try {
    const gitEnv = { GIT_INDEX_FILE: index };
    const read = await git(root, ['read-tree', before], { env: gitEnv });
    if (!read.ok) throw new Error(read.err.trim() || 'git read-tree failed');
    const out = await git(root, ['checkout-index', '-a', '-f'], { env: gitEnv });
    if (!out.ok) throw new Error(out.err.trim() || 'git checkout-index failed');
  } finally {
    fs.rm(index, { force: true }, () => {});
  }
};

/* Each run's before and after, kept so it can be undone later. */
const runsFile = () => path.join(dataDir(), 'cli-project-runs.json');
let runsStore = null;
const loadRuns = () => {
  if (runsStore) return runsStore;
  try { runsStore = JSON.parse(fs.readFileSync(runsFile(), 'utf8')) || []; } catch { runsStore = []; }
  return runsStore;
};
const saveRuns = () => {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(runsFile(), JSON.stringify(runsStore.slice(-200), null, 1));
  } catch { /* shown from memory */ }
};

export const noteRun = ({ owner = '', chat = '', root, before, after, files }) => {
  const entry = { id: `run-${id()}`, owner: String(owner || ''), chat, root, before, after, files, at: Date.now() };
  loadRuns().push(entry);
  saveRuns();
  return entry;
};

export const listRuns = (owner = '') => loadRuns().filter(r => r.owner === String(owner || '')).slice(-50).reverse();

export const revertRun = async (owner, runId) => {
  const run = loadRuns().find(r => r.id === runId && r.owner === String(owner || ''));
  if (!run) throw new Error('No such run');
  if (run.reverted) throw new Error('Already undone');
  await restoreTree(run.root, run.before);
  run.reverted = Date.now();
  saveRuns();
  return run;
};

/** The changes as the markdown the chat already renders (src/FileChanges.jsx). */
export const changesMarkdown = ({ files = [], diff = '' }, runId = '') => {
  if (!files.length) return '';
  const perFile = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const blocks = files.map((f) => {
    const chunk = perFile.find(p => p.includes(` b/${f.file}\n`) || p.startsWith(`diff --git a/${f.file} `)) || '';
    const body = chunk.split('\n').filter(l => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(l)).join('\n').trim();
    return ['', `📝 **\`${f.file}\`** (+${f.added} −${f.removed})`, '```diff', body || '(binary or mode change)', '```'].join('\n');
  });
  return `\n\n---\n${blocks.join('\n')}\n${runId ? `\n<!-- cli-run:${runId} -->\n` : ''}`;
};

/* ---------------------------------------------------------- approvals

   One queue for all three CLIs. Codex asks over its JSON-RPC; Claude Code
   asks through `--permission-prompt-tool`, which is server/mcpApproval.mjs
   dropping a file and waiting for one back (see `watchApprovalDir`). The
   browser polls `/cli/approvals` and answers. */

const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
const pending = new Map();
export const DECISIONS = ['accept', 'acceptForSession', 'decline'];

/* What an approval rule (server/workbenchState.js) is matched against: the
   question itself, and for a Claude tool call the command in its input. */
const approvalTexts = (title, detail) => {
  const texts = [String(title || '')];
  try {
    const input = JSON.parse(detail);
    for (const key of ['command', 'file_path', 'path']) if (typeof input?.[key] === 'string') texts.push(input[key]);
  } catch { /* not JSON */ }
  return texts;
};

export const requestApproval = ({ owner = '', chat = '', provider, kind, title, detail = '', timeoutMs = APPROVAL_TIMEOUT_MS }) => new Promise((resolve) => {
  // Allowed ahead of time in the MCP settings: nobody is asked.
  if (approvalTexts(title, detail).some(text => autoApproved(text))) { resolve('accept'); return; }
  const key = `ap-${id()}`;
  const timer = setTimeout(() => { pending.delete(key); resolve('decline'); }, timeoutMs);
  timer.unref?.();
  pending.set(key, {
    id: key, owner: String(owner || ''), chat, provider, kind, title: String(title || kind).slice(0, 300),
    detail: String(detail || '').slice(0, 20000), at: Date.now(),
    resolve: (decision) => { clearTimeout(timer); pending.delete(key); resolve(decision); },
  });
});

export const listApprovals = (owner = '') => [...pending.values()]
  .filter(p => p.owner === String(owner || ''))
  .map(({ resolve, ...rest }) => rest);

export const decideApproval = (owner, key, decision) => {
  const entry = pending.get(key);
  if (!entry || entry.owner !== String(owner || '')) return false;
  entry.resolve(DECISIONS.includes(decision) ? decision : 'decline');
  return true;
};

/* Claude Code's side: server/mcpApproval.mjs writes `<n>.req.json` into the
   run's folder and waits for `<n>.res.json`. Tools allowed "for this session"
   are remembered for the rest of the run. */
export const watchApprovalDir = (dir, approve) => {
  const seen = new Set();
  const always = new Set();
  const timer = setInterval(() => {
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.req.json')); } catch { return; }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      let req = {};
      try { req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
      const answer = (decision) => {
        if (decision === 'acceptForSession') always.add(req.tool_name);
        const ok = decision !== 'decline';
        const res = ok
          ? { behavior: 'allow', updatedInput: req.input || {} }
          : { behavior: 'deny', message: 'The user declined this in the web UI.' };
        try { fs.writeFileSync(path.join(dir, name.replace('.req.json', '.res.json')), JSON.stringify(res)); } catch { /* the run is gone */ }
      };
      if (always.has(req.tool_name)) { answer('accept'); continue; }
      Promise.resolve(approve({
        kind: 'tool', title: String(req.tool_name || 'tool'),
        detail: JSON.stringify(req.input || {}, null, 2),
      })).then(answer, () => answer('decline'));
    }
  }, 400);
  timer.unref?.();
  return () => clearInterval(timer);
};

/* Codex's side: its server requests, as a question and back as a reply. */
export const codexApprovalOf = (m) => {
  const p = m.params || {};
  if (/commandExecution\/requestApproval|execCommandApproval/i.test(m.method)) {
    const command = Array.isArray(p.command) ? p.command.join(' ') : String(p.command || '');
    return { kind: 'command', title: command || 'command', detail: [p.cwd ? `cwd: ${p.cwd}` : '', p.reason || ''].filter(Boolean).join('\n') };
  }
  if (/fileChange\/requestApproval|applyPatchApproval/i.test(m.method)) {
    return { kind: 'files', title: 'file changes', detail: [p.reason || '', p.grantRoot ? `write access to ${p.grantRoot}` : '', p.fileChanges ? JSON.stringify(p.fileChanges, null, 2) : ''].filter(Boolean).join('\n') };
  }
  return null;
};
export const codexApprovalReply = (m, decision) => {
  // The older `execCommandApproval` / `applyPatchApproval` speak "approved"/"denied".
  if (/^(execCommandApproval|applyPatchApproval)$/.test(m.method)) {
    return { id: m.id, result: { decision: decision === 'decline' ? 'denied' : decision === 'acceptForSession' ? 'approved_for_session' : 'approved' } };
  }
  return { id: m.id, result: { decision } };
};

/* ------------------------------------------------------------- budget */

/** Today's API-equivalent spend, and whether it is past CLI_DAILY_BUDGET_USD. */
export const budgetState = (lines = [], env = {}, { owner = null, now = Date.now() } = {}) => {
  const cap = Number(env.CLI_DAILY_BUDGET_USD);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const spent = lines
    .filter(l => l.at >= start.getTime() && (owner === null || (l.owner || '') === String(owner || '')))
    .reduce((sum, l) => sum + (Number(l.costUsd) || 0), 0);
  return { cap: Number.isFinite(cap) && cap > 0 ? cap : null, spent: Math.round(spent * 1e4) / 1e4, over: Number.isFinite(cap) && cap > 0 && spent >= cap };
};

/* ------------------------------------------------------------ forecast */

const historyFile = () => path.join(dataDir(), 'cli-limits-history.jsonl');

/** One sample per window each time a CLI reports its limits. */
export const noteLimitHistory = (provider, limits, { file = historyFile(), at = Date.now() } = {}) => {
  const rows = (limits?.windows || [])
    .filter(w => Number.isFinite(w.usedPercent))
    .map(w => JSON.stringify({ at, provider, id: w.id, used: w.usedPercent, resetsAt: w.resetsAt || null }));
  if (!rows.length) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${rows.join('\n')}\n`);
    const { size } = fs.statSync(file);
    if (size > 2 * 1024 * 1024) {
      const text = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, text.slice(text.indexOf('\n', text.length / 2) + 1));
    }
  } catch { /* a forecast is a nicety */ }
};

export const readLimitHistory = ({ file = historyFile(), since = 0 } = {}) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.at >= since);
  } catch { return []; }
};

/**
 * When a window will be used up at the rate it has been used since it
 * opened: `{ exhaustsAt, perHour }`, or null with too little to go on.
 * `exhaustsAt` is null when the window resets first.
 */
export const forecastWindow = (samples = [], window = {}, now = Date.now()) => {
  const mine = samples
    .filter(s => s.id === window.id && (!window.resetsAt || !s.resetsAt || Math.abs(s.resetsAt - window.resetsAt) < 5 * 60 * 1000))
    .sort((a, b) => a.at - b.at);
  if (mine.length < 2) return null;
  const first = mine[0], last = mine[mine.length - 1];
  const hours = (last.at - first.at) / 3600000;
  if (hours < 1 / 60 || last.used <= first.used) return { exhaustsAt: null, perHour: 0 };
  const perHour = (last.used - first.used) / hours;
  const current = Number.isFinite(window.usedPercent) ? window.usedPercent : last.used;
  const exhaustsAt = Math.round(Math.max(now, last.at) + ((100 - current) / perHour) * 3600000);
  return { exhaustsAt: window.resetsAt && exhaustsAt >= window.resetsAt ? null : exhaustsAt, perHour: Math.round(perHour * 10) / 10 };
};

export const withForecasts = (limits = {}, history = readLimitHistory({ since: Date.now() - 8 * 24 * 3600 * 1000 }), now = Date.now()) => {
  const out = {};
  for (const [provider, entry] of Object.entries(limits)) {
    const samples = history.filter(h => h.provider === provider);
    out[provider] = {
      ...entry,
      windows: (entry.windows || []).map(w => {
        if (w.reset) return w;
        const forecast = forecastWindow(samples, w, now);
        return forecast ? { ...w, forecast } : w;
      }),
    };
  }
  return out;
};

/* ------------------------------------------------- agy, estimated

   agy says nothing about its limits headless. Its runs are counted in the
   usage ledger, and the count when it last said "limit" is how many a window
   holds -- or CLI_AGY_5H_RUNS, if the reader knows better. */
export const agyEstimate = (lines = [], env = {}, { now = Date.now(), learned = null } = {}) => {
  const windowMs = 5 * 3600 * 1000;
  const capacity = Number(env.CLI_AGY_5H_RUNS) > 0 ? Number(env.CLI_AGY_5H_RUNS) : learned;
  if (!capacity) return null;
  const recent = lines.filter(l => l.provider === 'agy' && !l.error && l.at >= now - windowMs);
  const used = Math.min(100, Math.round((recent.length / capacity) * 1000) / 10);
  const oldest = recent.reduce((m, l) => Math.min(m, l.at), now);
  return {
    status: used >= 100 ? 'rejected' : used >= 80 ? 'allowed_warning' : 'allowed',
    windows: [{ id: 'five_hour', usedPercent: used, resetsAt: recent.length ? oldest + windowMs : null, windowMins: 300, estimated: true }],
    estimated: { runs: recent.length, capacity, learned: !(Number(env.CLI_AGY_5H_RUNS) > 0) },
    source: 'agy-estimate',
    updatedAt: now,
  };
};

/** Runs in the five hours before agy said "limit": the capacity learned. */
export const learnAgyCapacity = (lines = [], at = Date.now()) => {
  const runs = lines.filter(l => l.provider === 'agy' && !l.error && l.at >= at - 5 * 3600 * 1000 && l.at <= at).length;
  return runs > 0 ? runs : null;
};

/* ------------------------------------------ skills, agents, prompts */

const frontMatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
};

export const extensionPlaces = (env = {}, home = HOME) => {
  const codexHome = env.CODEX_HOME || process.env.CODEX_HOME || path.join(home, '.codex');
  return [
    { provider: 'claude-code', kind: 'skill', dir: path.join(home, '.claude', 'skills'), shape: 'folder' },
    { provider: 'claude-code', kind: 'agent', dir: path.join(home, '.claude', 'agents'), shape: 'file' },
    { provider: 'claude-code', kind: 'command', dir: path.join(home, '.claude', 'commands'), shape: 'file' },
    { provider: 'codex', kind: 'skill', dir: path.join(codexHome, 'skills'), shape: 'folder' },
    { provider: 'codex', kind: 'prompt', dir: path.join(codexHome, 'prompts'), shape: 'file' },
    { provider: 'agy', kind: 'agent', dir: env.AGY_AGENTS_DIR || path.join(home, '.gemini', 'config', 'agents'), shape: 'folder', entry: 'agent.md' },
  ];
};

const DISABLED = '.disabled';

/** Every skill, agent and prompt the CLIs will load, and those switched off here. */
export const listExtensions = (env = {}, home = HOME) => {
  const out = [];
  for (const place of extensionPlaces(env, home)) {
    let entries = [];
    try { entries = fs.readdirSync(place.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      let file, name;
      if (place.shape === 'folder' && e.isDirectory()) {
        const main = place.entry || 'SKILL.md';
        if (fs.existsSync(path.join(place.dir, e.name, main))) file = path.join(place.dir, e.name, main);
        else if (fs.existsSync(path.join(place.dir, e.name, main + DISABLED))) file = path.join(place.dir, e.name, main + DISABLED);
        name = e.name;
      } else if (place.shape === 'file' && e.isFile() && /\.md(\.disabled)?$/.test(e.name)) {
        file = path.join(place.dir, e.name);
        name = e.name.replace(/\.md(\.disabled)?$/, '');
      }
      if (!file) continue;
      let meta = {};
      try { meta = frontMatter(fs.readFileSync(file, 'utf8').slice(0, 4000)); } catch { /* unreadable */ }
      out.push({
        provider: place.provider, kind: place.kind, name,
        description: String(meta.description || '').slice(0, 300),
        enabled: !file.endsWith(DISABLED), file,
      });
    }
  }
  return out;
};

/** On or off by renaming the file the CLI looks for. Only files listExtensions found. */
export const setExtensionEnabled = (env, file, enabled, home = HOME) => {
  const known = listExtensions(env, home).find(x => x.file === file);
  if (!known) throw new Error('Unknown extension');
  if (known.enabled === !!enabled) return known;
  const target = enabled ? file.slice(0, -DISABLED.length) : file + DISABLED;
  fs.renameSync(file, target);
  return { ...known, enabled: !!enabled, file: target };
};

/* ------------------------------------------------- terminal sessions */

const textOfContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c?.type === 'text' || c?.type === 'input_text' || c?.type === 'output_text' ? c.text || '' : '')).join('');
};

const walkFiles = (dir, test, depth = 4, out = []) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walkFiles(full, test, depth - 1, out);
    else if (e.isFile() && test(e.name)) {
      try { out.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* gone */ }
    }
  }
  return out;
};

/** A Claude Code or Codex transcript as `{ messages, cwd, sessionId }`. */
export const parseSessionFile = (provider, text) => {
  const messages = [];
  let cwd = '', sessionId = '';
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (provider === 'claude-code') {
      cwd = cwd || line.cwd || '';
      sessionId = sessionId || line.sessionId || '';
      if ((line.type === 'user' || line.type === 'assistant') && line.message && !line.isMeta && !line.isSidechain) {
        const content = textOfContent(line.message.content).trim();
        if (content && !content.startsWith('<command-') && !content.startsWith('<local-command')) {
          const prev = messages[messages.length - 1];
          if (prev && prev.role === line.message.role) prev.content += `\n\n${content}`;
          else messages.push({ role: line.message.role, content });
        }
      }
    } else {
      if (line.type === 'session_meta') { cwd = line.payload?.cwd || cwd; sessionId = line.payload?.id || sessionId; }
      const p = line.type === 'response_item' ? line.payload : null;
      if (p?.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
        const content = textOfContent(p.content).trim();
        if (content && !/^<(environment_context|user_instructions|permissions)/.test(content) && !content.startsWith('# AGENTS.md')) {
          messages.push({ role: p.role, content });
        }
      }
    }
  }
  return { messages, cwd, sessionId };
};

export const listTerminalSessions = (env = {}, home = HOME, { limit = 40 } = {}) => {
  const codexHome = env.CODEX_HOME || process.env.CODEX_HOME || path.join(home, '.codex');
  const found = [
    ...walkFiles(path.join(home, '.claude', 'projects'), n => n.endsWith('.jsonl'), 1).map(f => ({ ...f, provider: 'claude-code' })),
    ...walkFiles(path.join(codexHome, 'sessions'), n => /^rollout-.*\.jsonl$/.test(n), 4).map(f => ({ ...f, provider: 'codex' })),
  ].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  return found.map(({ file, mtime, provider }) => {
    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 256 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      head = buf.toString('utf8');
    } catch { /* unreadable */ }
    const { messages, cwd } = parseSessionFile(provider, head);
    const first = messages.find(m => m.role === 'user');
    return {
      key: Buffer.from(file).toString('base64url'), provider, at: mtime, cwd,
      title: (first?.content || path.basename(file)).replace(/\s+/g, ' ').slice(0, 80),
    };
  }).filter(s => s.title);
};

export const readTerminalSession = (env, key, home = HOME) => {
  const file = Buffer.from(String(key), 'base64url').toString('utf8');
  const known = listTerminalSessions(env, home, { limit: 500 });
  const hit = known.find(s => s.key === key);
  if (!hit) throw new Error('No such session');
  return { ...hit, ...parseSessionFile(hit.provider, fs.readFileSync(file, 'utf8')) };
};

/* ------------------------------------------------------ worktree races

   The same task given to several CLIs, each in its own git worktree on its
   own branch, run side by side; the reader compares the diffs and merges the
   one they like. Worktrees are made from HEAD: uncommitted changes in the
   folder are not part of the race. */

const races = new Map();

export const startRace = async ({ owner = '', dir, prompt, models = [], run, mode = 'edit' }) => {
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new Error('A race needs a git repository');
  const root = path.resolve(top.out.trim());
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) throw new Error('The repository has no commits yet');
  const raceId = `race-${id(4)}`;
  const race = { id: raceId, owner: String(owner || ''), root, base: head.out.trim(), prompt, at: Date.now(), entries: [] };
  for (const [i, model] of models.slice(0, 4).entries()) {
    const slug = String(model).replace(/[^a-z0-9.-]+/gi, '-').slice(0, 40);
    const branch = `cli-race/${raceId}-${i}-${slug}`;
    const where = path.join(SCRATCH, 'worktrees', raceId, `${i}-${slug}`);
    fs.mkdirSync(path.dirname(where), { recursive: true });
    const added = await git(root, ['worktree', 'add', '-b', branch, where, race.base]);
    race.entries.push({ model, branch, dir: where, status: added.ok ? 'running' : 'failed', error: added.ok ? '' : added.err.trim(), text: '', files: [], diff: '' });
  }
  races.set(raceId, race);
  for (const entry of race.entries.filter(e => e.status === 'running')) {
    (async () => {
      try {
        entry.text = await run({ model: entry.model, dir: entry.dir, mode, prompt });
        await git(entry.dir, ['add', '-A']);
        await git(entry.dir, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', `${entry.model}: ${String(prompt).slice(0, 60)}`]);
        const d = await diffTrees(entry.dir, race.base, 'HEAD');
        Object.assign(entry, d, { status: 'done' });
      } catch (e) {
        Object.assign(entry, { status: 'failed', error: String(e.message || e) });
      }
    })();
  }
  return publicRace(race);
};

const publicRace = (race) => ({ ...race, entries: race.entries.map(({ dir, ...e }) => e) });

export const getRace = (owner, raceId) => {
  const race = races.get(raceId);
  if (!race || race.owner !== String(owner || '')) return null;
  return publicRace(race);
};

export const listRaces = (owner) => [...races.values()].filter(r => r.owner === String(owner || '')).map(publicRace);

/** Merge the chosen branch into the checked-out one, then remove every worktree. */
export const finishRace = async (owner, raceId, winner = null) => {
  const race = races.get(raceId);
  if (!race || race.owner !== String(owner || '')) throw new Error('No such race');
  if (race.entries.some(e => e.status === 'running')) throw new Error('Still running');
  let merged = null;
  if (winner !== null && winner !== undefined) {
    const entry = race.entries[Number(winner)];
    if (!entry || entry.status !== 'done') throw new Error('That entry did not finish');
    const m = await git(race.root, [...IDENTITY, 'merge', '--no-ff', '--no-edit', entry.branch]);
    if (!m.ok) {
      await git(race.root, ['merge', '--abort']);
      throw new Error(`Merge failed: ${m.err.trim() || m.out.trim()}`);
    }
    merged = entry.branch;
  }
  for (const entry of race.entries) {
    await git(race.root, ['worktree', 'remove', '--force', entry.dir]);
    await git(race.root, ['branch', '-D', entry.branch]);
  }
  await git(race.root, ['worktree', 'prune']);
  races.delete(raceId);
  return { merged };
};

export const projectSettings = (env = {}) => ({
  roots: projectRoots(env),
  maxTurns: maxTurnsOf(env),
  dailyBudgetUsd: Number(env.CLI_DAILY_BUDGET_USD) > 0 ? Number(env.CLI_DAILY_BUDGET_USD) : null,
  extensionsEditable: flag(env.CLI_EXTENSIONS_EDIT, false),
  terminalImport: flag(env.CLI_TERMINAL_IMPORT, false),
  agyEdit: flag(env.CLI_AGY_PROJECT_EDIT, false),
});
