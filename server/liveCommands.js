/**
 * Commands being run on a CLI's behalf, watched while they run.
 *
 * A CLI working in a folder runs builds, tests and scripts through the
 * workbench (server/mcpWorkbench.mjs) -- a separate process the CLI starts,
 * which this server never talks to. Until the command finished, the reader saw
 * only "[tool: workbench / run_command]" and a pause of however many minutes.
 *
 * So each command keeps a small file in a spool folder both processes know:
 * what it is, its pid, when it started, the tail of its output so far, and --
 * once it is over -- its exit code. The workbench writes it (a few times a
 * second at most); this server reads the folder for `/cli/commands`, and can
 * stop one by its pid. Codex's own command execution, which does not go through
 * the workbench, is put into the same list from its events (`noteCommand`).
 *
 * Files, not a socket: the workbench needs no port, no token and no idea
 * whether the web UI is even running.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const SPOOL = process.env.WEBUI_COMMAND_SPOOL || path.join(os.tmpdir(), 'ollama-webui-commands');

/* How much output a live entry keeps: the end is what says how it is going. */
export const TAIL_CHARS = 12000;
/* A finished command stays listed this long, so its result is seen. */
const KEEP_DONE_MS = 3 * 60 * 1000;
/* Anything older is swept away, running or not (a crashed workbench). */
const SWEEP_MS = 6 * 3600 * 1000;

/* The whole output is kept beside it, up to this much, for "download log". */
const LOG_MAX_BYTES = 20 * 1024 * 1024;

const tail = (text) => (text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text);
const safeId = (id) => String(id).replace(/[^\w.-]/g, '_');
const fileOf = (id) => path.join(SPOOL, `${safeId(id)}.json`);
const logOf = (id) => { try { fs.mkdirSync(SPOOL, { recursive: true }); } catch { /* */ } return path.join(SPOOL, `${safeId(id)}.log`); };

/* A dev server's own address in what it printed ("Local: http://localhost:5173/"),
   so the monitor can offer to open it. ANSI colour is taken off first. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s'"`)\]]*)?/gi;
export const urlsIn = (text, had = []) => {
  const found = new Set(had);
  for (const m of String(text).replace(ANSI, '').matchAll(LOCAL_URL)) {
    if (found.size >= 5) break;
    found.add(m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, ''));
  }
  return [...found];
};

const writeEntry = (entry) => {
  try {
    fs.mkdirSync(SPOOL, { recursive: true });
    const file = fileOf(entry.id);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(entry));
    fs.renameSync(temp, file);
  } catch { /* monitoring is a courtesy; the command runs regardless */ }
};

/**
 * For the process running the command: made when it starts, then
 * `setPid(pid)`, `output(chunk)` as it comes and `finish(result)` at the end.
 * Writes are throttled.
 */
