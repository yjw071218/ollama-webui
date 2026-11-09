// Real-data bench, step 1: a consistent copy of the server's data, read-only.
//
//   node scripts/bench/snapshot.mjs <outDir>
//
// Writes <outDir>/webui.db (SQLite VACUUM INTO from a read-only connection, so
// a running server is not disturbed), the storage key it needs, and a junction
// to the blob directory (read through, never written). Delete <outDir> when
// done: it holds the account's data and its key.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../server/data');
const out = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: snapshot.mjs <outDir>'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const target = path.join(out, 'webui.db');
if (fs.existsSync(target)) fs.rmSync(target);
const db = new DatabaseSync(path.join(DATA, 'webui.db'), { readOnly: true });
db.exec(`VACUUM INTO '${target.split('\\').join('/').replace(/'/g, "''")}'`);
db.close();
fs.copyFileSync(path.join(DATA, 'storage.key'), path.join(out, 'storage.key'));
const blobs = path.join(out, 'sync-blobs');
if (!fs.existsSync(blobs)) {
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', blobs, path.join(DATA, 'sync-blobs')], { stdio: 'ignore' });
  else fs.symlinkSync(path.join(DATA, 'sync-blobs'), blobs);
}
console.log(JSON.stringify({ out, dbMB: Math.round(fs.statSync(target).size / 1e6) }));
