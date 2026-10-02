// Compacts webui.db in place (safe while the server runs; writes wait briefly).
//   node scripts/vacuum-db.mjs
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../server/data/webui.db', import.meta.url));
const mb = () => (statSync(file).size / 1048576).toFixed(1);
const before = mb();
const sql = new DatabaseSync(file);
sql.exec('PRAGMA busy_timeout = 30000');
const t = Date.now();
sql.exec('VACUUM');
sql.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const integrity = Object.values(sql.prepare('PRAGMA integrity_check').get())[0];
const assets = sql.prepare('SELECT COUNT(*) AS n FROM risu_assets').get().n;
const records = sql.prepare('SELECT COUNT(*) AS n FROM records').get().n;
sql.close();
console.log(JSON.stringify({ beforeMB: before, afterMB: mb(), seconds: (Date.now() - t) / 1000, integrity, assets, records }));
