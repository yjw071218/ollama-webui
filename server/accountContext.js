// What the server can add to a question from an account's own records.
//
// A server turn (server/turns.js) used to be the plain part of a turn only:
// no memories, no knowledge library. Both are already on the server as synced
// records -- `memory` rows are `{ text, kind, enabled }`, `document` rows carry
// their chunks' text -- so the parts that need no browser can be done here:
//
//   * memories: every enabled one when there are few, the most relevant by
//     BM25 when there are many;
//   * the knowledge library: BM25 over the library's chunks (src/lexical.js,
//     the same scorer the browser fuses with embeddings). No embeddings here:
//     the query would need the embedding model loaded next to the chat model,
//     and lexical retrieval alone finds names, codes and exact phrases well.
//
// Documents attached to one chat (they carry `chatId`) are not the library and
// are not searched for other conversations.
//
// Used by the OpenAI-compatible API and the Telegram bot.

import { database } from './db.js';
import { buildLexicalIndex, lexicalSearch } from '../src/lexical.js';

const MEMORY_ALL_BELOW = 25;
const MEMORY_TOP = 15;
const PASSAGES = 5;
const PASSAGE_CHARS = 1200;

const payloads = (owner, kind) => database()
  .prepare('SELECT id, payload FROM records WHERE user_id = ? AND kind = ? AND deleted = 0')
  .all(String(owner), kind)
  .map((row) => { try { return JSON.parse(row.payload); } catch (e) { return null; } })
  .filter(Boolean);

export const readSetting = (owner, key) => {
  const row = database()
    .prepare("SELECT payload FROM records WHERE user_id = ? AND kind = 'setting' AND id = ? AND deleted = 0")
    .get(String(owner), key);
  if (!row) return null;
  try { const v = JSON.parse(row.payload); return typeof v === 'string' ? v : null; } catch (e) { return null; }
};

/** Enabled memories, the relevant ones when there are too many to send all. */
export const pickMemories = (memories, question) => {
  const live = memories.filter(m => m && m.enabled !== false && String(m.text || '').trim());
  if (live.length <= MEMORY_ALL_BELOW) return live;
  const index = buildLexicalIndex(live.map(m => ({ ...m, text: m.text })));
  const hits = lexicalSearch(index, question, { limit: MEMORY_TOP }).map(h => h.entry);
  // Preferences apply whatever the question is about; the rest by relevance.
  const always = live.filter(m => m.kind === 'preference').slice(0, 8);
  const seen = new Set();
  return [...always, ...hits].filter(m => (seen.has(m.id) ? false : seen.add(m.id)));
};

/* The library's index, rebuilt only when the library changed. Keyed by the
   account and the newest revision among its documents. */
const indexCache = new Map();

const libraryIndex = (owner) => {
  const stamp = database()
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(rev), 0) AS rev FROM records WHERE user_id = ? AND kind = 'document'")
    .get(String(owner));
  const key = `${stamp.n}:${stamp.rev}`;
  const cached = indexCache.get(owner);
  if (cached?.key === key) return cached.index;
  const entries = [];
  for (const doc of payloads(owner, 'document')) {
    if (doc.enabled === false || doc.chatId) continue;
    for (const chunk of doc.chunks || []) {
      if (chunk?.text) entries.push({ text: chunk.text, name: doc.name || 'document', page: chunk.page });
    }
  }
  const index = buildLexicalIndex(entries);
  indexCache.set(owner, { key, index });
  if (indexCache.size > 50) indexCache.delete(indexCache.keys().next().value);
  return index;
};

export const searchLibrary = (owner, question, limit = PASSAGES) =>
  lexicalSearch(libraryIndex(owner), question, { limit }).map(h => h.entry);

/**
 * The system text to add for one question. Empty string when there is
 * nothing to add. `memory` and `knowledge` switch the two parts.
 */
export const accountContext = (owner, question, { memory = true, knowledge = true } = {}) => {
  const parts = [];
  if (memory && readSetting(owner, 'memoryEnabled') !== 'false') {
    const picked = pickMemories(payloads(owner, 'memory'), question);
    if (picked.length) {
      parts.push(`What you know about the user (from earlier conversations):\n${picked.map(m => `- ${m.text}`).join('\n')}`);
    }
  }
  if (knowledge && readSetting(owner, 'ragEnabled') !== 'false') {
    const passages = searchLibrary(owner, question);
    if (passages.length) {
      parts.push(
        'Passages from the user\'s knowledge library that may be relevant. Use them if they answer the question, '
        + 'cite the document name when you do, and ignore them if they do not:\n\n'
        + passages.map((p, i) => `[${i + 1}] ${p.name}${p.page ? ` p.${p.page}` : ''}\n${String(p.text).slice(0, PASSAGE_CHARS)}`).join('\n\n'),
      );
    }
  }
  return parts.join('\n\n');
};

/** The account's own system prompt, as the browser would use it. */
export const accountSystemPrompt = (owner) => readSetting(owner, 'systemPrompt') || '';

/** The model the account uses by default. */
export const accountDefaultModel = (owner) => readSetting(owner, 'defaultModel') || '';
