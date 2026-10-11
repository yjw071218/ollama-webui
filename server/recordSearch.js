import { database } from './db.js';
import { chatText, normaliseSearch, searchGrams } from './storageSecurity.js';

export function searchRecords(userId, query, { limit = 100, offset = 0 } = {}) {
  const q = normaliseSearch(query).trim();
  if (!q || q.length > 200) return { hits: [], complete: true };
  const db = database();
  // Every substring match must contain all these grams. Intersect a bounded
  // subset, then verify the exact phrase only in those candidates.
  const tokens = searchGrams(q, true).slice(0, 32).map(t => db.prepare('SELECT webui_search_hash(?) AS token').get(t).token);
  const candidates = db.prepare(`SELECT id FROM record_search WHERE user_id=? AND token IN (${tokens.map(() => '?').join(',')})
    GROUP BY id HAVING COUNT(*)=? ORDER BY id LIMIT ? OFFSET ?`).all(userId, ...tokens, tokens.length, Math.min(500, limit) + 1, Math.max(0, offset));
  const read = db.prepare("SELECT id,updated_at,payload FROM readable_records WHERE user_id=? AND kind='chat' AND id=? AND deleted=0");
  const hits = [];
  for (const candidate of candidates.slice(0, limit)) {
    const row = read.get(userId, candidate.id);
    if (!row || !chatText(row.payload).includes(q)) continue;
    const chat = JSON.parse(row.payload);
    hits.push({ sessionId: row.id, title: chat.title || '', updatedAt: row.updated_at });
  }
  return { hits, complete: candidates.length <= limit, nextOffset: offset + Math.min(limit, candidates.length) };
}
