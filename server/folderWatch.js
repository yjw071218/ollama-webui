/**
 * Walking a folder, so the library can keep up with it.
 *
 * The knowledge library is filled by dragging files onto a panel, which is the
 * right way to add a manual and the wrong way to keep up with a folder that is
 * still being written to. The documents anybody actually wants to ask
 * questions about live in a folder — notes, invoices, a project's specs — and
 * that folder gains a file most weeks. Re-dragging it is a chore nobody
 * remembers, so the library goes stale and the answers quietly get worse.
 *
 * ## Why only the walk is here
 *
 * Everything that turns a file into vectors already exists and runs in the
 * browser: pdf.js extracts, Ollama embeds, IndexedDB stores, and
 * `src/ingest.js` is the one routine that does all three. Rebuilding that on
 * the server would mean a second PDF extractor with its own CJK character-map
 * bug to find, a second chunker that drifts from the first, and two answers to
 * "what is in this document".
 *
 * So the server does the one thing a browser cannot: it lists a directory and
 * hands over bytes. The decision about what changed, and all the work, stays
 * where it already was.
 *
 * ## A manifest, not a subscription
 *
 * There is no file watcher here. `fs.watch` is per-platform in its behaviour,
 * misses changes over network shares, reports a file before the program
 * writing it has finished, and needs a process that outlives the browser to be
 * worth anything. What it would buy is noticing a change in two seconds rather
 * than on the next scan.
 *
 * A scan is a directory listing, which on a folder of a few thousand files is
 * a few milliseconds, and it answers the question that is actually being
 * asked: what is here now, and what was here last time. Size and modification
 * time are the comparison; nothing is read, let alone hashed, until the
 * browser asks for a file it has decided is new.
 *
 * ## The limits are not tuning
 *
 * A path typed into a settings box can be `C:\` — by accident, because a
 * folder was moved, or because somebody wanted to see what would happen. Each
 * limit below is what stops that from being a browser tab receiving a hundred
 * thousand file names, or from holding the event loop while it counts them.
 */

import fs from 'node:fs';
import path from 'node:path';

/** How deep to go. Deep enough for a real folder, shallow enough for a mistake. */
const MAX_DEPTH = 6;

/** How many files to name. Past this, the scan says it was truncated. */
const MAX_FILES = 2000;

/* Skipped wherever they appear. A repository under a watched folder is the
   case that matters: `node_modules` alone is tens of thousands of files, none
   of which anybody wants to ask a question about, and it is exactly the kind
   of folder that ends up inside one somebody does. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', '.cache', '.idea', '.vscode', 'target',
  '$RECYCLE.BIN', 'System Volume Information',
]);

/* What is worth indexing. An allowlist here, unlike the attachment path --
   which deliberately has none, because a file somebody chose by hand is a file
   they meant. Nobody chose these: they are whatever happens to be in a folder,
   so a walk with no filter hands the browser every .dll and .png under it and
   then spends a minute deciding they are binary one at a time. */
const INDEXABLE = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log',
  '.pdf', '.docx',
  '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env',
  '.html', '.htm', '.xml',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1', '.sql',
]);

/** Bigger than this and it is a database or a dump, not a document. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const isIndexable = (name) => INDEXABLE.has(path.extname(String(name || '')).toLowerCase());

/**
 * Every indexable file under a folder, with what is needed to tell whether it
 * changed.
 *
 * Synchronous on purpose. `readdirSync` with `withFileTypes` gets the kind of
 * each entry from the directory record itself, without a `stat` per file,
 * which is the difference between a scan of a big folder taking milliseconds
 * and taking seconds — and the `stat` that is still needed happens only for
 * files that passed the extension filter.
 */
export const scanFolder = (root) => {
  const resolved = path.resolve(String(root || ''));
  if (!fs.existsSync(resolved)) {
    const error = new Error('Folder not found');
    error.statusCode = 404;
    throw error;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    const error = new Error('That path is a file, not a folder');
    error.statusCode = 400;
    throw error;
  }

  const files = [];
  let skipped = 0;
  let truncated = false;

  const walk = (dir, depth) => {
    if (truncated || depth > MAX_DEPTH) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // A folder this account cannot open is one folder's worth of nothing,
      // not a failed scan.
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      // Hidden by name, which is the convention on every platform this runs on
      // and the only one available on Windows without another stat.
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;             // a symlink, a socket, a device
      if (!isIndexable(entry.name)) { skipped++; continue; }

      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) { skipped++; continue; }

      files.push({
        path: full,
        name: entry.name,
        size: stat.size,
        /* Rounded to the second. Windows and network shares report
           sub-millisecond differences for a file nothing has touched, and a
           document re-embedded on every scan because its mtime moved by 0.4ms
           is minutes of GPU time spent on no change at all. */
        mtime: Math.floor(stat.mtimeMs / 1000),
      });

      if (files.length >= MAX_FILES) truncated = true;
    }
  };

  walk(resolved, 0);
  return { root: resolved, files, skipped, truncated, limit: MAX_FILES };
};

/**
 * One file's bytes, for the browser to extract.
 *
 * Base64 in JSON rather than a binary response, because every other route here
 * answers JSON and the alternative is a second content negotiation for one
 * endpoint. The cost is a third more bytes over a loopback connection, which
 * is not a cost.
 */
export const readFileBytes = (target) => {
  const resolved = path.resolve(String(target || ''));
  const stat = fs.statSync(resolved);            // throws ENOENT, which the route reports
  if (!stat.isFile()) {
    const error = new Error('That path is not a file');
    error.statusCode = 400;
    throw error;
  }
  if (stat.size > MAX_FILE_BYTES) {
    const error = new Error(`That file is ${Math.round(stat.size / 1024 / 1024)} MB, which is past the limit`);
    error.statusCode = 413;
    throw error;
  }
  return {
    name: path.basename(resolved),
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs / 1000),
    base64: fs.readFileSync(resolved).toString('base64'),
  };
};
