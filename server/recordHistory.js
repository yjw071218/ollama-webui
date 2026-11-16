// What happens to `record_history` after a row lands in it.
//
// Every replaced record is copied here (see applyChanges in records.js), and
// until now nothing ever left. A chat is saved whole on every edit, so a long
// conversation that was touched a thousand times kept a thousand full copies of
// itself: on one install that was 743 MB of a 1 GB database, and every backup
// carried all of it again.
//
// The table exists to make an accidental overwrite recoverable, and that needs
// two things: the recent past in detail, and the older past coarsely. So each
// record keeps
//
//   * its newest `keepRecent` revisions, whatever their age, and
//   * one revision per day -- the last one of that day -- for `keepDays` days.
//
// Everything else goes. The live row in `records` is never touched here; this
// only thins out the copies of what it used to be.
//
// The same module serves the timeline screen: list what a record used to be,
// read one old version, and put it back.

import crypto from 'node:crypto';
import { database, transaction } from './db.js';

// ---------------------------------------------------------------------------
// Large strings, stored once.
//
// Measured on a real install: 725 MB of history was 57 MB of conversation and
// five pictures, each saved again with every edit of the chat under it. So a
// string above BLOB_MIN is written to history_blobs under its hash and the row
// keeps `BLOB_MARK + hash` where the string was. It is still valid JSON, still
// answers json_extract for the title, and unpacks to exactly what was stored.

export const BLOB_MIN = 32 * 1024;
export const BLOB_MARK = '\u0000webui-blob:sha256:';

const hashOf = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Replace large strings in a stored payload with markers; store each once. */
export const packPayload = (handle, payload) => {
  if (payload == null || payload.length < BLOB_MIN) return payload;
  const put = handle.prepare('INSERT OR IGNORE INTO history_blobs (hash, data) VALUES (?, ?)');
  let changed = false;
  const packed = JSON.stringify(JSON.parse(payload), (key, value) => {
    if (typeof value !== 'string' || value.length < BLOB_MIN || value.startsWith(BLOB_MARK)) return value;
    const hash = hashOf(value);
    put.run(hash, value);
    changed = true;
    return BLOB_MARK + hash;
  });
  return changed ? packed : payload;
};

/** The payload as it was stored, with every marker replaced by its string. */
export const unpackPayload = (handle, payload) => {
  if (payload == null || !payload.includes('webui-blob:sha256:')) return payload;
  const get = handle.prepare('SELECT data FROM readable_history_blobs WHERE hash = ?');
  return JSON.stringify(JSON.parse(payload), (key, value) => {
    if (typeof value !== 'string' || !value.startsWith(BLOB_MARK)) return value;
    const row = get.get(value.slice(BLOB_MARK.length));
    // A missing blob is a damaged revision, not an empty string pretending
    // to be the picture it was.
    if (!row) throw new Error('A stored attachment of this revision is missing.');
    return row.data;
  });
};

// ---------------------------------------------------------------------------
// Reading history without holding all of it.
//
// Payloads are stored encrypted and read through webui_decrypt, a JavaScript
// function SQLite calls once per row. Whatever one statement decrypts stays
// allocated until that statement ends, so a statement that looked at the
// whole table -- "which rows are still unpacked", "which rows mention a blob"
// -- held every revision of every chat at once. At 2 GB of history that is
// more than the process may allocate, and the server died two minutes after
// every start, where maintenance runs, taking its own cleanup with it.
//
// So nothing here decrypts more than one row per statement, and the two
// questions above are answered from a column instead of from the payload:
//
//   record_history.packed   0  not looked at yet (written before the column)
//                           1  holds no blob marker
//                           2  holds at least one blob marker
//
// New rows are stamped as they are written (see applyChanges in records.js).

export const HISTORY_UNSEEN = 0;
export const HISTORY_PLAIN = 1;
export const HISTORY_HAS_BLOBS = 2;

const MARK_TEXT = 'webui-blob:sha256:';

