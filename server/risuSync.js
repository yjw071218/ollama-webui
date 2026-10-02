import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { database } from './db.js';
import { createDelta, applyDelta } from '../integrations/risuai/sync-delta.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RISU_ASSET_DIR = fileURLToPath(new URL('./data/risu-assets/', import.meta.url));
// Assets are uploaded before the snapshot that uses them, so a fresh asset is
// never pruned: only ones older than this and unused by every kept snapshot.
const PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/* Asset bytes live in files (<dir>/<user>/<hash>); the table keeps the hash,
   size and upload time. Rows whose bytes are still in the table (not yet
   migrated) are read from there, so the server works during migration. */
export const risuAssetFile = (dir, user, hash) => join(dir, encodeURIComponent(user), hash);
export function writeRisuAssetFile(dir, user, hash, bytes) {
  const file = risuAssetFile(dir, user, hash);
  if (existsSync(file)) return file;
  mkdirSync(join(dir, encodeURIComponent(user)), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, bytes, { flush: true });
  renameSync(tmp, file);
  return file;
}
export function ensureRisuAssetColumns(sql) {
  const cols = sql.prepare('PRAGMA table_info(risu_assets)').all().map(c => c.name);
  if (!cols.includes('size')) sql.exec('ALTER TABLE risu_assets ADD COLUMN size INTEGER');
  if (!cols.includes('created')) sql.exec('ALTER TABLE risu_assets ADD COLUMN created INTEGER');
}

