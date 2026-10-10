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
import { packPayload, unpackPayload } from './recordHistory.js';
import { mergeChats } from './chatMerge.js';

/** The kinds a client may sync. Anything else is refused rather than stored. */
export const KINDS = new Set([
  'chat', 'setting', 'folders', 'presets', 'personas', 'document', 'memory',
  // Who is asking: the other half of the persona pair, and the same shape as
  // the lists beside it — one small record, read and written whole.
  'profile',
  /* What the Studio was last set to, and what it has made. These are in the
     browser's own list of whole-list records (`WHOLE_LISTS` in
     src/syncEngine.js) and were never added here — and the cost of that was
     not "the Studio does not sync". `validate` threw on the first one and took
     the entire upload with it, so a device that had ever opened the Studio
     stopped syncing anything at all: chats, settings, documents, everything.
     Which is why one bad record no longer fails a batch; see `applyChanges`. */
  'studio',
  /* One record per finished job rather than one for the gallery.
     *
     * It was the gallery, once, and a whole-list record cannot hold what two
     * devices both made: the row is overwritten by whoever uploads last, so a
     * phone that had been used for five minutes took a desktop's afternoon of
     * pictures off the account. Merging on the way *down* does not help, since
     * by then the upload has already replaced the row. One record per job is
     * the shape the data always had. `studioJobs` stays here only so that rows
     * written by the old clients are still readable. */
  'studioJob', 'studioJobs',
  // Prompt blocks kept by name; see src/studioPresets.js.
  'studioPrompts',
  'characters',
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

/* A page is capped by size as well as by count. Five hundred records of chats
   carrying pictures is tens of megabytes, and on a phone that one response is
   a long silence -- the first-sync bar sat at 0% for its whole download and
   then jumped. Smaller pages keep the bar moving and a dropped connection
   costs one page rather than the lot. At least one record always goes, so a
   single large record still makes progress. */
export const PAGE_BYTES = 2 * 1024 * 1024;

const pageOf = (rows, limit, maxBytes = PAGE_BYTES) => {
  let bytes = 0;
  let end = 0;
  for (; end < rows.length && end < limit; end++) {
    bytes += rows[end].payload ? rows[end].payload.length : 0;
    if (end > 0 && bytes > maxBytes) break;
  }
  return { page: rows.slice(0, end), complete: end === rows.length };
};

/* How many records are still above the cursor -- what lets a client show
   "120 of 1,350" instead of guessing from revision numbers, which are spread
   unevenly (a chat edited a hundred times holds one record at its latest
   revision) and made the bar leap from 0% to 87%. */
const remainingAbove = (handle, userId, cursor) =>
  handle.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND rev > ?').get(userId, cursor)?.n ?? 0;

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
export const changesSince = (userId, since = 0, limit = 500, maxBytes = PAGE_BYTES) => {
  const rows = database().prepare(`
    SELECT kind, id, rev, updated_at, deleted, payload
      FROM records
     WHERE user_id = ? AND rev > ?
     ORDER BY rev ASC
     LIMIT ?
  `).all(userId, since, limit + 1);

  const { page, complete } = pageOf(rows, limit, maxBytes);
  // The revision actually reached. Not the account's current one: a client
  // that recorded the latter after a partial page would skip everything it
  // had not been sent.
  const rev = complete ? currentRev(userId) : page[page.length - 1].rev;

  return {
    records: page.map(toRecord),
    rev,
    complete,
    remaining: complete ? 0 : remainingAbove(database(), userId, rev),
  };
};

const validate = (record) => {
  if (!record || typeof record !== 'object') throw new Error('That is not a record.');
  if (!KINDS.has(record.kind)) throw new Error(`Unknown record kind: ${record.kind}`);
  if (record.id == null || String(record.id) === '') throw new Error('A record needs an id.');
  if (!Number.isFinite(record.updatedAt)) throw new Error('A record needs a timestamp.');
  if (!record.deleted && (record.payload === null || record.payload === undefined)) {
    throw new Error('A live record needs a payload.');
  }

  const payload = record.deleted ? null : JSON.stringify(record.payload);
  if (!record.deleted && (payload === undefined || payload === 'null')) {
    throw new Error('A live record needs a serializable payload.');
  }
  if (payload && Buffer.byteLength(payload) > MAX_RECORD_BYTES) {
    throw new Error(`One record is larger than the ${Math.round(MAX_RECORD_BYTES / 1024 / 1024)} MB limit.`);
  }
  // The stamp of the copy this edit was made on, when the device says (see server/chatMerge.js).
  const base = Number.isFinite(record.base) && record.base >= 0 ? record.base : null;
  return { kind: record.kind, id: String(record.id), updatedAt: record.updatedAt, deleted: !!record.deleted, payload, base };
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
export const applyChanges = (userId, { since = 0, records = [], ownerId = null, limit = 500, maxBytes = PAGE_BYTES } = {}) => {
  if (ownerId && ownerId !== userId) throw new OwnerMismatch(userId, ownerId);
  if (!Array.isArray(records)) throw new Error('Changes must be a list.');
  if (records.length > MAX_BATCH_RECORDS) {
    throw new Error(`Send at most ${MAX_BATCH_RECORDS} records at a time.`);
  }

  /* Validated one at a time, and a record that cannot be stored is refused
     rather than throwing.
     *
     * This used to be `records.map(validate)`, outside the transaction, so a
     * single unacceptable record failed the whole request -- and the device
     * sending it then had no way to make progress on anything else. One kind
     * the server did not know about was enough to stop an account syncing for
     * a day, and so is one chat that has grown past the size limit by
     * carrying a picture. Neither is a reason to reject the other 499 records
     * in the batch. What was refused travels back, so it can be said out loud
     * rather than looking like silence. */
  const clean = [];
  const refused = [];
  for (const record of records) {
    try {
      clean.push(validate(record));
    } catch (e) {
      refused.push({
        kind: String(record?.kind ?? ''),
        id: String(record?.id ?? ''),
        reason: e.message,
      });
    }
  }

  return transaction((handle) => {
    let applied = 0;
    let rejected = 0;
    // Records this device sent that lost to a newer copy.
    const lost = [];

    if (clean.length) {
      const existing = handle.prepare(
        'SELECT rev, updated_at, deleted, payload FROM records WHERE user_id = ? AND kind = ? AND id = ?'
      );
      const baseOf = handle.prepare(`
        SELECT payload FROM record_history
         WHERE user_id = ? AND kind = ? AND id = ? AND updated_at = ? AND deleted = 0
         ORDER BY rev DESC LIMIT 1
      `);
      const history = handle.prepare(`
        INSERT OR IGNORE INTO record_history
          (user_id, kind, id, rev, updated_at, deleted, payload)
        VALUES (?,?,?,?,?,?,?)
      `);
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

      for (let record of clean) {
        const current = existing.get(userId, record.kind, record.id);

        /* Two devices, one chat: this edit was made on a copy older than the
           one the account now holds -- another device wrote in between. The
           later write winning whole is how an answer finished on one device
           disappeared when the other, not yet in step, touched the same chat.
           Merged instead (server/chatMerge.js); the result goes back to the
           device that sent this, like any record that lost. */
        if (record.kind === 'chat' && !record.deleted && record.base !== null && current && !current.deleted
            && current.updated_at > record.base && current.updated_at !== record.updatedAt) {
          /* The copy this device started from, for a three-way merge: what it
             removed on purpose stays removed. Missing (pruned history) is a
             two-way merge, which only ever keeps too much. */
          let basePayload = null;
          try {
            const row = baseOf.get(userId, record.kind, record.id, record.base);
            if (row?.payload) basePayload = JSON.parse(unpackPayload(handle, row.payload));
          } catch { basePayload = null; }
          let merged = null;
          try { merged = mergeChats(JSON.parse(current.payload), JSON.parse(record.payload), basePayload); } catch { merged = undefined; }
          if (merged === null) { rejected++; lost.push(record); continue; }
          if (merged !== undefined) {
            const updatedAt = Math.max(current.updated_at, record.updatedAt) + 1;
            record = { ...record, updatedAt, payload: JSON.stringify({ ...merged, updatedAt }) };
            lost.push(record);
          }
        }

        // Last write wins, by the record's own clock. An older edit arriving
        // late — a phone that was offline, a tab that was asleep — must not
        // overwrite a newer one; it is simply not applied, and the newer record
        // travels back to that device in the same response.
        if (current && current.updated_at > record.updatedAt) { rejected++; lost.push(record); continue; }

        // A tie is resolved in favour of the deletion. The alternative is a
        // record that one device keeps resurrecting and another keeps deleting,
        // forever.
        if (current && current.updated_at === record.updatedAt && current.deleted && !record.deleted) {
          rejected++;
          lost.push(record);
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
        if (current) {
          // Pictures inside the payload go to history_blobs once rather than
          // once per edit; see server/recordHistory.js.
          history.run(
            userId, record.kind, record.id, current.rev,
            current.updated_at, current.deleted, packPayload(handle, current.payload),
          );
        }
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

    const { page, complete } = pageOf(rows, limit, maxBytes);
    const rev = handle.prepare('SELECT rev FROM users WHERE id = ?').get(userId)?.rev ?? 0;
    // Fixed before anything is appended below: the cursor is the page's.
    const cursor = complete ? rev : page[page.length - 1].rev;
    const remaining = complete ? 0 : remainingAbove(handle, userId, cursor);

    /* The winning copy of every rejected record, even when its revision is at
       or below `since`. The comment above used to promise this, but the
       `rev > since` query only delivered it when the winner was news to this
       device -- and it usually is not: the device had already seen it, then
       edited with a clock a few seconds behind. Its edit was dropped, it was
       never told, it marked the edit as sent, and the two devices stayed apart
       until someone pressed sync by hand. Sending the winner back lets the
       device take it (it is newer by the device's own rule), so both converge. */
    if (lost.length) {
      const inPage = new Set(page.map(r => `${r.kind}:${r.id}`));
      const winner = handle.prepare(
        'SELECT kind, id, rev, updated_at, deleted, payload FROM records WHERE user_id = ? AND kind = ? AND id = ?'
      );
      for (const record of lost) {
        const key = `${record.kind}:${record.id}`;
        if (inPage.has(key)) continue;
        inPage.add(key);
        const row = winner.get(userId, record.kind, record.id);
        if (row) page.push(row);
      }
    }

    return {
      applied,
      rejected,
      /* What could not be stored, and why. A handful at most: the point is to
         name the problem, and a device sending five hundred unacceptable
         records has one problem rather than five hundred. */
      ...(refused.length ? { refused: refused.slice(0, 20), refusedCount: refused.length } : {}),
      records: page.map(toRecord),
      rev: cursor,
      complete,
      remaining,
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