/** What `packed` should say about a payload as it is about to be stored. */
export const blobStateOf = (payload) =>
  (payload != null && payload.includes(MARK_TEXT) ? HISTORY_HAS_BLOBS : HISTORY_PLAIN);

/* Let whatever is waiting on the event loop run. */
const breathe = () => new Promise(resolve => setImmediate(resolve));

const readOne = (handle) =>
  handle.prepare('SELECT payload FROM readable_record_history WHERE rowid = ?');

/**
 * Look at up to `batch` rows nobody has looked at, or `maxBytes` of them,
 * whichever comes first: pack the ones that carry a large string and note
 * what each one holds. One short transaction.
 */
export const packHistoryStep = ({ after = 0, batch = 50, maxBytes = 24 * 1024 * 1024 } = {}) =>
  transaction((handle) => {
    // `packed <> 1` is the partial index's own condition, spelled out so the
    // planner uses it; the stored length needs no decryption.
    const rows = handle.prepare(`
      SELECT rowid, octet_length(payload) AS bytes FROM record_history
       WHERE packed <> 1 AND packed = 0 AND rowid > ?
       ORDER BY rowid
       LIMIT ?
    `).all(after, batch);
    const read = readOne(handle);
    const mark = handle.prepare('UPDATE record_history SET packed = ? WHERE rowid = ?');
    const repack = handle.prepare('UPDATE record_history SET payload = ?, packed = ? WHERE rowid = ?');
    let packed = 0;
    let seen = 0;
    let budget = maxBytes;
    for (const row of rows) {
      if (seen > 0 && budget <= 0) break;
      seen++;
      after = row.rowid;
      budget -= row.bytes || 0;
      let payload;
      // A row that cannot be read stays unseen: it is skipped by this cursor,
      // and it keeps collectBlobs from deleting anything it might refer to.
      try { payload = read.get(row.rowid)?.payload ?? null; } catch { continue; }
      if (payload == null || payload.includes(MARK_TEXT)) { mark.run(blobStateOf(payload), row.rowid); continue; }
      let next = payload;
      try { next = packPayload(handle, payload); } catch { continue; }
      if (next !== payload) { repack.run(next, HISTORY_HAS_BLOBS, row.rowid); packed++; }
      else mark.run(HISTORY_PLAIN, row.rowid);
    }
    return { after, packed, done: seen === rows.length && rows.length < batch };
  });

/**
 * Pack rows written before packing existed, a batch at a time so that one
 * run never holds the write lock for long. Returns how many rows it packed.
 */
export const packExistingHistory = (options = {}) => {
  let packed = 0;
  let after = 0;
  for (;;) {
    const step = packHistoryStep({ ...options, after });
    packed += step.packed;
    after = step.after;
    if (step.done) return packed;
  }
};

/**
 * Delete blobs no history row refers to any more.
 *
 * One transaction, without a pause in it: a revision written between reading
 * the references and deleting would be a reference this did not see.
 */
export const collectBlobs = () => transaction((handle) => {
  const referenced = new Set();
  const mark = /webui-blob:sha256:([0-9a-f]{64})/g;
  const read = readOne(handle);
  // Rows known to hold markers, and rows not looked at yet -- which may.
  for (const { rowid } of handle.prepare('SELECT rowid FROM record_history WHERE packed <> 1').all()) {
    let payload;
    // Not knowing what a row refers to is a reason to delete nothing.
    try { payload = read.get(rowid)?.payload; } catch { return 0; }
    if (payload) for (const m of payload.matchAll(mark)) referenced.add(m[1]);
  }
  const del = handle.prepare('DELETE FROM history_blobs WHERE hash = ?');
  let removed = 0;
  for (const { hash } of handle.prepare('SELECT hash FROM history_blobs').all()) {
    if (!referenced.has(hash)) removed += Number(del.run(hash).changes);
  }
  return removed;
});

