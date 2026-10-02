// Keys for the OpenAI-compatible API.
//
// A key is `wk-` and 43 characters of base64url: 256 random bits, so it is
// the whole of the authentication and needs no rate limiting to be safe from
// guessing. Only its SHA-256 is stored. The first few characters are kept in
// the clear as `prefix`, so the settings screen can say which key is which
// without being able to show one again.

import crypto from 'node:crypto';
import { database } from './db.js';

export const KEY_PREFIX = 'wk-';
const MAX_KEYS = 20;

const hashOf = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

/** Make a key. The returned `key` is the only time it exists in the clear. */
export const createApiKey = (userId, name = '') => {
  const count = database().prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(userId).n;
  if (count >= MAX_KEYS) throw new Error(`At most ${MAX_KEYS} keys per account.`);
  const key = KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const row = {
    id: crypto.randomUUID(),
    name: String(name || '').trim().slice(0, 60) || 'API key',
    prefix: key.slice(0, KEY_PREFIX.length + 6),
    created_at: Date.now(),
  };
  database().prepare(`
    INSERT INTO api_keys (id, user_id, name, hash, prefix, created_at) VALUES (?,?,?,?,?,?)
  `).run(row.id, userId, row.name, hashOf(key), row.prefix, row.created_at);
  return { key, id: row.id, name: row.name, prefix: row.prefix, createdAt: row.created_at };
};

export const listApiKeys = (userId) => database().prepare(`
  SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt
    FROM api_keys WHERE user_id = ? ORDER BY created_at DESC
`).all(userId);

export const revokeApiKey = (userId, id) =>
  Number(database().prepare('DELETE FROM api_keys WHERE user_id = ? AND id = ?').run(userId, String(id)).changes) > 0;

/**
 * The account a presented key belongs to, or null. Also notes when it was
 * last used -- at most once a minute, so a busy client is not a write per call.
 */
export const userForApiKey = (key, now = Date.now()) => {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const row = database().prepare('SELECT id, user_id, last_used_at FROM api_keys WHERE hash = ?').get(hashOf(key));
  if (!row) return null;
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    database().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, row.id);
  }
  return { userId: row.user_id, keyId: row.id };
};

/** `Authorization: Bearer <key>`, or `x-api-key: <key>` for clients that send that. */
export const presentedApiKey = (req) => {
  const auth = String(req.headers?.authorization || '');
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  return bearer || String(req.headers?.['x-api-key'] || '') || null;
};
