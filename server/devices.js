/**
 * New-device confirmation.
 *
 * Every browser/app keeps a random id in the `webui_device` cookie (set by the
 * client, see src/deviceId.js). A sign-in from an id the account has never
 * been confirmed on opens a *pending* session: it can see who it is waiting to
 * be, and nothing else. A device that is already signed in is asked "was this
 * you?" and either approves it -- the id becomes known -- or ends it.
 *
 * When the account has no other signed-in device to ask, there is nobody who
 * could answer, so the sign-in is accepted and the device remembered.
 */
import { database } from './db.js';
import { readCookie, sessionIdOf } from './session.js';

export const DEVICE_COOKIE = 'webui_device';

export const deviceIdOf = (req) => {
  const raw = readCookie(req, DEVICE_COOKIE) || String(req.headers?.['x-device-id'] || '');
  return /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : '';
};

const known = new Set();

export const isKnownDevice = (userId, deviceId) => {
  if (!userId || !deviceId) return false;
  if (known.has(`${userId}|${deviceId}`)) return true;
  const row = database().prepare('SELECT 1 FROM known_devices WHERE user_id = ? AND device_id = ?').get(userId, deviceId);
  if (row) known.add(`${userId}|${deviceId}`);
  return !!row;
};

export const rememberDevice = (userId, deviceId) => {
  if (!userId || !deviceId || known.has(`${userId}|${deviceId}`)) return;
  database().prepare('INSERT OR IGNORE INTO known_devices (user_id, device_id, created_at) VALUES (?,?,?)')
    .run(userId, deviceId, Date.now());
  known.add(`${userId}|${deviceId}`);
};

export const knownDeviceCount = (userId) =>
  database().prepare('SELECT COUNT(*) AS n FROM known_devices WHERE user_id = ?').get(userId)?.n || 0;

/** Signed-in, confirmed sessions on some other device: someone who can answer. */
export const hasApprover = (userId, deviceId) => {
  const row = database().prepare(`
    SELECT COUNT(*) AS n FROM sessions
     WHERE user_id = ? AND pending = 0 AND device_id <> '' AND device_id <> ?
  `).get(userId, deviceId || '');
  return (row?.n || 0) > 0;
};

/**
 * Whether a sign-in from this device must wait for approval.
 * Accounts that predate the feature have no known devices yet; their first
 * sign-ins register instead of being stopped.
 */
export const needsApproval = (userId, deviceId) => {
  if (!deviceId) return false;
  if (isKnownDevice(userId, deviceId)) return false;
  if (knownDeviceCount(userId) === 0 || !hasApprover(userId, deviceId)) {
    rememberDevice(userId, deviceId);
    return false;
  }
  return true;
};

export const listPending = (userId) => database().prepare(`
  SELECT token_hash, created_at, user_agent, ip FROM sessions
   WHERE user_id = ? AND pending = 1 ORDER BY created_at DESC
`).all(userId).map(row => ({
  id: sessionIdOf(row.token_hash),
  createdAt: row.created_at,
  userAgent: row.user_agent || '',
  ip: row.ip || '',
}));

const pendingRows = (userId, sessionId) => database().prepare(
  'SELECT token_hash, device_id FROM sessions WHERE user_id = ? AND pending = 1',
).all(userId).filter(row => sessionIdOf(row.token_hash) === String(sessionId));

/** Approve or refuse one waiting sign-in (and every tab of that device). */
export const decidePending = (userId, sessionId, approve) => {
  const rows = pendingRows(userId, sessionId);
  if (!rows.length) return false;
  const db = database();
  const device = rows[0].device_id;
  if (approve) {
    if (device) rememberDevice(userId, device);
    db.prepare('UPDATE sessions SET pending = 0 WHERE user_id = ? AND pending = 1 AND (token_hash = ? OR (device_id <> \'\' AND device_id = ?))')
      .run(userId, rows[0].token_hash, device);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND pending = 1 AND (token_hash = ? OR (device_id <> \'\' AND device_id = ?))')
      .run(userId, rows[0].token_hash, device);
  }
  return true;
};
