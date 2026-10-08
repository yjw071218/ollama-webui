/**
 * Files a shell command changed, as the same 📝 cards an Edit gets.
 *
 * Claude Code reports a diff only for its own Edit / Write. A file rewritten
 * from Bash or PowerShell -- sed, a Python one-off, a heredoc -- changed on
 * disk and said nothing in the chat, so the cards showed fewer changes than
 * were made. This keeps what each git work tree it has seen looked like and,
 * when a shell command's result comes back, reports what differs.
 *
 * Only git work trees: their status says which files to look at, so a run
 * never walks a whole drive. Each tracker belongs to one ClaudeReader, CodexSession or agy transcript run.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { changeReport } from './workbench.js';

const MAX_FILES = 400;          // files looked at in one tree
const MAX_BYTES = 1024 * 1024;  // a larger file is not diffed
const MAX_CARDS = 30;

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 8000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

/** Absolute paths named in a command: C:\x, C:/x, /c/x (Git Bash), and `cd` targets. */
export const pathsIn = (command = '') => {
  const out = new Set();
  const text = String(command);
  // Quoted paths may contain spaces; POSIX paths also occur in Python scripts.
  for (const m of text.matchAll(/(["'])([A-Za-z]:[\\/][^"'\r\n]+|\/(?!\/)[^"'\r\n]+)\1/g)) {
    const p = m[2];
    out.add(/^\/[a-zA-Z]\//.test(p) ? `${p[1].toUpperCase()}:${p.slice(2)}` : p);
  }
  for (const m of text.matchAll(/(?:^|[\s"'`=(])([A-Za-z]:[\\/][^\s"'`;|&<>)]*)/g)) out.add(m[1]);
  for (const m of text.matchAll(/(?:^|[\s"'`=(])\/([a-zA-Z])\/([^\s"'`;|&<>)]*)/g)) out.add(`${m[1].toUpperCase()}:/${m[2]}`);
  if (process.platform !== 'win32') {
    for (const m of text.matchAll(/(?:^|[\s"'`=(])(\/(?!\/)[^\s"'`;|&<>)]*)/g)) out.add(m[1]);
  }
  return [...out].map(p => p.replace(/[\\/]+$/, '')).filter(Boolean);
};

const readText = (file) => {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString('utf8');
  } catch { return ''; }   // gone: empty
};

export class ShellChanges {
  constructor() {
    this.roots = new Map();     // work tree -> Map(relative file -> text|null)
    this.lookups = new Map();   // folder -> work tree or ''
  }

  rootOf(p) {
    let dir = p;
    try { if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch { dir = path.dirname(p); }
    while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) return ''; dir = up; }
    if (this.lookups.has(dir)) return this.lookups.get(dir);
    let root = '';
    try { root = path.resolve(git(dir, ['rev-parse', '--show-toplevel']).trim()); } catch { /* not a work tree */ }
    this.lookups.set(dir, root);
    return root;
  }

  /** The files git calls changed or new, relative to the tree. */
  dirty(root) {
    let raw = '';
    try { raw = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']); } catch { return []; }
    const files = [];
    const parts = raw.split('\0');
    for (let i = 0; i < parts.length && files.length < MAX_FILES; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      if (entry[0] === 'R' || entry[0] === 'C') i++;   // the old name follows
      files.push(entry.slice(3));
    }
    return files;
  }

  snapshot(root) {
    const state = new Map();
    for (const rel of this.dirty(root)) state.set(rel, readText(path.join(root, rel)));
    return state;
  }

  /** The trees a shell command may touch, seen before it runs. */
  watch(paths = []) {
    for (const p of paths) {
      const root = this.rootOf(p);
      if (root && !this.roots.has(root)) this.roots.set(root, this.snapshot(root));
    }
  }

  /** An Edit / Write already reported its own card: take its file as seen. */
  seen(file) {
    if (!file) return;
    const root = this.rootOf(file);
    if (!root || !this.roots.has(root)) return;
    const rel = path.relative(root, path.resolve(file)).split(path.sep).join('/');
    this.roots.get(root).set(rel, readText(file));
  }

  /** What changed in the watched trees since last looked, as change reports. */
  collect() {
    const reports = [];
    for (const [root, before] of this.roots) {
      const now = this.dirty(root);
      const files = new Set([...before.keys(), ...now]);
      const after = new Map();
      for (const rel of files) {
        const full = path.join(root, rel);
        const text = readText(full);
        after.set(rel, text);
        if (reports.length >= MAX_CARDS) continue;
        let old;
        if (before.has(rel)) old = before.get(rel);
        else {
          // Clean before: what was there is what is committed.
          try { old = git(root, ['show', `HEAD:${rel}`]); } catch { old = ''; }
        }
        if (old === null || text === null || old === text) continue;
        // CRLF/LF only: not a change anybody made on purpose.
        if (old.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n')) continue;
        reports.push(changeReport(full, old, text, fs.existsSync(full) ? 'Changed' : 'Deleted'));
      }
      this.roots.set(root, after);
    }
    return reports;
  }
}
