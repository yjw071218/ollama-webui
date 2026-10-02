// Runs one backup off the main thread.
//
// node:sqlite is synchronous: VACUUM INTO and integrity_check on the main
// thread froze every request for as long as they took. Here they run on a
// connection of their own -- WAL lets it read a consistent snapshot while the
// server keeps writing -- and the main thread only waits on a message.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const sqlPath = (file) => `'${String(file).replaceAll("'", "''")}'`;

const { source, target } = workerData;
try {
  const src = new DatabaseSync(source, { readOnly: true });
  try {
    src.exec('PRAGMA busy_timeout = 30000');
    src.exec(`VACUUM INTO ${sqlPath(target)}`);
  } finally { src.close(); }

  const copy = new DatabaseSync(target);
  let result;
  try {
    copy.exec('PRAGMA foreign_keys = ON');
    const integrity = copy.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity || 'no result'}`);
    const foreignKeys = copy.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error(`foreign_key_check: ${foreignKeys.length} violation(s)`);
    result = { integrity, foreignKeys: 0 };
  } finally { copy.close(); }
  parentPort.postMessage({ ok: true, ...result });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
