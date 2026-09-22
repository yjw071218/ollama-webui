/**
 * Keeping the library level with a folder.
 *
 * The knowledge library is filled by dragging files onto a panel. That is the
 * right way to add a manual and the wrong way to keep up with a folder still
 * being written to — and the documents anybody actually wants to ask questions
 * about live in a folder that gains a file most weeks. Re-dragging it is a
 * chore nobody remembers, so the library goes quietly stale and the answers
 * get worse without ever saying why.
 *
 * The server lists the folder (see `server/folderWatch.js`); this decides what
 * that listing means, and `src/ingest.js` — the same routine the panel and the
 * composer use — does the work.
 *
 * ## The plan is the testable part
 *
 * `planSync` takes what is on disk and what is in the library and returns
 * three lists. Everything interesting is in there and none of it needs a
 * browser: a file that is new, a file whose bytes changed, a file that was
 * deleted, a document somebody added by hand that must not be touched, and the
 * rename — which is a delete and an add, and has to be, because nothing in a
 * directory listing says the two are related.
 *
 * ## Deleting is the part to be careful about
 *
 * A folder that fails to list — unplugged drive, a network share that dropped,
 * a path typo after a machine was renamed — looks exactly like a folder whose
 * every file was deleted. Acting on that reading destroys a library that took
 * an hour of GPU time to build, and the user's next question is answered from
 * nothing with no indication that anything is missing.
 *
 * So a removal is only ever computed from a scan that *succeeded*, and a
 * folder that fails is left entirely alone. It costs nothing: the documents
 * stay, the next successful scan tidies up, and the failure is reported.
 */

/** Where a document came from, for a document that came from a watched folder. */
export const sourceOf = (doc) => doc?.source;

/**
 * What to do to bring the library level with one folder's listing.
 *
 * `docs` is the whole library, not the folder's share of it: the filter has to
 * happen here, because a document with no `source` was added by hand and is
 * not this folder's to delete however much its name looks like a file that has
 * gone.
 */
export const planSync = (folder, files, docs) => {
  const mine = new Map();
  for (const doc of docs || []) {
    if (doc?.source?.folder === folder && doc.source.path) mine.set(doc.source.path, doc);
  }

  const add = [];
  const update = [];
  const seen = new Set();

  for (const file of files || []) {
    seen.add(file.path);
    const existing = mine.get(file.path);
    if (!existing) { add.push(file); continue; }
    /* Size *and* time. Time alone re-embeds a folder that was copied, restored
       from a backup or synced by a cloud client, all of which rewrite mtimes
       without changing a byte; size alone misses an edit that happened to keep
       the length, which for a text file being corrected is most of them. */
    if (existing.source.size !== file.size || existing.source.mtime !== file.mtime) {
      update.push({ ...file, replaces: existing.id });
    }
  }

  const remove = [...mine.values()].filter(doc => !seen.has(doc.source.path));

  return { add, update, remove };
};

/** Nothing to do, said once rather than checked in three places. */
export const isEmptyPlan = (plan) =>
  plan.add.length === 0 && plan.update.length === 0 && plan.remove.length === 0;

/**
 * Turn a base64 payload from the server into something `ingestDocument` takes.
 *
 * A `File`, because that is what the ingest path already accepts from a drop,
 * a paste and a file picker, and giving it a fourth shape to handle would mean
 * four ways for the extractor to be handed something it does not expect.
 */
export const fileFromBase64 = (name, base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { lastModified: Date.now() });
};

/** The setting, which is a list of paths and is stored as one string. */
export const parseFolders = (raw) => String(raw || '')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  // A path listed twice is one folder scanned twice, and the second pass would
  // see the first pass's documents as already present -- harmless, and still
  // half the work for nothing.
  .filter((line, i, all) => all.indexOf(line) === i);

export const serialiseFolders = (list) => (list || []).join('\n');

/* How long to leave between scans while the app is open. Ten minutes because
   the thing being noticed is "a file was saved into this folder", which nobody
   expects to be instant, and because a scan is cheap but not free: on a folder
   of two thousand files it is a directory walk the operating system has to do
   for real. */
export const SCAN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Ask the server what is in a folder.
 *
 * A failure is returned rather than thrown, because every caller wants the
 * same thing from it — carry on with the other folders and report this one —
 * and a throw would make that the caller's job three times over.
 */
export const scanFolder = async (folder, { signal } = {}) => {
  try {
    const res = await fetch('/localfs/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetPath: folder }),
      signal,
    });
    const data = await res.json();
    if (!data.success) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // The middleware is not running. Not an error the user caused, and not one
    // that should empty anything.
    return { ok: false, error: e.message };
  }
};

/** One file's bytes. Throws, because the caller counts failures per file. */
export const fetchFile = async (target, { signal } = {}) => {
  const res = await fetch('/localfs/bytes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetPath: target }),
    signal,
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