/**
 * The same result, without stopping the server for the length of the scan.
 *
 * Reading the references is the slow part (every row that holds a marker is
 * decrypted), so it is done a slice at a time with requests let through in
 * between. The deciding part is still one transaction: it reads whatever was
 * written while the scan was under way -- a row the scan did not see, or a
 * rowid that now belongs to a different revision -- and only then deletes.
 * A row deleted meanwhile leaves its references counted, which keeps a blob
 * one sweep longer and loses nothing.
 */
export const collectBlobsAsync = async ({ slice = 25, pause = breathe } = {}) => {
  const handle = database();
  const referenced = new Set();
  const mark = /webui-blob:sha256:([0-9a-f]{64})/g;
  const read = readOne(handle);
  const seen = new Map(); // rowid -> rev, to tell a reused rowid from the row that was read
  const page = handle.prepare(
    'SELECT rowid, rev FROM record_history WHERE packed <> 1 AND rowid > ? ORDER BY rowid LIMIT ?'
  );
  const take = (row) => {
    const payload = read.get(row.rowid)?.payload;
    if (payload) for (const m of payload.matchAll(mark)) referenced.add(m[1]);
    seen.set(row.rowid, row.rev);
  };
  let after = 0;
  for (;;) {
    const rows = page.all(after, slice);
    // Not knowing what a row refers to is a reason to delete nothing.
    try { for (const row of rows) { take(row); after = row.rowid; } } catch { return 0; }
    if (rows.length < slice) break;
    await pause();
  }
  return transaction((h) => {
    try {
      for (const row of h.prepare('SELECT rowid, rev FROM record_history WHERE packed <> 1').all()) {
        if (seen.get(row.rowid) !== row.rev) take(row);
      }
    } catch { return 0; }
    const del = h.prepare('DELETE FROM history_blobs WHERE hash = ?');
    let removed = 0;
    for (const { hash } of h.prepare('SELECT hash FROM history_blobs').all()) {
      if (!referenced.has(hash)) removed += Number(del.run(hash).changes);
    }
    return removed;
  });
};

export const HISTORY_DEFAULTS = Object.freeze({
  keepRecent: 50,
  keepDays: 90,
  // A day in the owner's sense of a day, not UTC's. In Seoul, UTC midnight is
  // nine in the morning, which would split a working day in two.
  tzOffsetMs: -new Date().getTimezoneOffset() * 60 * 1000,
});

const DAY_MS = 24 * 60 * 60 * 1000;

const clampInt = (value, fallback, min) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/* The policy in force, so that a write can apply it to the one record it
   touched. Set by startHistoryMaintenance from .env; the defaults otherwise. */
let policy = { keepRecent: HISTORY_DEFAULTS.keepRecent, keepDays: HISTORY_DEFAULTS.keepDays };

/**
 * The DELETE itself, inside whatever transaction the caller holds. Scoped to
 * an account, or to one record of it, or to nothing.
 *
 * One statement, so it is all or nothing, and it is ranked by window functions
 * rather than by a loop in JavaScript: a thousand revisions of one chat is a
 * thousand full chats, and pulling them into memory to count them is exactly
 * the cost this is here to remove. It reads no payload at all.
 */
const pruneIn = (handle, {
  keepRecent = HISTORY_DEFAULTS.keepRecent,
  keepDays = HISTORY_DEFAULTS.keepDays,
  tzOffsetMs = HISTORY_DEFAULTS.tzOffsetMs,
  now = Date.now(),
  userId = null,
  kind = null,
  id = null,
} = {}) => {
  const recent = clampInt(keepRecent, HISTORY_DEFAULTS.keepRecent, 1);
  const days = clampInt(keepDays, HISTORY_DEFAULTS.keepDays, 0);
  const offset = Number(tzOffsetMs) || 0;
  const cutoff = now - days * DAY_MS;
  const one = userId && kind != null && id != null;
  const scope = one ? 'WHERE user_id = ? AND kind = ? AND id = ?' : userId ? 'WHERE user_id = ?' : '';
  const scoped = one ? [userId, kind, String(id)] : userId ? [userId] : [];
  const result = handle.prepare(`
    DELETE FROM record_history WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id, kind, id
                 ORDER BY rev DESC
               ) AS newest,
               ROW_NUMBER() OVER (
                 -- CAST, because a JavaScript number binds as REAL and a
                 -- REAL quotient is a different "day" for every millisecond.
                 PARTITION BY user_id, kind, id, CAST((updated_at + ?) / ${DAY_MS} AS INTEGER)
                 ORDER BY rev DESC
               ) AS in_day
          FROM record_history
         ${scope}
      )
      WHERE newest > ?
        AND (in_day > 1 OR updated_at < ?)
    )
  `).run(offset, ...scoped, recent, cutoff);
  return Number(result.changes);
};

