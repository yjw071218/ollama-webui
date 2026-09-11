// Syncing, one record at a time.
//
// The version this replaces sent the account's entire state as a single blob
// and stored it by overwriting. That is last-writer-wins over *everything*, and
// with two devices it loses data in three distinct ways:
//
//   * The laptop uploads its blob. A chat the phone wrote thirty seconds ago is
//     not in it, so the account no longer has that chat.
//   * The phone deletes a chat. The laptop's next upload, made from a copy that
//     still has it, brings it back. A blob cannot say "this one is gone"; it can
//     only fail to mention it, which is indistinguishable from not knowing.
//   * Every change ships the whole history. On a phone that is the difference
//     between a sync and a download.
//
// Rows fix all three. Each chat, setting, document and memory is its own record
// with its own timestamp, and a deletion is a tombstone — a real write that
// travels like any other. Conflicts resolve per record by `updatedAt`, so two
// devices editing different chats never touch each other, and two devices
// editing the *same* chat keep the later edit rather than whichever device
// happened to reconnect second.
//
// Devices pull by revision: "give me everything above rev N". The account's
// revision counter advances on every write, so a device that has been offline
// for a week downloads exactly what changed and nothing else.

import { database, transaction } from './db.js';

/** The kinds a client may sync. Anything else is refused rather than stored. */
export const KINDS = new Set([
  'chat', 'setting', 'folders', 'presets', 'personas', 'document', 'memory',
  // Who is asking: the other half of the persona pair, and the same shape as
  // the lists beside it — one small record, read and written whole.
  'profile',
]);

// One payload should not be able to fill the disk. Generous enough for a chat
// carrying base64 images, small enough to bound the damage.
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_RECORDS = 2000;

/** Raised when a client sends a batch that names the wrong account. */
export class OwnerMismatch extends Error {
  constructor(expected, claimed) {
    super('That data belongs to a different account.');
    this.name = 'OwnerMismatch';
    this.expected = expected;
    this.claimed = claimed || null;
  }
}

const toRecord = (row) => ({
  kind: row.kind,
  id: row.id,
  rev: row.rev,
  updatedAt: row.updated_at,
  deleted: !!row.deleted,
  // A tombstone carries no payload; sending `null` rather than omitting the
  // field is what tells the client to delete rather than to ignore.
  payload: row.deleted ? null : JSON.parse(row.payload),
});

/** The account's current revision, which is what a client syncs against. */
export const currentRev = (userId) =>
  database().prepare('SELECT rev FROM users WHERE id = ?').get(userId)?.rev ?? 0;

/**
 * Everything that changed above `since`.
 *
 * `since = 0` is a full download — a new device, or one whose local copy was
 * cleared. Anything else is a delta, which is the normal case and the reason a
 * phone can stay in step over a slow connection.
 *
 * The result is capped, and `complete` says whether it is the whole answer. A
 * client that gets `complete: false` syncs again from the revision it reached,
 * so a first sync of a large account arrives in pages rather than in one
 * request that times out.
 */
export const changesSince = (userId, since = 0, limit = 500) => {
  const rows = database().prepare(`
    SELECT kind, id, rev, updated_at, deleted, payload
      FROM records
     WHERE user_id = ? AND rev > ?
     ORDER BY rev ASC
     LIMIT ?
  `).all(userId, since, limit + 1);

  const complete = rows.length <= limit;
  const page = complete ? rows : rows.slice(0, limit);

  return {
    records: page.map(toRecord),
    // The revision actually reached. Not the account's current one: a client
    // that recorded the latter after a partial page would skip everything it
    // had not been sent.
    rev: complete ? currentRev(userId) : page[page.length - 1].rev,
    complete,
  };
};

const validate = (record) => {
  if (!record || typeof record !== 'object') throw new Error('That is not a record.');
  if (!KINDS.has(record.kind)) throw new Error(`Unknown record kind: ${record.kind}`);
  if (record.id == null || String(record.id) === '') throw new Error('A record needs an id.');
  if (!Number.isFinite(record.updatedAt)) throw new Error('A record needs a timestamp.');

  const payload = record.deleted ? null : JSON.stringify(record.payload ?? null);
  if (payload && Buffer.byteLength(payload) > MAX_RECORD_BYTES) {
    throw new Error(`One record is larger than the ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} MB limit.`);
  }
  return { kind: record.kind, id: String(record.id), updatedAt: record.updatedAt, deleted: !!record.deleted, payload };
};

/**
 * Apply a batch of changes from one device, then report what it has not seen.
 *
 * Both halves happen in one transaction, so the revision the client is told to
 * remember is exactly the one its own writes landed at. Splitting them is how a
 * client ends up recording a revision that skips a record written between the
 * two statements — and a skipped record never syncs again.
 *
 * `ownerId` is the account the *client* believes it is. It is checked against
 * the session rather than trusted, because a client that has got confused about
 * who is signed in will otherwise file one person's chats under another's.
 */
