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
  check('history recorded every replaced version', total === edits.length - 1, String(total));

  const r = pruneRecordHistory({ keepRecent: 50, keepDays: 90, tzOffsetMs: 9 * 3600 * 1000, now, userId: 'u1' });
  const left = db.prepare("SELECT rev, updated_at FROM record_history WHERE user_id='u1' ORDER BY rev DESC").all();
  check('pruning removed rows', r.removed > 0 && r.rowsAfter === left.length);
  check('the newest 50 revisions are all kept',
    left.slice(0, 50).every((row, i) => i === 0 || left[i - 1].rev - row.rev === 1));
  const olderDays = new Set(left.slice(50).map(row => Math.floor((row.updated_at + 9 * 3600 * 1000) / DAY)));
  check('beyond those, one revision per day', olderDays.size === left.length - 50);
  check('nothing older than the day limit is kept', left.every(row => row.updated_at >= now - 90 * DAY));
  check('roughly 50 + 90 days remain', left.length >= 130 && left.length <= 145, String(left.length));
  check('the live record is untouched',
    db.prepare("SELECT payload FROM records WHERE user_id='u1' AND id='c1'").get().payload === liveBefore);
  check('another account is not touched by a scoped prune',
    db.prepare("SELECT COUNT(*) n FROM record_history WHERE user_id='u2'").get().n === 79);

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
  const imgRevs = listRevisions('u1', 'chat', 'img');
  const back = readRevision('u1', 'chat', 'img', imgRevs[5].rev);
  check('an old revision with a picture reads back byte-for-byte',
    back.payload.messages[0].images[0] === picture && back.payload.title === imgRevs[5].title);

  // Rows written before packing existed are packed by maintenance.
  const legacy = JSON.stringify({ title: 'legacy', messages: [{ images: [picture + 'B'] }] });
  db.prepare(`INSERT INTO record_history (user_id, kind, id, rev, updated_at, deleted, payload)
              VALUES ('u1','chat','old',1,?,0,?), ('u1','chat','old',2,?,0,?)`).run(now, legacy, now + 1, legacy);
  const { packExistingHistory, collectBlobs } = await import('../server/recordHistory.js');
  check('existing rows are packed', packExistingHistory({ batch: 1 }) === 2);
  check('and still read back whole',
    readRevision('u1', 'chat', 'old', 2).payload.messages[0].images[0] === picture + 'B');
  db.prepare("DELETE FROM record_history WHERE id IN ('img','old')").run();
  check('unreferenced pictures are collected', collectBlobs() === 2
    && db.prepare('SELECT COUNT(*) n FROM history_blobs').get().n === 0);

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
