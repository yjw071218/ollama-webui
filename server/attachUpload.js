/*
 * Files nothing here can read, attached by path.
 *
 * A .hwp, an .exe, a .zip of something odd: the extractor has no text to give
 * and the composer used to refuse them outright. The CLI agents (and MCP file
 * tools) can open a file on this machine just fine, though -- what they lack is
 * a path. So the bytes are saved here, under the data directory, and the chat
 * gets the absolute path to hand on.
 *
 *   POST /api/attach-file   body: the raw bytes
 *     X-File-Name: <encodeURIComponent(name)>
 *   -> { success, path, name, size }
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR } from './db.js';

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const KEEP_DAYS = 14;

export const attachDir = (env = {}) => path.resolve(String(env.ATTACH_DIR || '').trim() || path.join(DATA_DIR, 'attachments'));

/* A name that is safe on Windows and cannot climb out of its folder. */
export const safeFileName = (raw) => {
  let name = String(raw || '').replace(/[\\/]/g, '_').replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name) name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `_${name}`;
  return name.slice(0, 180);
};

/* Old uploads go after two weeks; a folder per upload keeps names as given. */
const sweep = (root) => {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true }); } catch { /* in use */ }
    }
  } catch { /* nothing yet */ }
};

export const createAttachUploadRoute = (env = {}) => async (req, res) => {
  const json = (payload, status = 200) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  if (req.method !== 'POST') return json({ success: false, error: 'POST only' }, 405);
  let name;
  try { name = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || ''))); }
  catch { name = safeFileName(req.headers['x-file-name']); }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BYTES) return json({ success: false, error: 'File too large (2 GB max)' }, 413);

  const root = attachDir(env);
  sweep(root);
  const folder = path.join(root, `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}`);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, name);
  const out = fs.createWriteStream(target);
  let size = 0, failed = false;
  const fail = (status, error) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(folder, { recursive: true, force: true }, () => {});
    json({ success: false, error }, status);
  };
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BYTES) { req.destroy(); fail(413, 'File too large (2 GB max)'); }
  });
  req.on('aborted', () => fail(400, 'Upload interrupted'));
  out.on('error', (e) => fail(500, e.message));
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    json({ success: true, path: target, name, size });
  });
};
