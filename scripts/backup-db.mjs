// Online backup of webui.db (safe while the server runs), then verifies it.
//   node scripts/backup-db.mjs [label]
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const label = process.argv[2] || 'backup';
const dataDir = fileURLToPath(new URL('../server/data/', import.meta.url));
const target = `${dataDir}webui.${label}-${Date.now()}.db`;

const sql = new DatabaseSync(`${dataDir}webui.db`);
sql.exec('PRAGMA busy_timeout = 10000');
sql.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
sql.close();

const copy = new DatabaseSync(target, { readOnly: true });
const check = copy.prepare('PRAGMA integrity_check').get();
const assets = copy.prepare('SELECT COUNT(*) AS n FROM risu_assets').get().n;
const records = copy.prepare('SELECT COUNT(*) AS n FROM records').get().n;
copy.close();
console.log(JSON.stringify({ target, integrity: Object.values(check)[0], assets, records }));