export function createRisuSyncHandler({ guard, db = database, assetDir = DEFAULT_RISU_ASSET_DIR }) {
  let initialized = false;
  const store = () => {
    const sql = db();
    if (!initialized) {
      sql.exec(`CREATE TABLE IF NOT EXISTS risu_snapshots (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, payload BLOB NOT NULL, updated INTEGER NOT NULL,
        PRIMARY KEY(user_id, revision));
        CREATE TABLE IF NOT EXISTS risu_assets (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hash TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(user_id, hash));`);
      ensureRisuAssetColumns(sql);
      initialized = true;
    }
    return sql;
  };
  const readAsset = (sql, user, hash) => {
    try { return readFileSync(risuAssetFile(assetDir, user, hash)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const row = sql.prepare('SELECT bytes FROM risu_assets WHERE user_id=? AND hash=?').get(user, hash);
    return row && row.bytes.length ? Buffer.from(row.bytes) : null;
  };
  // Remove assets no kept snapshot references. Runs after a commit, at most
  // hourly per user, off the request path.
  const lastPrune = new Map();
  const schedulePrune = user => {
    if (Date.now() - (lastPrune.get(user) || 0) < PRUNE_INTERVAL_MS) return;
    lastPrune.set(user, Date.now());
    setTimeout(() => { try { pruneAssets(user); } catch (error) { console.warn('[risu-sync] asset prune failed:', error.message); } }, 5000).unref?.();
  };
  const pruneAssets = user => {
    const sql = store();
    const used = new Set();
    for (const row of sql.prepare('SELECT payload FROM risu_snapshots WHERE user_id=?').all(user)) {
      for (const digest of Object.values(JSON.parse(gunzipSync(row.payload)).assets || {})) used.add(digest);
    }
    if (!used.size) return; // never wipe a user with no snapshot to compare against
    const cutoff = Date.now() - PRUNE_GRACE_MS;
    const candidates = sql.prepare('SELECT hash FROM risu_assets WHERE user_id=? AND COALESCE(created,0) < ?').all(user, cutoff)
      .map(r => r.hash).filter(h => !used.has(h));
    const remove = sql.prepare('DELETE FROM risu_assets WHERE user_id=? AND hash=?');
    for (const hash of candidates) {
      remove.run(user, hash);
      rmSync(risuAssetFile(assetDir, user, hash), { force: true });
    }
    if (candidates.length) console.log(`[risu-sync] pruned ${candidates.length} unused asset(s) for ${user}`);
  };
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = async (req, max) => {
    const parts = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > max) throw new Error('동기화 파일이 크기 제한을 초과했습니다.'); parts.push(part); }
    return Buffer.concat(parts);
  };
  /* Live sync: a device asks `?wait=<its revision>` and the answer is held
     until another device commits a newer one (or 25s pass). PC and phone see
     each other's messages the moment they are saved, without hammering the
     database with polls. */
  const waiters = new Map(); // user -> Set<() => void>
  const notify = user => { const set = waiters.get(user); if (!set) return; waiters.delete(user); for (const wake of set) wake(); };
  // Older builds still in an open tab clone a whole character on conflict.
  // Those clones are never stored again, whoever sends them.
  const isCopy = item => /\(동시 수정 사본\)/.test(item?.name || '');
  const stripCopies = data => {
    for (const field of ['characters', 'botPresets', 'modules']) {
      if (Array.isArray(data[field])) data[field] = data[field].filter(item => !isCopy(item));
    }
    for (const key of Object.keys(data.assets || {})) if (/\.sync-[0-9a-f]+$/.test(key)) delete data.assets[key];
    return data;
  };
  return async (req, res) => {
    const auth = guard(req, res, { methods: ['GET', 'PUT', 'POST'] });
    if (!auth) return;
    try {
      const sql = store(), user = auth.user.id;
      const url = new URL(req.url, 'http://localhost');
      const hash = url.searchParams.get('asset');
      if (hash !== null) {
        if (!/^[a-f0-9]{64}$/.test(hash)) return json(res, 400, { error: 'Invalid asset hash' });
        if (req.method === 'GET') {
          const found = readAsset(sql, user, hash);
          if (!found) return json(res, 404, { error: 'Asset missing' });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(found); return;
        }
        if (req.method !== 'PUT') return json(res, 405, { error: 'PUT required' });
        const bytes = await body(req, 64 * 1024 * 1024);
        if (createHash('sha256').update(bytes).digest('hex') !== hash) return json(res, 400, { error: 'Asset checksum mismatch' });
        const exists = sql.prepare('SELECT 1 FROM risu_assets WHERE user_id=? AND hash=?').get(user, hash);
        const used = sql.prepare('SELECT COALESCE(SUM(COALESCE(size, length(bytes))),0) AS size FROM risu_assets WHERE user_id=?').get(user).size;
        if (!exists && used + bytes.length > 2 * 1024 ** 3) return json(res, 413, { error: '상황극 에셋 동기화 용량 2GB를 초과했습니다.' });
        if (!exists) {
          // File first, row second: a row never points at a missing file.
          writeRisuAssetFile(assetDir, user, hash, bytes);
          sql.prepare('INSERT OR IGNORE INTO risu_assets (user_id, hash, bytes, size, created) VALUES (?,?,?,?,?)').run(user, hash, Buffer.alloc(0), bytes.length, Date.now());
        }
        return json(res, 200, { ok: true });
      }
      const latest = () => sql.prepare('SELECT * FROM risu_snapshots WHERE user_id=? ORDER BY revision DESC LIMIT 1').get(user);
      if (req.method === 'GET' && url.searchParams.has('wait')) {
        const known = Number(url.searchParams.get('wait'));
        const current = () => sql.prepare('SELECT revision FROM risu_snapshots WHERE user_id=? ORDER BY revision DESC LIMIT 1').get(user)?.revision || 0;
        if (current() !== known) return json(res, 200, { revision: current(), changed: true });
        await new Promise(resolve => {
          let set = waiters.get(user);
          if (!set) waiters.set(user, set = new Set());
          const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
          const timer = setTimeout(done, 25000);
          set.add(done);
          res.on('close', done); // the device went away
        });
        if (res.writableEnded || res.destroyed) return;
        const now = current();
        return json(res, 200, { revision: now, changed: now !== known });
      }
      if (req.method === 'GET') {
        const meta = sql.prepare('SELECT revision FROM risu_snapshots WHERE user_id=? ORDER BY revision DESC LIMIT 1').get(user);
        if (url.searchParams.get('revision') === String(meta?.revision || 0)) return json(res, 200, { revision: meta?.revision || 0, unchanged: true });
        const row = latest();
        if (row && url.searchParams.get('revision') === String(row.revision)) return json(res, 200, { revision: row.revision, unchanged: true });
        if (row && url.searchParams.get('delta') === '1') {
          const previous = sql.prepare('SELECT payload FROM risu_snapshots WHERE user_id=? AND revision=?').get(user, Number(url.searchParams.get('revision')));
          if (previous) return json(res, 200, { revision: row.revision, fromRevision: Number(url.searchParams.get('revision')), delta: createDelta(JSON.parse(gunzipSync(previous.payload)), JSON.parse(gunzipSync(row.payload))) });
        }
        return json(res, 200, row ? { revision: row.revision, data: JSON.parse(gunzipSync(row.payload)), updated: row.updated } : { revision: 0, data: null });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      const input = JSON.parse((await body(req, 48 * 1024 * 1024)).toString());
      let previousData;
      if (input.delta) {
        const row = latest();
        if (!row || row.revision !== input.revision) return json(res, 409, { error: '다른 기기의 변경 내용을 먼저 받아야 합니다.' });
        previousData = JSON.parse(gunzipSync(row.payload));
        input.data = applyDelta(previousData, input.delta);
      }
      if (!Number.isSafeInteger(input.revision) || !Array.isArray(input.data?.characters) || !input.data?.assets || typeof input.data.assets !== 'object') return json(res, 400, { error: 'Invalid snapshot' });
      stripCopies(input.data);
      for (const [key, digest] of Object.entries(input.data.assets)) {
        if (previousData?.assets?.[key] === digest) continue;
        if (typeof digest !== 'string' || !sql.prepare('SELECT 1 FROM risu_assets WHERE user_id=? AND hash=?').get(user, digest)) return json(res, 400, { error: 'Snapshot asset missing' });
      }
      // No await between version check and commit: concurrent devices cannot
      // silently overwrite a snapshot based on an older revision.
      sql.exec('BEGIN IMMEDIATE');
      try {
        const revision = latest()?.revision || 0;
        if (revision !== input.revision) { sql.exec('ROLLBACK'); return json(res, 409, { error: '다른 기기의 변경 사항이 먼저 저장되었습니다.' }); }
        sql.prepare('INSERT INTO risu_snapshots VALUES (?,?,?,?)').run(user, revision + 1, gzipSync(JSON.stringify(input.data)), Date.now());
        sql.prepare('DELETE FROM risu_snapshots WHERE user_id=? AND revision<=?').run(user, revision - 9);
        sql.exec('COMMIT');
        notify(user);
        schedulePrune(user);
        return json(res, 200, { revision: revision + 1 });
      } catch (error) { sql.exec('ROLLBACK'); throw error; }
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); }
  };
}
