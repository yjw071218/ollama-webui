/**
 * What the web UI may say about the workbench (server/mcpWorkbench.mjs), and
 * what the workbench keeps for the web UI.
 *
 *   policy   narrows what `mcp.json` allows: fewer folders, commands off,
 *            read-only, and approval rules. It can never widen it -- the
 *            folders it names only count where they fall inside a folder the
 *            workbench was started with, and switching commands "on" only
 *            undoes an "off" set here, not `--no-commands`. `mcp.json` stays
 *            the permission (see src/McpPanel.jsx); this is a dimmer on it.
 *   backups  the content a file had before the workbench last changed it, so
 *            the changed-files panel can put it back.
 *
 * Files in server/data, read on every call: the workbench is a separate
 * process a CLI starts, and a change made in the browser applies to the very
 * next tool call without restarting anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const stateDir = () => path.join(
  process.env.WEBUI_DATA_DIR ? path.resolve(process.env.WEBUI_DATA_DIR) : path.join(HERE, 'data'),
  'workbench',
);
const policyFile = () => path.join(stateDir(), 'policy.json');
const backupDir = () => path.join(stateDir(), 'backups');

const norm = (p) => {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const inside = (root, target) => {
  const r = norm(root), t = norm(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/* ------------------------------------------------------------- policy */

export const DEFAULT_POLICY = { roots: [], commands: true, readOnly: false, autoApprove: [] };

export const readPolicy = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(policyFile(), 'utf8'));
    return {
      roots: Array.isArray(raw.roots) ? raw.roots.map(String).filter(Boolean) : [],
      commands: raw.commands !== false,
      readOnly: raw.readOnly === true,
      autoApprove: Array.isArray(raw.autoApprove) ? raw.autoApprove.map(String).filter(Boolean).slice(0, 50) : [],
    };
  } catch { return { ...DEFAULT_POLICY }; }
};

export const writePolicy = (next = {}) => {
  const was = readPolicy();
  const policy = {
    roots: Array.isArray(next.roots) ? next.roots.map(r => String(r).trim()).filter(Boolean).slice(0, 50) : was.roots,
    commands: next.commands === undefined ? was.commands : next.commands !== false,
    readOnly: next.readOnly === undefined ? was.readOnly : next.readOnly === true,
    autoApprove: Array.isArray(next.autoApprove)
      ? next.autoApprove.map(r => String(r).trim()).filter(Boolean).slice(0, 50) : was.autoApprove,
  };
  for (const rule of policy.autoApprove) {
    // A rule that does not compile is refused rather than silently ignored.
    try { ruleMatcher(rule); } catch (e) { throw new Error(`Bad rule "${rule}": ${e.message}`); }
  }
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(policyFile(), JSON.stringify(policy, null, 2));
  return policy;
};

/**
 * What the workbench may actually do: the folders it was started with,
 * narrowed by the policy (a policy folder outside all of them counts for
 * nothing), and commands only when neither side turned them off.
 */
export const effectiveAccess = (startRoots, { noCommands = false } = {}, policy = readPolicy()) => {
  let roots = startRoots;
  if (policy.roots.length) {
    roots = policy.roots.map(r => path.resolve(r)).filter(r => startRoots.some(s => inside(s, r)));
  }
  return { roots, commands: !noCommands && policy.commands && !policy.readOnly, readOnly: policy.readOnly };
};

/* A rule is a plain prefix ("npm test", "git status") or /a regex/i. */
const ruleMatcher = (rule) => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(rule);
  if (m) { const re = new RegExp(m[1], m[2]); return (text) => re.test(text); }
  const prefix = rule.toLowerCase();
  return (text) => text.toLowerCase().startsWith(prefix);
};

/** Does an approval question (its title, e.g. a command) match a rule? */
export const autoApproved = (title, policy = readPolicy()) => {
  const text = String(title || '').trim();
  if (!text) return false;
  return policy.autoApprove.some((rule) => { try { return ruleMatcher(rule)(text); } catch { return false; } });
};

/* ------------------------------------------------------------ backups */

const backupFile = (file) => path.join(backupDir(), `${crypto.createHash('sha1').update(norm(file)).digest('hex')}.json`);
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

/**
 * Keep what `file` holds before it is changed. Only the first change in a
 * stretch is kept (for 30 minutes), so "undo" goes back to before the agent
 * started on it, not to before its last small edit.
 */
export const backupBefore = (file) => {
  try {
    const target = backupFile(file);
    try {
      const had = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (Date.now() - had.at < 30 * 60 * 1000 && !had.restored) return;
    } catch { /* none yet */ }
    let before = null;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BACKUP_BYTES) return;
      before = fs.readFileSync(file, 'utf8');
    } catch { before = null; } // not there yet: undo means delete it
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ file: path.resolve(file), before, at: Date.now() }));
  } catch { /* a backup is a courtesy; the edit goes ahead */ }
};

export const hasBackup = (file) => {
  try { return !JSON.parse(fs.readFileSync(backupFile(file), 'utf8')).restored; } catch { return false; }
};

/** Put a file back as it was. Returns `{ restored: 'content' | 'deleted' }`. */
export const restoreBackup = (file) => {
  const target = backupFile(file);
  let had;
  try { had = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw new Error('No saved copy of this file to go back to.'); }
  if (had.restored) throw new Error('This file was already put back.');
  if (had.before === null) fs.rmSync(had.file, { force: true });
  else fs.writeFileSync(had.file, had.before, 'utf8');
  had.restored = Date.now();
  fs.writeFileSync(target, JSON.stringify(had));
  return { restored: had.before === null ? 'deleted' : 'content' };
};

/** Every kept copy, newest first: `[{ file, at, restored, created }]`. */
export const listBackups = () => {
  let names = [];
  try { names = fs.readdirSync(backupDir()).filter(n => n.endsWith('.json')); } catch { return []; }
  const found = [];
  for (const name of names) {
    try {
      const had = JSON.parse(fs.readFileSync(path.join(backupDir(), name), 'utf8'));
      found.push({ file: had.file, at: had.at, restored: had.restored || null, created: had.before === null });
    } catch { /* half written */ }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, 300);
};

/** Old backups, swept now and then. */
export const sweepBackups = (maxAgeMs = 7 * 24 * 3600 * 1000) => {
  let names = [];
  try { names = fs.readdirSync(backupDir()); } catch { return; }
  for (const name of names) {
    const file = path.join(backupDir(), name);
    try { if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) fs.rmSync(file, { force: true }); } catch { /* gone */ }
  }
};
