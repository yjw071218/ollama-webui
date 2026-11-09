// Real-data bench, step 2: one account's chats as the browser stores them.
//
//   WEBUI_DATA_DIR=<snapshotDir> node scripts/bench/export-chats.mjs <userId> <out.json>
//
// Decrypted through the server's own records code, sync-blob markers resolved
// from <snapshotDir>/sync-blobs. Reads only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [userId, outFile] = process.argv.slice(2);
if (!process.env.WEBUI_DATA_DIR || !userId || !outFile) { console.error('usage: WEBUI_DATA_DIR=<snap> export-chats.mjs <userId> <out.json>'); process.exit(2); }
const { changesSince } = await import(pathToFileURL(path.resolve(HERE, '../../server/records.js')).href);
const blobRoot = path.join(process.env.WEBUI_DATA_DIR, 'sync-blobs');
const PREFIX = 'webui-blob:v1:';
const owner = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
let resolved = 0, missing = 0;
const restore = (v) => {
  if (typeof v === 'string') {
    if (!v.startsWith(PREFIX)) return v;
    const hash = v.slice(PREFIX.length);
    const file = path.join(blobRoot, owner, hash.slice(0, 2), hash);
    if (fs.existsSync(file)) { resolved++; return fs.readFileSync(file, 'utf8'); }
    missing++; return v;
  }
  if (Array.isArray(v)) return v.map(restore);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = restore(x); return o; }
  return v;
};
const chats = [];
for (let since = 0; ;) {
  const page = changesSince(userId, since, 500, 64 * 1024 * 1024);
  for (const r of page.records) {
    if (r.kind !== 'chat' || r.deleted || r.payload == null) continue;
    chats.push(restore(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
  }
  if (page.complete) break;
  since = page.rev;
}
chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const json = JSON.stringify(chats);
fs.writeFileSync(outFile, json);
console.log(JSON.stringify({ chats: chats.length, mb: +(json.length / 1e6).toFixed(1), resolved, missing }));
