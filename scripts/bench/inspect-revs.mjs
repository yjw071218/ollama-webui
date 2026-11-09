// Real-data bench: what changed on a SNAPSHOT server above a revision.
//   WEBUI_DATA_DIR=<snapshotDir> node scripts/bench/inspect-revs.mjs <userId> <sinceRev>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const live = path.resolve(HERE, '../../server/data');
if (!process.env.WEBUI_DATA_DIR || path.resolve(process.env.WEBUI_DATA_DIR).toLowerCase() === live.toLowerCase()) { console.error('snapshot only'); process.exit(2); }
const { database } = await import(pathToFileURL(path.resolve(HERE, '../../server/db.js')).href);
const [userId, since] = process.argv.slice(2);
const db = database();
const rows = db.prepare('SELECT kind, id, rev, updated_at, deleted, LENGTH(payload) AS bytes FROM records WHERE user_id = ? AND rev > ? ORDER BY rev').all(userId, Number(since));
const byKind = {};
for (const r of rows) { const k = `${r.kind}${r.deleted ? ' (deleted)' : ''}`; byKind[k] = (byKind[k] || 0) + 1; }
console.log(JSON.stringify({ changed: rows.length, byKind }));
console.log(JSON.stringify(rows.slice(0, 8)));
const live2 = db.prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND kind = 'chat' AND deleted = 0").get(userId);
console.log('live chats now', live2.n);
