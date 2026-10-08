/**
 * The tools a model needs to work on code, not just look at files.
 *
 * The filesystem MCP server reads a file whole or by its head and tail,
 * searches file *names*, and writes without saying what changed. Asked to add
 * a feature to a 900 KB App.jsx, a model with those tools could not find where
 * anything was, could not read the middle of the file, could not run the tests
 * -- and said so, and stopped. This is the rest of what it needs:
 *
 *   read_file    a range of lines, numbered, from any file however large
 *   grep         a regular expression across a tree, with context lines
 *   find_files   names by glob
 *   edit_file    replace an exact string, refusing an ambiguous one
 *   write_file   create or overwrite
 *   run_command  a shell command, with its exit code and output
 *
 * Every change comes back as a unified diff behind a `[file-change]` line, so
 * the model sees what it did and the app can show the reader (see
 * `fileChangesIn` and server/cliModels.js). Every path must lie inside one of
 * the roots the server was started with -- `mcp.json` is the permission, as it
 * is for the filesystem server.
 *
 * Pure functions here; server/mcpWorkbench.mjs speaks MCP around them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backupBefore } from './workbenchState.js';

/* ------------------------------------------------------------- limits */

/* Enough to be useful in one call, small enough that one call does not fill a
   context window. Every limit is said out loud when it bites. */
export const LIMITS = {
  readLines: 2000,          // lines per read_file by default
  lineChars: 2000,          // a minified line is cut here
  outputChars: 60_000,      // any one result
  grepMatches: 200,         // matching lines per grep
  grepFileBytes: 4 * 1024 * 1024,
  findResults: 500,
  commandMs: 120_000,
  commandMaxMs: 30 * 60_000,
  diffCells: 4_000_000,     // LCS table size before a change is shown whole
};

/* Directories nobody means when they search "the project". */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.cache',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '$RECYCLE.BIN', 'System Volume Information']);

/* ------------------------------------------------------------- paths */

const norm = (p) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Is `target` inside `root` (or the root itself)? */
export const within = (root, target) => {
  const r = norm(root);
  const t = norm(target);
  if (t === r) return true;
  const withSep = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(withSep);
};

/**
 * A path the model gave, as an absolute path inside a root, or an error that
 * says which roots there are. Relative paths are read against `base`.
 */
