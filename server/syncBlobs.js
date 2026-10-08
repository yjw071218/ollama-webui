/**
 * Large values cut out of synced records.
 *
 * A chat with an attached photo or document is one record, and a record is
 * limited to 8 MB. Instead of refusing the chat, the client uploads each large
 * string (a data URL, base64 bytes, an extracted document) here once, by its
 * SHA-256, and the record carries `webui-blob:v1:<hash>` in its place. Other
 * devices fetch the string back before storing the chat, so nothing else in
 * the app knows this happened.
 *
 * Per account: a hash names bytes only within the account that uploaded them.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './db.js';

export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const ROOT = path.join(DATA_DIR, 'sync-blobs');
const HASH = /^[a-f0-9]{64}$/;

const fileOf = (userId, hash) => {
  if (!HASH.test(hash)) throw Object.assign(new Error('Invalid blob id.'), { statusCode: 400 });
  const owner = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
  return path.join(ROOT, owner, hash.slice(0, 2), hash);
};

export const hasBlob = (userId, hash) => fs.existsSync(fileOf(userId, hash));

export const putBlob = (userId, hash, bytes) => {
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== hash) throw Object.assign(new Error('Blob content does not match its id.'), { statusCode: 400 });
  const file = fileOf(userId, hash);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
};

export const readBlob = (userId, hash) => {
  const file = fileOf(userId, hash);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
};