/**
 * Delete the history rows the policy does not keep.
 */
export const pruneRecordHistory = (options = {}) => {
  const { userId = null } = options;
  return transaction((handle) => {
    // The stored (encrypted) sizes, read from the row headers: counting what
    // the payloads decrypt to meant decrypting every one of them.
    const size = handle.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(octet_length(payload)), 0) AS bytes
         FROM record_history ${userId ? 'WHERE user_id = ?' : ''}`
    );
    const before = size.get(...(userId ? [userId] : []));
    const removed = pruneIn(handle, options);
    const after = size.get(...(userId ? [userId] : []));
    return {
      removed,
      rowsBefore: before.n,
      rowsAfter: after.n,
      bytesFreed: before.bytes - after.bytes,
    };
  });
};

/* How many revisions a record may gather between trims. */
const TRIM_EVERY = 25;

/**
 * Apply the policy to one record, from inside the write that just added a
 * revision to it.
 *
 * The daily sweep alone lets a record grow without limit in between: a long
 * chat is saved whole every second or two while an answer streams, and one
 * such chat put 708 revisions -- 830 MB -- into this table in two days. This
 * keeps any single record near the policy at all times; the sweep is then
 * only about age.
 *
 * `at` is the write's own clock, never ahead of this machine's, so a device
 * with its date set in the future cannot age out revisions that are not old.
 */
export const trimRecordHistory = (handle, userId, kind, id, at = Date.now()) => {
  const count = handle.prepare(
    'SELECT COUNT(*) AS n FROM record_history WHERE user_id = ? AND kind = ? AND id = ?'
  ).get(userId, kind, String(id)).n;
  if (count <= policy.keepRecent || count % TRIM_EVERY !== 0) return 0;
  return pruneIn(handle, { ...policy, now: Math.min(Date.now(), Number(at) || Date.now()), userId, kind, id });
};

/**
 * Give the freed pages back to the disk, when there are enough to matter.
 *
 * VACUUM rewrites the whole file and holds the write lock while it does, so it
 * is not something to do after every small sweep: only when at least
 * `minFreeBytes` *and* a quarter of the file are free pages.
 */
export const compactIfWorthwhile = ({ minFreeBytes = 64 * 1024 * 1024 } = {}) => {
  const handle = database();
  const pageSize = handle.prepare('PRAGMA page_size').get().page_size;
  const pages = handle.prepare('PRAGMA page_count').get().page_count;
  const free = handle.prepare('PRAGMA freelist_count').get().freelist_count;
  const freeBytes = free * pageSize;
  const totalBytes = pages * pageSize;
  if (freeBytes < minFreeBytes || freeBytes < totalBytes / 4) {
    return { compacted: false, freeBytes, totalBytes };
  }
  handle.exec('VACUUM');
  handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const after = handle.prepare('PRAGMA page_count').get().page_count * pageSize;
  return { compacted: true, freeBytes, totalBytes, bytesAfter: after };
};

/** Prune, then compact if that freed enough. In one go; see the Async one. */
export const maintainRecordHistory = (options = {}) => {
  const pruned = pruneRecordHistory(options);
  const packed = packExistingHistory();
  const blobsRemoved = collectBlobs();
  const compact = compactIfWorthwhile(options);
  return { ...pruned, packed, blobsRemoved, ...compact };
};

/**
 * The same, letting requests through between the steps. What the scheduler
 * runs: the first pass over a large history is seconds of work, and done in
 * one piece that is seconds in which nobody's message is answered.
 */
export const maintainRecordHistoryAsync = async (options = {}) => {
  const pruned = pruneRecordHistory(options);
  await breathe();
  let packed = 0;
  let after = 0;
  for (;;) {
    const step = packHistoryStep({ after });
    packed += step.packed;
    after = step.after;
    if (step.done) break;
    await breathe();
  }
  const blobsRemoved = await collectBlobsAsync();
  await breathe();
  const compact = compactIfWorthwhile(options);
  // Hand the log back: a sweep that deleted a lot leaves a WAL its size.
  try { database().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* a reader is in the way; the next one does it */ }
  return { ...pruned, packed, blobsRemoved, ...compact };
};

/**
 * Prune once shortly after start, then daily.
 *
 * The first run is delayed so that it does not compete with the burst of
 * syncing every open tab does when the server comes back.
 */
export const startHistoryMaintenance = ({
  firstDelayMs = 2 * 60 * 1000,
  intervalMs = DAY_MS,
  log = console,
  ...options
} = {}) => {
  policy = {
    keepRecent: clampInt(options.keepRecent, HISTORY_DEFAULTS.keepRecent, 1),
    keepDays: clampInt(options.keepDays, HISTORY_DEFAULTS.keepDays, 0),
  };
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const r = await maintainRecordHistoryAsync(options);
      if (r.removed || r.packed || r.compacted) {
        const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
        log.info(`[history] removed ${r.removed} old revision(s), ${mb(r.bytesFreed)}; `
          + `deduplicated ${r.packed} revision(s)`
          + (r.compacted ? `; compacted ${mb(r.totalBytes)} -> ${mb(r.bytesAfter)}` : ''));
      }
    } catch (error) {
      log.error(`[history] maintenance failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, Math.max(0, firstDelayMs));
  const timer = setInterval(run, Math.max(60 * 1000, intervalMs));
  first.unref?.();
  timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
};

