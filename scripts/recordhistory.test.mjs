import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-history-'));
process.env.WEBUI_DATA_DIR = data;

const { closeDatabase, database } = await import('../server/db.js');
const { applyChanges } = await import('../server/records.js');
const { pruneRecordHistory, listRevisions, readRevision } = await import('../server/recordHistory.js');
const { removeOldBackups, startDatabaseBackupScheduler } = await import('../server/dbBackup.js');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const DAY = 24 * 60 * 60 * 1000;
const db = database();
db.exec(`
  INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u1', 'A', 'password', 1, 0);
  INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u2', 'B', 'password', 1, 0);
`);

try {
  const now = Date.UTC(2026, 8, 29, 3, 0, 0);
  // 200 days of edits, 10 per day, to one chat: 2000 writes, 1999 history rows.
  const edits = [];
  for (let d = 199; d >= 0; d--) {
    for (let k = 0; k < 10; k++) edits.push(now - d * DAY - (9 - k) * 60 * 1000);
  }
  for (const [i, at] of edits.entries()) {
    applyChanges('u1', { records: [{ kind: 'chat', id: 'c1', updatedAt: at, payload: { title: `v${i}`, messages: [i] } }] });
  }
  // A second account whose history must survive a pruning scoped to the first.
  for (let i = 0; i < 80; i++) {
    applyChanges('u2', { records: [{ kind: 'chat', id: 'c1', updatedAt: now + i * 1000, payload: { title: `w${i}` } }] });
  }
  const liveBefore = db.prepare("SELECT payload FROM records WHERE user_id='u1' AND id='c1'").get().payload;
  const total = db.prepare("SELECT COUNT(*) n FROM record_history WHERE user_id='u1'").get().n;
  // 1999 versions were replaced; the record is trimmed as it is written, so
  // what is held is near the policy (50 newest + a day each + the slack
  // between trims), not all of them.
  check('a busy record is trimmed while it is written', total >= 50 && total <= 170, String(total));
  check('new history rows say what they hold',
    db.prepare("SELECT COUNT(*) n FROM record_history WHERE packed <> 1").get().n === 0);
  const othersBefore = db.prepare("SELECT COUNT(*) n FROM record_history WHERE user_id='u2'").get().n;
  check('the trim is per record', othersBefore >= 50 && othersBefore < 79, String(othersBefore));

  const r = pruneRecordHistory({ keepRecent: 50, keepDays: 90, tzOffsetMs: 9 * 3600 * 1000, now, userId: 'u1' });
  const left = db.prepare("SELECT rev, updated_at FROM record_history WHERE user_id='u1' ORDER BY rev DESC").all();
  check('pruning reports what is left', r.rowsBefore === total && r.rowsAfter === left.length && r.removed === total - left.length);
  check('the newest 50 revisions are all kept',
    left.slice(0, 50).every((row, i) => i === 0 || left[i - 1].rev - row.rev === 1));
  const olderDays = new Set(left.slice(50).map(row => Math.floor((row.updated_at + 9 * 3600 * 1000) / DAY)));
  check('beyond those, one revision per day', olderDays.size === left.length - 50);
  check('nothing older than the day limit is kept', left.every(row => row.updated_at >= now - 90 * DAY));
  check('roughly 50 + 90 days remain', left.length >= 130 && left.length <= 145, String(left.length));
  check('the live record is untouched',
    db.prepare("SELECT payload FROM records WHERE user_id='u1' AND id='c1'").get().payload === liveBefore);
  check('another account is not touched by a scoped prune',
    db.prepare("SELECT COUNT(*) n FROM record_history WHERE user_id='u2'").get().n === othersBefore);

  const again = pruneRecordHistory({ keepRecent: 50, keepDays: 90, tzOffsetMs: 9 * 3600 * 1000, now, userId: 'u1' });
  check('pruning twice is a no-op', again.removed === 0);

  const revs = listRevisions('u1', 'chat', 'c1');
  check('the timeline lists revisions newest first with titles',
    revs.length === left.length && revs[0].rev > revs[1].rev && revs[0].title.startsWith('v'));
  const one = readRevision('u1', 'chat', 'c1', revs[3].rev);
  check('an old revision can be read back whole', one && one.payload.title === revs[3].title);
  check('another account cannot read it', readRevision('u2', 'chat', 'c1', revs[3].rev) === null);

  // Pictures are stored once, not once per revision, and come back exact.
  const picture = 'iVBORw0KGgo' + 'A'.repeat(200_000) + '==';
  for (let i = 0; i < 12; i++) {
    applyChanges('u1', { records: [{ kind: 'chat', id: 'img', updatedAt: now + i,
      payload: { title: `p${i}`, messages: [{ role: 'user', content: 'hi', images: [picture] }] } }] });
  }
  const hist = db.prepare("SELECT SUM(LENGTH(payload)) b, COUNT(*) n FROM record_history WHERE id='img'").get();
  check('history of a chat with a picture holds the picture once',
    hist.n === 11 && hist.b < 11 * 1000 &&
    db.prepare('SELECT COUNT(*) n FROM history_blobs').get().n === 1, JSON.stringify(hist));
  check('and those rows are marked as holding one',
    db.prepare("SELECT COUNT(*) n FROM record_history WHERE id='img' AND packed = 2").get().n === 11);
  const imgRevs = listRevisions('u1', 'chat', 'img');
  const back = readRevision('u1', 'chat', 'img', imgRevs[5].rev);
  check('an old revision with a picture reads back byte-for-byte',
    back.payload.messages[0].images[0] === picture && back.payload.title === imgRevs[5].title);

  // Rows written before packing existed are packed by maintenance.
  const legacy = JSON.stringify({ title: 'legacy', messages: [{ images: [picture + 'B'] }] });
  db.prepare(`INSERT INTO record_history (user_id, kind, id, rev, updated_at, deleted, payload)
              VALUES ('u1','chat','old',1,?,0,?), ('u1','chat','old',2,?,0,?)`).run(now, legacy, now + 1, legacy);
  const { packExistingHistory, collectBlobs } = await import('../server/recordHistory.js');
  // ...and a row from before the column that is already packed, and one with nothing to pack.
  db.prepare(`INSERT INTO record_history (user_id, kind, id, rev, updated_at, deleted, payload)
              SELECT user_id, kind, 'old', 3, updated_at, 0, payload FROM readable_record_history WHERE id='img' LIMIT 1`).run();
  db.prepare(`INSERT INTO record_history (user_id, kind, id, rev, updated_at, deleted, payload)
              VALUES ('u1','chat','old',4,?,0,?), ('u1','chat','old',5,?,1,NULL)`).run(now, '{"title":"small"}', now);
  check('existing rows are packed', packExistingHistory({ batch: 1 }) === 2);
  check('every row has been looked at, and marked by what it holds',
    db.prepare("SELECT group_concat(packed, '') s FROM (SELECT packed FROM record_history WHERE id='old' ORDER BY rev)").get().s === '22211');
  check('a second pass has nothing to do', packExistingHistory() === 0);
  // A byte budget ends a batch early without losing its place.
  db.prepare("UPDATE record_history SET packed = 0 WHERE id='old'").run();
  const { packHistoryStep } = await import('../server/recordHistory.js');
  const first = packHistoryStep({ batch: 50, maxBytes: 1 });
  check('a batch stops at its byte budget', first.done === false && first.after > 0);
  packExistingHistory();
  check('and the rest follows',
    db.prepare("SELECT COUNT(*) n FROM record_history WHERE packed = 0").get().n === 0);
  check('and still read back whole',
    readRevision('u1', 'chat', 'old', 2).payload.messages[0].images[0] === picture + 'B');
  db.prepare("DELETE FROM record_history WHERE id IN ('img','old')").run();
  check('unreferenced pictures are collected', collectBlobs() === 2
    && db.prepare('SELECT COUNT(*) n FROM history_blobs').get().n === 0);

  // The paced collector decides the same, and counts what is written while it scans.
  const { collectBlobsAsync } = await import('../server/recordHistory.js');
  const pic = (n) => 'iVBORw0KGgo' + String(n).repeat(40_000);
  const hold = (id, rev, image) => db.prepare(`INSERT INTO record_history (user_id, kind, id, rev, updated_at, deleted, payload)
    VALUES ('u1','chat',?,?,?,0,?)`).run(id, rev, now, JSON.stringify({ messages: [{ images: [image] }] }));
  hold('g1', 1, pic(1)); hold('g2', 1, pic(2)); hold('g3', 1, pic(3));
  packExistingHistory();
  db.prepare("DELETE FROM record_history WHERE id='g2'").run();
  let pauses = 0;
  const swept = await collectBlobsAsync({ slice: 1, pause: async () => {
    // After the scan has read g3: g3 goes, and a new revision takes its rowid.
    if (++pauses !== 2) return;
    db.prepare("DELETE FROM record_history WHERE id='g3'").run();
    hold('g4', 2, pic(4));
    packExistingHistory();
  } });
  check('the paced collector removes only what nothing refers to',
    swept === 1 && db.prepare('SELECT COUNT(*) n FROM history_blobs').get().n === 3, String(swept));
  check('a revision written during the scan keeps its picture',
    readRevision('u1', 'chat', 'g4', 2).payload.messages[0].images[0] === pic(4)
    && readRevision('u1', 'chat', 'g1', 1).payload.messages[0].images[0] === pic(1));
  check('what the scan counted for a row since deleted goes at the next sweep', collectBlobs() === 1);

  // Backups: newest N plus one per day.
  const dir = path.join(data, 'b');
  fs.mkdirSync(dir);
  const t0 = Date.now();
  const made = [];
  for (let d = 0; d < 10; d++) {
    for (let k = 0; k < 4; k++) {
      const at = t0 - d * DAY - k * 3600 * 1000;
      const file = path.join(dir, `webui-${new Date(at).toISOString().replace(/[:.]/g, '-')}.db`);
      fs.writeFileSync(file, 'x');
      fs.utimesSync(file, at / 1000, at / 1000);
      made.push(file);
    }
  }
  removeOldBackups(dir, 3, 7, t0);
  const kept = fs.readdirSync(dir);
  check('backup retention keeps the newest and one per day for a week',
    kept.length >= 8 && kept.length <= 10, String(kept.length));

  // A restart right after a backup must not take another one.
  let ran = 0;
  const stop = startDatabaseBackupScheduler({ directory: dir, intervalMs: 60 * 60 * 1000,
    log: { info: () => ran++, error: () => ran++ } });
  await new Promise(r => setTimeout(r, 300));
  stop();
  check('a restart does not back up when the last backup is recent', ran === 0);
} finally {
  closeDatabase();
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