export const commandSpool = ({ command, cwd, pid, shell = '', source = 'workbench', background = false }) => {
  const entry = {
    id: `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    source, command: String(command).slice(0, 2000), cwd: String(cwd || ''), shell, pid: pid || null,
    started: Date.now(), updated: Date.now(), status: 'running', code: null, output: '', bytes: 0,
    background: !!background, urls: [],
  };
  let timer = null;
  const flush = () => { timer = null; entry.updated = Date.now(); writeEntry(entry); };
  const soon = () => { if (!timer) timer = setTimeout(flush, 300); };
  flush();
  const log = logOf(entry.id);
  return {
    id: entry.id,
    setPid(p) { entry.pid = p; soon(); },
    output(chunk) {
      const text = String(chunk);
      entry.bytes += text.length;
      entry.output = tail(entry.output + text);
      // The whole of it, for download; the entry only keeps the end.
      if (entry.bytes <= LOG_MAX_BYTES) { try { fs.appendFileSync(log, text); } catch { /* watching only */ } }
      entry.urls = urlsIn(text, entry.urls);
      soon();
    },
    finish({ code, timedOut = false, ms } = {}) {
      clearTimeout(timer);
      entry.status = timedOut ? 'timedOut' : (code === 0 ? 'done' : 'failed');
      entry.code = timedOut ? null : code;
      entry.ms = ms ?? Date.now() - entry.started;
      flush();
    },
  };
};

/* Commands the server itself saw run (Codex's), kept in memory. */
const inMemory = new Map();

/** From a CLI's own events: `{ id, command, cwd, output?, status?, code? }`. */
export const noteCommand = ({ id, command, cwd = '', output, append, status, code, source = 'codex' }) => {
  if (!id) return;
  const key = `${source}:${id}`;
  const was = inMemory.get(key) || {
    id: key, source, command: '', cwd, pid: null, started: Date.now(), status: 'running', code: null, output: '', bytes: 0,
  };
  const next = { ...was, updated: Date.now() };
  if (!next.full) next.full = '';
  if (command) next.command = String(command).slice(0, 2000);
  if (cwd) next.cwd = cwd;
  if (typeof append === 'string') {
    next.output = tail(was.output + append); next.bytes += append.length;
    if (next.full.length < 2 * 1024 * 1024) next.full += append;
    next.urls = urlsIn(append, was.urls || []);
  }
  if (typeof output === 'string') {
    next.output = tail(output);
    if (output.length > next.full.length) next.full = output.slice(-2 * 1024 * 1024);
    next.urls = urlsIn(output, next.urls || []);
  }
  if (status) {
    next.status = status;
    if (status !== 'running') next.ms = Date.now() - next.started;
  }
  if (code !== undefined) next.code = code;
  inMemory.set(key, next);
};

const alive = (pid) => {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Every command worth showing: running ones, and ones that ended a moment ago. */
export const listCommands = ({ now = Date.now() } = {}) => {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(SPOOL).filter(n => n.endsWith('.json')); } catch { /* nothing ran yet */ }
  for (const name of names) {
    const file = path.join(SPOOL, name);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const age = now - (entry.updated || entry.started || 0);
    if (age > SWEEP_MS || (entry.status !== 'running' && age > KEEP_DONE_MS)) {
      fs.rm(file, { force: true }, () => {});
      fs.rm(file.replace(/\.json$/, '.log'), { force: true }, () => {});
      continue;
    }
    // A workbench killed mid-command never writes its end. Such an entry used
    // to stay listed as "lost" for the whole six-hour sweep -- dead shells and
    // a long-gone dev server piling up under "running". Its process is gone,
    // so is its entry.
    // A command that never got a pid (killed before it spawned -- e.g. one
    // that stopped the server it ran under) is judged by the workbench that
    // spooled it: its pid is the middle part of the id. It used to count as
    // alive forever and sat under "running" for six hours.
    const owner = Number(String(entry.id || name).split('-')[1]) || null;
    if (entry.status === 'running' && !alive(entry.pid || owner)) {
      fs.rm(file, { force: true }, () => {});
      fs.rm(file.replace(/\.json$/, '.log'), { force: true }, () => {});
      continue;
    }
    found.push(entry);
  }
  for (const [key, entry] of inMemory) {
    const age = now - entry.updated;
    if (age > SWEEP_MS || (entry.status !== 'running' && age > KEEP_DONE_MS)) { inMemory.delete(key); continue; }
    found.push(entry);
  }
  return found.sort((a, b) => b.started - a.started).map(({ full, ...e }) => ({ ...e, elapsed: (e.status === 'running' ? now : e.started + (e.ms || 0)) - e.started }));
};

/** A command's whole output as far as it was kept, or null. */
export const readLog = (id) => {
  const key = String(id || '');
  if (inMemory.has(key)) return inMemory.get(key).full || inMemory.get(key).output || '';
  if (!/^[\w.-]+$/.test(key)) return null;
  try { return fs.readFileSync(path.join(SPOOL, `${key}.log`), 'utf8'); } catch { /* none written */ }
  try { return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')).output || ''; } catch { return null; }
};

/** Stop one by its id: the whole process tree, as a hung build usually has children. */
export const stopCommand = (id) => new Promise((resolve) => {
  const entry = listCommands().find(e => e.id === id);
  if (!entry || entry.status !== 'running' || !entry.pid) return resolve(false);
  const done = () => resolve(true);
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { windowsHide: true }, done);
  else { try { process.kill(-entry.pid, 'SIGTERM'); } catch { try { process.kill(entry.pid, 'SIGTERM'); } catch { /* gone */ } } done(); }
});
