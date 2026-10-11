import { database, transaction } from './db.js';

export function initialiseSyncRetention(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_devices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, seen_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,device_id));
    CREATE TABLE IF NOT EXISTS sync_floors (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, rev INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS records_deleted_age ON records(user_id,deleted,updated_at,rev);`);
}
export const syncFloor = userId => database().prepare('SELECT rev FROM sync_floors WHERE user_id=?').get(userId)?.rev || 0;
const lastCollection = new Map();
export function maintainTombstones(userId) {
  const now = Date.now();
  if (now - (lastCollection.get(userId) || 0) < 86400000) return 0;
  const count = collectTombstones(userId);
  lastCollection.set(userId, now);
  if (lastCollection.size > 10000) lastCollection.delete(lastCollection.keys().next().value);
  return count;
}

export function acknowledgeSync(userId, deviceId, revision) {
  if (!deviceId || !Number.isSafeInteger(revision) || revision < 0) return;
  const db = database();
  const latest = db.prepare('SELECT rev FROM users WHERE id=?').get(userId)?.rev || 0;
  if (revision > latest) return;
  db.prepare(`INSERT INTO sync_devices(user_id,device_id,rev,seen_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id,device_id) DO UPDATE SET rev=MAX(rev,excluded.rev),seen_at=excluded.seen_at`).run(userId, deviceId, revision, Date.now());
}

export function collectTombstones(userId, olderThanMs = 30 * 86400000) {
  return transaction(db => {
    // A dormant device holds back collection for 180 days. On returning after
    // that window, the floor below forces reconciliation before any upload.
    const now = Date.now();
    const unknown = db.prepare(`SELECT COUNT(*) AS n FROM known_devices k WHERE k.user_id=?
      AND NOT EXISTS(SELECT 1 FROM sync_devices d WHERE d.user_id=k.user_id AND d.device_id=k.device_id)`).get(userId).n;
    if (unknown) return 0;
    const ack = db.prepare('SELECT MIN(rev) AS rev FROM sync_devices WHERE user_id=? AND seen_at>=?').get(userId, now - 180 * 86400000)?.rev;
    if (ack == null) return 0;
    const cutoff = now - Math.max(0, olderThanMs);
    const max = db.prepare('SELECT MAX(rev) AS rev FROM records WHERE user_id=? AND deleted=1 AND updated_at<? AND rev<=?').get(userId, cutoff, ack)?.rev;
    if (max == null) return 0;
    db.prepare(`INSERT INTO sync_floors(user_id,rev) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET rev=MAX(rev,excluded.rev)`).run(userId, max);
    return Number(db.prepare('DELETE FROM records WHERE user_id=? AND deleted=1 AND updated_at<? AND rev<=?').run(userId, cutoff, ack).changes);
  });
}