// ---------------------------------------------------------------------------
// The timeline: what a record used to be.

/** The revisions kept for one record, newest first, without their payloads. */
export const listRevisions = (userId, kind, id, limit = 200) =>
  database().prepare(`
    SELECT rev, updated_at AS updatedAt, deleted, LENGTH(payload) AS bytes,
           json_extract(payload, '$.title') AS title,
           json_array_length(payload, '$.messages') AS messages
      FROM readable_record_history
     WHERE user_id = ? AND kind = ? AND id = ?
     ORDER BY rev DESC
     LIMIT ?
  `).all(userId, kind, String(id), Math.min(1000, Math.max(1, limit)))
    .map(row => ({ ...row, deleted: !!row.deleted, messages: row.messages ?? null }));

/** One old version, whole. `null` when it is not kept (or is a deletion). */
export const readRevision = (userId, kind, id, rev) => {
  const handle = database();
  const row = handle.prepare(`
    SELECT rev, updated_at, deleted, payload FROM readable_record_history
     WHERE user_id = ? AND kind = ? AND id = ? AND rev = ?
  `).get(userId, kind, String(id), Number(rev));
  if (!row) return null;
  return {
    rev: row.rev,
    updatedAt: row.updated_at,
    deleted: !!row.deleted,
    payload: row.deleted ? null : JSON.parse(unpackPayload(handle, row.payload)),
  };
};

/** Which records of a kind have any history, for the timeline's picker. */
export const recordsWithHistory = (userId, kind, limit = 200) =>
  database().prepare(`
    SELECT id, COUNT(*) AS revisions, MAX(updated_at) AS lastAt
      FROM readable_record_history
     WHERE user_id = ? AND kind = ?
     GROUP BY id
     ORDER BY lastAt DESC
     LIMIT ?
  `).all(userId, kind, Math.min(1000, Math.max(1, limit)));