export const resolveIn = (roots, given, base = roots[0]) => {
  const text = String(given ?? '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw new Error('A path is required.');
  const abs = path.isAbsolute(text) ? path.resolve(text) : path.resolve(base || process.cwd(), text);
  // Resolve symlinks where the path exists, so a link cannot lead outside.
  let real = abs;
  try { real = fs.realpathSync.native(abs); } catch { /* not there yet: judged as written */ }
  if (!roots.some(root => within(root, real))) {
    throw new Error(`${abs} is outside the allowed folders: ${roots.join(', ')}`);
  }
  return abs;
};

/* ------------------------------------------------------------- output */

export const cap = (text, limit = LIMITS.outputChars) => {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n\n[... cut at ${limit} characters of ${s.length}]`;
};

const looksBinary = (buffer) => {
  const n = Math.min(buffer.length, 8000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
};

/* ------------------------------------------------------------- reading */

/**
 * Lines `offset`..`offset+limit-1` (1-based), numbered as `cat -n` does, with
 * the total so the model knows where it is in the file.
 */
export const readLines = (file, { offset = 1, limit = LIMITS.readLines } = {}) => {
  const buffer = fs.readFileSync(file);
  if (looksBinary(buffer)) return `${file} is a binary file (${buffer.length} bytes); it is not shown as text.`;
  const lines = buffer.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, Math.floor(Number(offset) || 1));
  const count = Math.max(1, Math.min(Math.floor(Number(limit) || LIMITS.readLines), 20_000));
  const slice = lines.slice(start - 1, start - 1 + count);
  const width = String(start + slice.length - 1).length;
  const body = slice.map((line, i) => {
    const shown = line.length > LIMITS.lineChars ? `${line.slice(0, LIMITS.lineChars)} [... line cut at ${LIMITS.lineChars} of ${line.length} chars]` : line;
    return `${String(start + i).padStart(width)}\t${shown}`;
  }).join('\n');
  const end = start + slice.length - 1;
  const header = slice.length
    ? `${file} -- lines ${start}-${end} of ${lines.length}${end < lines.length ? ` (continue with offset ${end + 1})` : ''}`
    : `${file} has ${lines.length} lines; nothing at line ${start}.`;
  return cap(`${header}\n${body}`);
};

/* ------------------------------------------------------------- searching */

/** Every file under `dir`, skipping the directories nobody means. */
function* walk(dir, { depth = 0, maxDepth = 40 } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || depth >= maxDepth) continue;
      yield* walk(full, { depth: depth + 1, maxDepth });
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** A glob as a RegExp over a path relative to the search root, with `/` separators. */
export const globToRegExp = (glob) => {
  let re = '';
  const g = String(glob || '*').replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close > i) {
        re += `(?:${g.slice(i + 1, close).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = close;
      } else re += '\\{';
    } else re += /[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  // A glob with no slash matches a name at any depth, as ripgrep's does.
  return new RegExp(g.includes('/') ? `^${re}$` : `(?:^|/)${re}$`, process.platform === 'win32' ? 'i' : '');
};

/**
 * Lines matching `pattern` under `root` (a file or a directory).
 * `filesOnly` lists the files with a match instead.
 */
export const grep = (root, pattern, {
  glob = '', ignoreCase = false, context = 0, maxResults = LIMITS.grepMatches, filesOnly = false,
} = {}) => {
  let re;
  try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch (e) { throw new Error(`Not a valid regular expression: ${e.message}`); }
  const filter = glob ? globToRegExp(glob) : null;
  const stat = fs.statSync(root);
  const files = stat.isFile() ? [root] : walk(root);
  const out = [];
  let matches = 0, filesMatched = 0, scanned = 0, truncated = false;
  const around = Math.max(0, Math.min(Number(context) || 0, 10));

  for (const file of files) {
    const rel = path.relative(stat.isFile() ? path.dirname(root) : root, file).split(path.sep).join('/');
    if (filter && !filter.test(rel)) continue;
    let buffer;
    try {
      if (fs.statSync(file).size > LIMITS.grepFileBytes) continue;
      buffer = fs.readFileSync(file);
    } catch { continue; }
    if (looksBinary(buffer)) continue;
    scanned++;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);
    if (!hits.length) continue;
    filesMatched++;
    if (filesOnly) {
      out.push(`${file} (${hits.length})`);
      if (out.length >= maxResults) { truncated = true; break; }
      continue;
    }
    const shown = new Set();
    const block = [];
    for (const hit of hits) {
      if (matches >= maxResults) { truncated = true; break; }
      matches++;
      for (let j = Math.max(0, hit - around); j <= Math.min(lines.length - 1, hit + around); j++) {
        if (shown.has(j)) continue;
        shown.add(j);
        const line = lines[j].length > 300 ? `${lines[j].slice(0, 300)}…` : lines[j];
        block.push(`${j + 1}${j === hit ? ':' : '-'} ${line}`);
      }
    }
    out.push(`${file}\n${block.join('\n')}`);
    if (truncated) break;
  }
  const summary = filesOnly
    ? `${filesMatched} file(s) match /${pattern}/ (${scanned} scanned)`
    : `${matches} match(es) in ${filesMatched} file(s) for /${pattern}/ (${scanned} scanned)`;
  return cap(`${summary}${truncated ? ` -- stopped at ${maxResults}; narrow the path or glob for more` : ''}\n\n${out.join('\n\n') || '(no matches)'}`);
};

/** Files whose path relative to `root` matches `glob`. */
export const findFiles = (root, glob, { maxResults = LIMITS.findResults } = {}) => {
  const re = globToRegExp(glob);
  const found = [];
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (re.test(rel)) { found.push(file); if (found.length >= maxResults) break; }
  }
  return cap(`${found.length}${found.length >= maxResults ? '+' : ''} file(s) matching ${glob} under ${root}\n${found.join('\n') || '(none)'}`);
};

/* ------------------------------------------------------------- diffs */

/**
 * A unified diff of two texts, line by line, with `context` lines around each
 * change. The common head and tail are set aside first; what is left is
 * compared exactly, or -- past `LIMITS.diffCells` -- shown as removed and
 * added whole, which is honest if coarse.
 */
