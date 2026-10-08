import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';

/* src/syncBlobs.js against an in-memory blob server, with session.jsx stubbed. */
const bundle = await rolldown({
  input: path.resolve('src/syncBlobs.js'),
  plugins: [{ name: 'stub', resolveId(id) { if (id.endsWith('session.jsx')) return '\0session'; },
    load(id) { if (id === '\0session') return 'export const authHeaders = () => ({});'; } }],
});
const { output } = await bundle.generate({ format: 'esm' });
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'blobs-')), 'syncBlobs.mjs');
fs.writeFileSync(file, output[0].code);
const { slimPayload, restorePayload, BLOB_PREFIX } = await import(pathToFileURL(file));

const store = new Map();
let puts = 0;
globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
  const hash = new URL(url, 'http://x').searchParams.get('hash');
  if (method === 'HEAD') return { ok: store.has(hash) };
  if (method === 'PUT') { puts++; store.set(hash, new TextDecoder().decode(body)); return { ok: true }; }
  return store.has(hash) ? { ok: true, text: async () => store.get(hash) } : { ok: false };
};

const image = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024);
const chat = { id: 1, title: '사진', messages: [{ role: 'user', content: 'hi', images: [image.split(',')[1]], attachments: [{ name: 'a.png', preview: image }] }] };
const slim = await slimPayload(chat);
const size = JSON.stringify(slim).length;
assert.ok(size < 2000, `slimmed payload is small (${size})`);
assert.ok(slim.messages[0].images[0].startsWith(BLOB_PREFIX));
assert.equal(slim.messages[0].content, 'hi');
assert.equal(chat.messages[0].images[0].length, image.length - 'data:image/png;base64,'.length, 'local copy untouched');
assert.equal(puts, 2);
await slimPayload(chat);
assert.equal(puts, 2, 'already stored blobs are not uploaded again');
assert.deepEqual(await restorePayload(slim), chat);
// A blob that cannot be fetched stays a marker instead of losing the record.
const missing = await restorePayload({ x: BLOB_PREFIX + 'f'.repeat(64) });
assert.equal(missing.x, BLOB_PREFIX + 'f'.repeat(64));
console.log('PASS large attachments sync by reference and restore exactly');