export const applyChanges = (userId, { since = 0, records = [], ownerId = null, limit = 500 } = {}) => {
  if (ownerId && ownerId !== userId) throw new OwnerMismatch(userId, ownerId);
  if (!Array.isArray(records)) throw new Error('Changes must be a list.');
  if (records.length > MAX_BATCH_RECORDS) {
    throw new Error(`Send at most ${MAX_BATCH_RECORDS} records at a time.`);
  }

  const clean = records.map(validate);

  return transaction((handle) => {
    let applied = 0;
    let rejected = 0;

    if (clean.length) {
      const existing = handle.prepare(
        'SELECT updated_at, deleted FROM records WHERE user_id = ? AND kind = ? AND id = ?'
      );
      const upsert = handle.prepare(`
        INSERT INTO records (user_id, kind, id, rev, updated_at, deleted, payload)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (user_id, kind, id) DO UPDATE SET
          rev = excluded.rev,
          updated_at = excluded.updated_at,
          deleted = excluded.deleted,
          payload = excluded.payload
      `);

      // Every record gets its own revision, not one for the batch.
      //
      // A shared revision cannot be paged. A client that receives half a batch
      // records the revision it reached, asks for everything above it next
      // time, and never sees the other half — those rows carry the same number
      // and are excluded by the same `rev > since`. Distinct revisions make the
      // counter a real cursor.
      let rev = handle.prepare('SELECT rev FROM users WHERE id = ?').get(userId)?.rev ?? 0;

      for (const record of clean) {
        const current = existing.get(userId, record.kind, record.id);

        // Last write wins, by the record's own clock. An older edit arriving
        // late — a phone that was offline, a tab that was asleep — must not
        // overwrite a newer one; it is simply not applied, and the newer record
        // travels back to that device in the same response.
        if (current && current.updated_at > record.updatedAt) { rejected++; continue; }

        // A tie is resolved in favour of the deletion. The alternative is a
        // record that one device keeps resurrecting and another keeps deleting,
        // forever.
        if (current && current.updated_at === record.updatedAt && current.deleted && !record.deleted) {
          rejected++;
          continue;
        }

        // A tie that is not a deletion is a record the account already has, at
        // the timestamp it already has it at. Writing it again would give it a
        // new revision, and a new revision is a message to every other device
        // saying "come and fetch this" -- about something none of them is
        // missing. It is not rare, either: a device that loses its note of what
        // it has uploaded re-sends its whole store, and that would wake the
        // account's other devices once per record for no change at all.
        if (current && current.updated_at === record.updatedAt
            && !!current.deleted === !!record.deleted) {
          continue;
        }

        rev++;
        upsert.run(
          userId, record.kind, record.id, rev,
          record.updatedAt, record.deleted ? 1 : 0, record.payload,
        );
        applied++;
      }

      // Only what was actually used. A batch that changed nothing must not move
      // the counter, or every other device is told to re-sync for nothing.
      if (applied > 0) {
        handle.prepare('UPDATE users SET rev = ? WHERE id = ?').run(rev, userId);
      }
    }

    // What this device has not seen. Records it just sent come back too, at
    // their stored revision — which is how it learns that one of its own writes
    // was rejected in favour of a newer one.
    const rows = handle.prepare(`
      SELECT kind, id, rev, updated_at, deleted, payload
        FROM records
       WHERE user_id = ? AND rev > ?
       ORDER BY rev ASC
       LIMIT ?
    `).all(userId, since, limit + 1);

    const complete = rows.length <= limit;
    const page = complete ? rows : rows.slice(0, limit);
    const rev = handle.prepare('SELECT rev FROM users WHERE id = ?').get(userId)?.rev ?? 0;

    return {
      applied,
      rejected,
      records: page.map(toRecord),
      rev: complete ? rev : page[page.length - 1].rev,
      complete,
    };
  });
};

/** What the account holds, for the settings screen. */
export const accountStats = (userId) => {
  const rows = database().prepare(`
    SELECT kind, COUNT(*) AS n, SUM(LENGTH(COALESCE(payload, ''))) AS bytes
      FROM records
     WHERE user_id = ? AND deleted = 0
     GROUP BY kind
  `).all(userId);

  const counts = {};
  let bytes = 0;
  for (const row of rows) { counts[row.kind] = row.n; bytes += row.bytes || 0; }

  const last = database().prepare(
    'SELECT MAX(updated_at) AS at FROM records WHERE user_id = ?'
  ).get(userId);

  return {
    ownerId: userId,
    rev: currentRev(userId),
    counts,
    chats: counts.chat || 0,
    bytes,
    savedAt: last?.at || null,
    exists: Object.keys(counts).length > 0,
  };
};

/**
 * Remove tombstones that every device has certainly seen.
 *
 * Kept for a long while on purpose: a device that syncs after the tombstone is
 * gone has no way to learn the record was deleted, and will upload its copy
 * back. Thirty days is longer than any plausible gap between opening the app on
 * a second device.
 */
export const sweepTombstones = (userId, olderThanMs = 30 * 24 * 60 * 60 * 1000) =>
  database().prepare(
    'DELETE FROM records WHERE user_id = ? AND deleted = 1 AND updated_at < ?'
  ).run(userId, Date.now() - olderThanMs).changes;

/** Drop everything an account holds. Used when the account is deleted. */
export const dropRecords = (userId) =>
  database().prepare('DELETE FROM records WHERE user_id = ?').run(userId).changes;