export const unifiedDiff = (before, after, { context = 3, name = 'file' } = {}) => {
  // An empty text has no lines, not one empty line: a new file was counted "-1".
  const a = String(before ?? '') === '' ? [] : String(before).split(/\r?\n/);
  const b = String(after ?? '') === '' ? [] : String(after).split(/\r?\n/);
  // A final newline is the end of the last line, not an empty line after it.
  if (a.length > 1 && a[a.length - 1] === '') a.pop();
  if (b.length > 1 && b[b.length - 1] === '') b.pop();
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  // Edit script over the middle: ' ' kept, '-' removed, '+' added.
  const ops = [];
  if (midA.length * midB.length <= LIMITS.diffCells) {
    const n = midA.length, m = midB.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { ops.push([' ', midA[i]]); i++; j++; }
      // On a tie, the removal first: `-old` then `+new` is how a diff reads.
      else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push(['-', midA[i]]); i++; }
      else { ops.push(['+', midB[j]]); j++; }
    }
  } else {
    for (const line of midA) ops.push(['-', line]);
    for (const line of midB) ops.push(['+', line]);
  }

  const all = [...a.slice(0, head).map(l => [' ', l]), ...ops, ...a.slice(a.length - tail).map(l => [' ', l])];
  let added = 0, removed = 0;
  for (const [op] of all) { if (op === '+') added++; if (op === '-') removed++; }
  if (!added && !removed) return { diff: '', added, removed };

  // Hunks: runs of changes with `context` lines either side, merged when close.
  const changed = all.map(([op]) => op !== ' ');
  const hunks = [];
  let k = 0;
  while (k < all.length) {
    if (!changed[k]) { k++; continue; }
    let start = Math.max(0, k - context);
    let end = k;
    while (end < all.length) {
      let next = end + 1;
      while (next < all.length && !changed[next]) next++;
      if (next < all.length && next - end - 1 <= context * 2) { end = next; continue; }
      break;
    }
    end = Math.min(all.length - 1, end + context);
    if (hunks.length && start <= hunks[hunks.length - 1].end + 1) {
      hunks[hunks.length - 1].end = end;
    } else hunks.push({ start, end });
    k = end + 1;
  }

  const lines = [`--- a/${name}`, `+++ b/${name}`];
  for (const { start, end } of hunks) {
    let oldLine = 1, newLine = 1;
    for (let x = 0; x < start; x++) {
      if (all[x][0] !== '+') oldLine++;
      if (all[x][0] !== '-') newLine++;
    }
    const body = all.slice(start, end + 1);
    const oldCount = body.filter(([op]) => op !== '+').length;
    const newCount = body.filter(([op]) => op !== '-').length;
    lines.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const [op, text] of body) lines.push(`${op}${text}`);
  }
  return { diff: lines.join('\n'), added, removed };
};

/* The block every change is reported in. The line before the fence is what
   `fileChangesIn` looks for; the model reads it as plain prose. */
const DIFF_CHARS = 20_000;
export const changeReport = (file, before, after, verb) => {
  const { diff, added, removed } = unifiedDiff(before ?? '', after, { name: path.basename(file) });
  if (!diff) return `${verb} ${file} -- no change in content.`;
  const shown = diff.length > DIFF_CHARS ? `${diff.slice(0, DIFF_CHARS)}\n... (diff cut at ${DIFF_CHARS} characters)` : diff;
  return `${verb} ${file}\n[file-change] ${file} (+${added} -${removed})\n\`\`\`diff\n${shown}\n\`\`\``;
};

/* Read back by the same parser the chat uses. See src/fileChanges.js. */
export { fileChangesIn } from '../src/fileChanges.js';

/* ------------------------------------------------------------- writing */

const readIfThere = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

/* A file written with the line endings it already had, so an edit does not
   turn every line of a CRLF file into a change. */
const withEndingsOf = (original, text) => (original && /\r\n/.test(original) && !/\r\n/.test(text)
  ? text.replace(/\n/g, '\r\n') : text);

export const writeFile = (file, content) => {
  backupBefore(file);        // so the web UI can put it back (server/workbenchState.js)
  const before = readIfThere(file);
  const text = withEndingsOf(before, String(content ?? ''));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return changeReport(file, before?.replace(/\r\n/g, '\n') ?? '', text.replace(/\r\n/g, '\n'), before === null ? 'Created' : 'Wrote');
};

/**
 * Replace `oldString` with `newString`. It must occur exactly once unless
 * `replaceAll` -- an edit that lands on the wrong one of three identical
 * lines is worse than one that asks for more context.
 */
