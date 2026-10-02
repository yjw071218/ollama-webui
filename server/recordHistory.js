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
  const get = handle.prepare('SELECT data FROM history_blobs WHERE hash = ?');
  return JSON.stringify(JSON.parse(payload), (key, value) => {
    if (typeof value !== 'string' || !value.startsWith(BLOB_MARK)) return value;
    const row = get.get(value.slice(BLOB_MARK.length));
    // A missing blob is a damaged revision, not an empty string pretending
    // to be the picture it was.
    if (!row) throw new Error('A stored attachment of this revision is missing.');
    return row.data;
  });
};

/**
 * Pack rows written before packing existed, a batch at a time so that one
 * run never holds the write lock for long. Returns how many rows it packed.
 */
export const packExistingHistory = ({ batch = 50 } = {}) => {
  let packed = 0;
  // A rowid cursor, because a row that is large without any single large
  // string cannot be packed and would otherwise be selected again forever.
  let after = 0;
  for (;;) {
    const done = transaction((handle) => {
      const rows = handle.prepare(`
        SELECT rowid, payload FROM record_history
         WHERE rowid > ? AND payload IS NOT NULL AND LENGTH(payload) >= ?
           AND instr(payload, 'webui-blob:sha256:') = 0
         ORDER BY rowid
         LIMIT ?
      `).all(after, BLOB_MIN, batch);
      const update = handle.prepare('UPDATE record_history SET payload = ? WHERE rowid = ?');
      for (const row of rows) {
        after = row.rowid;
        const next = packPayload(handle, row.payload);
        if (next !== row.payload) { update.run(next, row.rowid); packed++; }
      }
      return rows.length < batch;
    });
    if (done) return packed;
  }
};

/** Delete blobs no history row refers to any more. */
export const collectBlobs = () => transaction((handle) => {
  const referenced = new Set();
  const mark = /webui-blob:sha256:([0-9a-f]{64})/g;
  for (const row of handle.prepare(
    "SELECT payload FROM record_history WHERE instr(payload, 'webui-blob:sha256:') > 0"
  ).iterate()) {
    for (const m of row.payload.matchAll(mark)) referenced.add(m[1]);
  }
  const del = handle.prepare('DELETE FROM history_blobs WHERE hash = ?');
  let removed = 0;
  for (const { hash } of handle.prepare('SELECT hash FROM history_blobs').all()) {
    if (!referenced.has(hash)) removed += Number(del.run(hash).changes);
  }
  return removed;
});

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

/**
 * Delete the history rows the policy does not keep.
 *
 * One statement, so it is all or nothing, and it is ranked by window functions
 * rather than by a loop in JavaScript: a thousand revisions of one chat is a
 * thousand full chats, and pulling them into memory to count them is exactly
 * the cost this is here to remove.
 */
export const pruneRecordHistory = ({
  keepRecent = HISTORY_DEFAULTS.keepRecent,
  keepDays = HISTORY_DEFAULTS.keepDays,
  tzOffsetMs = HISTORY_DEFAULTS.tzOffsetMs,
  now = Date.now(),
  userId = null,
} = {}) => {
  const recent = clampInt(keepRecent, HISTORY_DEFAULTS.keepRecent, 1);
  const days = clampInt(keepDays, HISTORY_DEFAULTS.keepDays, 0);
  const offset = Number(tzOffsetMs) || 0;
  const cutoff = now - days * DAY_MS;

  return transaction((handle) => {
    const before = handle.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
         FROM record_history ${userId ? 'WHERE user_id = ?' : ''}`
    ).get(...(userId ? [userId] : []));

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
           ${userId ? 'WHERE user_id = ?' : ''}
        )
        WHERE newest > ?
          AND (in_day > 1 OR updated_at < ?)
      )
    `).run(offset, ...(userId ? [userId] : []), recent, cutoff);

    const after = handle.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
         FROM record_history ${userId ? 'WHERE user_id = ?' : ''}`
    ).get(...(userId ? [userId] : []));

    return {
      removed: Number(result.changes),
      rowsBefore: before.n,
      rowsAfter: after.n,
      bytesFreed: before.bytes - after.bytes,
    };
  });
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

/** Prune, then compact if that freed enough. What the scheduler runs. */
export const maintainRecordHistory = (options = {}) => {
  const pruned = pruneRecordHistory(options);
  const packed = packExistingHistory();
  const blobsRemoved = collectBlobs();
  const compact = compactIfWorthwhile(options);
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
  let stopped = false;
  const run = () => {
    if (stopped) return;
    try {
      const r = maintainRecordHistory(options);
      if (r.removed || r.packed || r.compacted) {
        const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
        log.info(`[history] removed ${r.removed} old revision(s), ${mb(r.bytesFreed)}; `
          + `deduplicated ${r.packed} revision(s)`
          + (r.compacted ? `; compacted ${mb(r.totalBytes)} -> ${mb(r.bytesAfter)}` : ''));
      }
    } catch (error) {
      log.error(`[history] maintenance failed: ${error.message}`);
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
      FROM record_history
     WHERE user_id = ? AND kind = ? AND id = ?
     ORDER BY rev DESC
     LIMIT ?
  `).all(userId, kind, String(id), Math.min(1000, Math.max(1, limit)))
    .map(row => ({ ...row, deleted: !!row.deleted, messages: row.messages ?? null }));

/** One old version, whole. `null` when it is not kept (or is a deletion). */
export const readRevision = (userId, kind, id, rev) => {
  const handle = database();
  const row = handle.prepare(`
    SELECT rev, updated_at, deleted, payload FROM record_history
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
      FROM record_history
     WHERE user_id = ? AND kind = ?
     GROUP BY id
     ORDER BY lastAt DESC
     LIMIT ?
  `).all(userId, kind, Math.min(1000, Math.max(1, limit)));
