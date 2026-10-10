// Two devices, one account: the concurrency guarantees, end to end.
//
// What TOPCIT asks of concurrent transactions, and where each is enforced:
//
//   * No lost update. Two devices that change *different* fields of one chat at
//     the same time both keep their change (per-field last-writer-wins
//     registers: src/sessionEdit.js `withFieldStamps`, server/chatMerge.js).
//   * Optimistic concurrency control. A device says which version its edit was
//     made on (`base`); the server validates it against the current version and
//     merges instead of overwriting when another write came in between
//     (server/records.js `applyChanges`).
//   * Timestamp ordering that respects causality. Stamps come from a logical
//     clock (src/logicalClock.js): an edit made after seeing another device's
//     edit is stamped after it, even when this device's wall clock is behind.
//   * Atomicity. Each batch is applied in one SQLite transaction together with
//     the read of what the device has not seen.
//   * Convergence. Whatever order uploads arrive in, every device ends up with
//     the same copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-concurrency-'));
process.env.WEBUI_DATA_DIR = data;

const { closeDatabase, database } = await import('../server/db.js');
const { applyChanges } = await import('../server/records.js');
const { mergeChats, mergeFields, foldNewerFields } = await import('../server/chatMerge.js');
const { nextStamp, observeStamp, resetClock } = await import('../src/logicalClock.js');
const { stamped } = await import('../src/sessionEdit.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

database().exec(`INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u1', 'A', 'password', 1, 0);`);
const held = (id) => {
  const row = database().prepare("SELECT updated_at, payload FROM records WHERE user_id='u1' AND kind='chat' AND id=?").get(id);
  return row ? { ...JSON.parse(row.payload), updatedAt: row.updated_at } : null;
};
const up = (record) => applyChanges('u1', { records: [record] });

try {
  /* ------------------------------------------------ 1. the logical clock */
  resetClock();
  const wall = 1_000_000;
  observeStamp(wall + 5000); // a stamp from a phone 5 s ahead
  const t = nextStamp(0, wall);
  check('an edit after seeing a later stamp is stamped after it, whatever the wall clock says', t > wall + 5000, String(t));
  check('and the clock never goes backwards', nextStamp(0, wall) > t);
  observeStamp(Date.now() + 10 * 24 * 3600 * 1000);
  check('a stamp from a clock days ahead is not adopted', nextStamp(0, Date.now()) < Date.now() + 60_000);

  /* ------------------------------------ 2. field stamps from a local edit */
  resetClock();
  const c0 = { id: 'c', title: 'Chat', pinned: false, updatedAt: 100, messages: [] };
  const pinned = stamped(c0, { ...c0, pinned: true }, 200);
  check('pinning stamps that field', pinned._fieldAt?.pinned === pinned.updatedAt);
  check('and only that field', !('title' in (pinned._fieldAt || {})));
  const streamed = stamped(c0, { ...c0, messages: [{ role: 'assistant', content: 'hi', at: 150 }] }, 210);
  check('a streamed reply stamps no field (messages merge on their own)', !streamed._fieldAt);

  /* ------------- 3. the reported bug: a pin undone by a reply on the other device */
  resetClock();
  const base = { title: 'Chat', pinned: false, messages: [{ role: 'user', content: 'q', at: 1000 }] };
  up({ kind: 'chat', id: 'p1', updatedAt: 1000, payload: { ...base, updatedAt: 1000 } });
  // PC pins it.
  const pcCopy = stamped({ ...base, updatedAt: 1000 }, { ...base, updatedAt: 1000, pinned: true }, 2000);
  up({ kind: 'chat', id: 'p1', updatedAt: pcCopy.updatedAt, base: 1000, payload: pcCopy });
  // The phone, not yet in step, streams an answer into its old copy -- with a
  // clock that runs AHEAD of the PC's, so as a whole it is "newer".
  const phoneCopy = { ...base, updatedAt: 9000, messages: [...base.messages, { role: 'assistant', content: 'answer', at: 8500 }] };
  up({ kind: 'chat', id: 'p1', updatedAt: 9000, base: 1000, payload: phoneCopy });
  let now = held('p1');
  check('the pin made on the PC survives the phone\'s upload', now.pinned === true, JSON.stringify(now));
  check('and so does the answer written on the phone', now.messages?.some(m => m.content === 'answer'));

  /* -------------------- 4. concurrent edits to different fields both stand */
  up({ kind: 'chat', id: 'r1', updatedAt: 1000, payload: { title: 'Old', pinned: false, folderId: null, messages: [] } });
  const pc = { title: 'Old', pinned: true, folderId: null, messages: [], updatedAt: 2000, _fieldAt: { pinned: 2000 } };
  const phone = { title: 'New name', pinned: false, folderId: null, messages: [], updatedAt: 2100, _fieldAt: { title: 2100 } };
  // Upload order should not matter: try the phone first.
  up({ kind: 'chat', id: 'r1', updatedAt: 2100, base: 1000, payload: phone });
  up({ kind: 'chat', id: 'r1', updatedAt: 2000, base: 1000, payload: pc });
  now = held('r1');
  check('a rename on one device and a pin on the other both survive', now.title === 'New name' && now.pinned === true, JSON.stringify(now));

  /* --------------------- 5. the same field: the later stamp wins, either order */
  const a = { title: 'A', messages: [], _fieldAt: { title: 3000 } };
  const b = { title: 'B', messages: [], _fieldAt: { title: 3500 } };
  check('same field, later stamp wins (a then b)', mergeFields(a, b).title === 'B');
  check('same field, later stamp wins (b then a)', mergeFields(b, a).title === 'B');

  /* ----------- 6. a stale whole-chat upload still carries its newer field */
  up({ kind: 'chat', id: 's1', updatedAt: 5000, payload: { title: 'T', pinned: false, messages: [], _fieldAt: { title: 4000 } } });
  // No base (an older client): the whole copy is older and would be rejected.
  up({ kind: 'chat', id: 's1', updatedAt: 4500, payload: { title: 'T', pinned: true, messages: [], _fieldAt: { pinned: 4500 } } });
  now = held('s1');
  check('a stale upload is refused as a whole but its newer field is kept', now.pinned === true && now.updatedAt > 5000, JSON.stringify(now));

  /* ------------------------------- 7. deletions are not resurrected */
  const withBase = { messages: [{ role: 'user', content: 'x', at: 1 }, { role: 'assistant', content: 'y', at: 2 }] };
  const deletedHere = { messages: [{ role: 'user', content: 'x', at: 1 }] };
  const merged = mergeChats(withBase, deletedHere, withBase);
  check('a message deleted on one device stays deleted after a merge', merged.messages.length === 1);

  /* ------------------------------- 8. folding on the receiving device */
  const local = { title: 'T', pinned: true, updatedAt: 10, _fieldAt: { pinned: 10 } };
  const incoming = { title: 'Renamed', pinned: false, updatedAt: 20, _fieldAt: { title: 20 } };
  const result = foldNewerFields(incoming, local);
  check('a pull keeps a local pin made later than the pulled copy\'s pin', result.pinned === true && result.title === 'Renamed');
  check('folding nothing returns the very same object', foldNewerFields(incoming, { _fieldAt: { title: 1 } }) === incoming);

  /* ------------------------------- 9. convergence under every order */
  const v1 = { title: 'x', pinned: true, archived: false, messages: [], _fieldAt: { pinned: 50 } };
  const v2 = { title: 'y', pinned: false, archived: true, messages: [], _fieldAt: { title: 60, archived: 61 } };
  const m12 = mergeFields(v1, v2), m21 = mergeFields(v2, v1);
  const strip = (o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
  check('merging in either order gives the same chat', strip(m12) === strip(m21), `${strip(m12)} vs ${strip(m21)}`);
} finally {
  closeDatabase?.();
  try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