export const editFile = (file, oldString, newString, { replaceAll = false } = {}) => {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = /\r\n/.test(raw);
  const before = raw.replace(/\r\n/g, '\n');
  const find = String(oldString ?? '').replace(/\r\n/g, '\n');
  const put = String(newString ?? '').replace(/\r\n/g, '\n');
  if (!find) throw new Error('old_string is empty. To create or overwrite a file, use write_file.');
  if (find === put) throw new Error('old_string and new_string are the same; nothing would change.');
  const count = before.split(find).length - 1;
  if (count === 0) throw new Error(`old_string was not found in ${file}. Read the file again and copy the text exactly, including indentation.`);
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string occurs ${count} times in ${file}. Include more surrounding lines to make it unique, or set replace_all.`);
  }
  const after = replaceAll ? before.split(find).join(put) : before.replace(find, () => put);
  backupBefore(file);
  fs.writeFileSync(file, crlf ? after.replace(/\n/g, '\r\n') : after, 'utf8');
  return changeReport(file, before, after, `Edited${replaceAll && count > 1 ? ` (${count} places)` : ''}`);
};

/* ------------------------------------------------------------- commands */

/**
 * Run one command through the shell and resolve with its exit code and
 * output (stdout and stderr interleaved, the tail kept if it is long).
 */
export const runCommand = (command, { cwd, timeoutMs = LIMITS.commandMs, shell = '', monitor = null } = {}) => new Promise((resolve) => {
  /* `monitor` (server/liveCommands.js `commandSpool`) is told the pid, each
     piece of output and the end, so the command can be watched while it runs. */
  const tell = (method, ...args) => { try { monitor?.[method]?.(...args); } catch { /* watching only */ } };
  const limit = Math.max(1000, Math.min(Number(timeoutMs) || LIMITS.commandMs, LIMITS.commandMaxMs));
  let program, args;
  const which = String(shell || '').toLowerCase();
  if (which === 'powershell' || which === 'pwsh') {
    program = which === 'pwsh' ? 'pwsh' : 'powershell';
    args = ['-NoProfile', '-NonInteractive', '-Command', command];
  } else if (which === 'bash') {
    program = 'bash'; args = ['-lc', command];
  } else if (process.platform === 'win32') {
    program = process.env.ComSpec || 'cmd.exe'; args = ['/d', '/s', '/c', `"${command}"`];
  } else {
    program = '/bin/sh'; args = ['-c', command];
  }
  const started = Date.now();
  let output = '';
  const keep = (chunk) => {
    tell('output', chunk);
    output += chunk;
    if (output.length > LIMITS.outputChars * 2) output = output.slice(-LIMITS.outputChars);
  };
  let child;
  try {
    child = spawn(program, args, {
      cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true,
      windowsVerbatimArguments: program.toLowerCase().endsWith('cmd.exe'),
    });
  } catch (e) {
    tell('finish', { code: -1, ms: 0 });
    resolve({ code: -1, output: `could not start: ${e.message}`, ms: 0, timedOut: false });
    return;
  }
  tell('setPid', child.pid);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  }, limit);
  child.on('error', (e) => { keep(`\n${e.message}`); });
  child.on('close', (code) => {
    clearTimeout(timer);
    const result = { code: timedOut ? -1 : code ?? -1, output, ms: Date.now() - started, timedOut };
    tell('finish', result);
    resolve(result);
  });
});

/* How a command's result reads: the line the app looks for, then the output. */
export const commandReport = (command, cwd, { code, output, ms, timedOut }) => {
  const tail = output.length > LIMITS.outputChars
    ? `[... ${output.length - LIMITS.outputChars} earlier characters not shown]\n${output.slice(-LIMITS.outputChars)}`
    : output;
  return `[command] ${command} (in ${cwd}) -> ${timedOut ? 'timed out' : `exit ${code}`} after ${(ms / 1000).toFixed(1)}s\n${tail.trimEnd() || '(no output)'}`;
};

/** A command result's first line: `{ command, cwd, code, timedOut }`, or null. */
export const commandIn = (text) => {
  const m = /^\[command\] ([\s\S]+?) \(in (.+?)\) -> (timed out|exit (-?\d+))/m.exec(String(text || ''));
  return m ? { command: m[1], cwd: m[2], code: m[4] !== undefined ? Number(m[4]) : null, timedOut: m[3] === 'timed out' } : null;
};
