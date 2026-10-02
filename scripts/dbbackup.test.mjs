import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-db-backup-'));
process.env.WEBUI_DATA_DIR = data;

const { closeDatabase, database } = await import('../server/db.js');
const { backupDatabase } = await import('../server/dbBackup.js');
const { DatabaseSync } = await import('node:sqlite');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const db = database();
db.exec(`
  INSERT INTO users (id, name, provider, created_at, rev)
  VALUES ('backup-user', 'Backup user', 'password', 1, 0);
  INSERT INTO records (user_id, kind, id, rev, updated_at, deleted, payload)
  VALUES ('backup-user', 'chat', 'chat-1', 1, 1, 0, '{"id":"chat-1","title":"kept"}');
`);

try {
  const result = await backupDatabase({ retention: 2 });
  check('an online backup is created', fs.existsSync(result.file));
  check('the backup is non-empty', result.bytes > 0);
  check('the backup passes integrity verification',
    result.integrity === 'ok' && result.foreignKeys === 0);

  const copy = new DatabaseSync(result.file);
  check('the backup contains the committed record',
    copy.prepare('SELECT payload FROM records WHERE id = ?').get('chat-1')?.payload
      === '{"id":"chat-1","title":"kept"}');
  copy.close();
} finally {
  closeDatabase();
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
