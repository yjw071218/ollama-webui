/**
 * Finding a conversation you half remember.
 *
 * Chat search matched substrings: `s.messages.some(m => m.content.includes(q))`.
 * That works when you remember the words, and the whole difficulty is that you
 * do not — you remember that you once worked out how a hash table resizes, and
 * you type "해시 테이블 크기" and find nothing, because what you actually wrote
 * was "버킷 개수를 두 배로".
 *
 * The parts to fix it were already here, doing the same job for attached
 * documents: `embedTexts` for the vectors, `normalise` and `dot` for the
 * comparison. All that was missing was pointing them at your own history.
 *
 * Two decisions worth stating, because both cost something:
 *
 *  - The index is built on demand and cached, not maintained as you chat.
 *    Embedding every message as it arrives would put an Ollama round trip in
 *    the middle of every turn to serve a feature used once a week.
 *  - Substring matches are kept and ranked first. Semantic search is worse
 *    than exact matching at the thing exact matching is for: if you type a
 *    filename or an error code you want that string, not the five paragraphs
 *    most like it.
 */
import localforage from 'localforage';
import { embedTexts, normalise, dot, DEFAULT_EMBED_MODEL } from './rag.js';
import { conversationTime } from './sessionEdit.js';

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'chatIndex' });

const keyFor = (scope) => `chatIndex:${scope || 'guest'}`;

/** Long enough to mean something, short enough to embed a lot of them. */
const MAX_PIECE = 900;

/* How many messages the index will hold, newest first.
 *
 * A vector is 768 Float32s, about 3 KB. Without a ceiling the index grows for
 * ever and nothing removes it: twenty thousand messages would be sixty
 * megabytes of IndexedDB accumulating silently until the browser decides to
 * clear site data, at which point it vanishes just as silently.
 *
 * Four thousand is about twelve megabytes, and it is the newest four thousand
 * — which is the right end to keep, because the conversation you are trying to
 * find is far more often from this month than from two years ago. */
export const MAX_INDEXED = 4000;

/** Roughly what an index occupies, for showing somebody. */
export const indexBytes = (index) => {
  const entries = index?.entries?.length || 0;
  const dims = index?.entries?.[0]?.vector?.length || 0;
  const vectors = entries * dims * 4;                    // Float32
  const text = (index?.entries || []).reduce((n, e) => n + (e.text?.length || 0) * 2, 0);
  return vectors + text;
};

/**
 * The pieces of a conversation worth indexing.
 *
 * One entry per message, truncated rather than chunked: a chat message is
 * already about the size of a chunk, and splitting them would multiply the
 * embedding cost of a long history for very little gain in recall.
 *
 * Tool results are skipped. They are machine output that nobody remembers
 * having read, and they are the bulkiest thing in a transcript.
 */
export const indexablePieces = (sessions) => {
  const out = [];
  for (const session of sessions || []) {
    if (!session || !Array.isArray(session.messages)) continue;
    session.messages.forEach((message, index) => {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) return;
      const content = typeof message.content === 'string' ? message.content : '';
      const text = content
        .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
        .replace(/<TOOL_[A-Z_]*>[\s\S]*?(<\/TOOL_[A-Z_]*>|$)/gi, '')
        .trim();
      if (text.length < 20) return;
      if (content.trimStart().startsWith('<TOOL_RESULT>')) return;
      out.push({
        sessionId: String(session.id),
        title: session.title || '',
        messageIndex: index,
        role: message.role,
        text: text.slice(0, MAX_PIECE),
        // When it was said. `updatedAt` is the sync clock and moves for
        // edits that are not messages -- filing a chat into a folder, say --
        // and the cap below keeps the newest, so using it would evict real
        // recent messages in favour of old ones that were tidied up.
        at: message.at || conversationTime(session),
      });
    });
  }
  // Newest first, then capped. Sorting before slicing is what makes the
  // ceiling keep the recent end rather than whichever chats happen to be
  // early in the list.
  if (out.length <= MAX_INDEXED) return out;
  return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_INDEXED);
};

/**
 * A fingerprint of what is worth re-indexing for.
 *
 * Chats change constantly — a title, a star, a scroll position — and almost
 * none of it changes what the text says. This counts only what would alter a
 * vector, so opening a chat does not throw the index away.
 */
export const indexSignature = (pieces) =>
  `${pieces.length}:${pieces.reduce((n, p) => n + p.text.length, 0)}`;

export const loadIndex = async (scope) => {
  try { return (await store.getItem(keyFor(scope))) || null; } catch (e) { return null; }
};

export const saveIndex = async (scope, index) => {
  try { await store.setItem(keyFor(scope), index); } catch (e) { /* quota */ }
};

export const clearIndex = async (scope) => {
  try { await store.removeItem(keyFor(scope)); } catch (e) { /* nothing to clear */ }
};

/**
 * Build or reuse the index.
 *
 * `onProgress` is called with `{ done, total }`; embedding a year of chats
 * takes a while and a search box that looks frozen is one people press again.
 */
export const buildIndex = async (scope, sessions, {
  model = DEFAULT_EMBED_MODEL,
  batch = 32,
  onProgress,
  signal,
} = {}) => {
  const pieces = indexablePieces(sessions);
  const signature = indexSignature(pieces);

  const cached = await loadIndex(scope);
  // Also keyed on the model: vectors from two different embedders are not
  // comparable, and mixing them silently returns nonsense rather than an error.
  if (cached && cached.signature === signature && cached.model === model) return cached;

  const vectors = [];
  for (let i = 0; i < pieces.length; i += batch) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    onProgress?.({ done: i, total: pieces.length });
    const slice = pieces.slice(i, i + batch).map(p => p.text);
    const embedded = await embedTexts(slice, model, signal);
    embedded.forEach(v => vectors.push(normalise(v)));
  }

  const index = {
    signature,
    model,
    builtAt: Date.now(),
    entries: pieces.map((p, i) => ({ ...p, vector: vectors[i] })),
  };
  await saveIndex(scope, index);
  onProgress?.({ done: pieces.length, total: pieces.length });
  return index;
};

/**
 * Rank an index against a query.
 *
 * One hit per conversation: ten passages from the same long chat is a worse
 * answer than ten different chats, because the thing being looked for is the
 * conversation.
 */
export const searchIndex = async (index, query, {
  model = DEFAULT_EMBED_MODEL,
  topK = 8,
  minScore = 0.3,
  signal,
} = {}) => {
  const q = String(query || '').trim();
  if (!q || !index?.entries?.length) return [];

  const [raw] = await embedTexts([q], model, signal);
  const vector = normalise(raw);

  const best = new Map();
  for (const entry of index.entries) {
    if (!entry.vector) continue;
    const score = dot(vector, entry.vector);
    if (score < minScore) continue;
    const seen = best.get(entry.sessionId);
    if (!seen || score > seen.score) best.set(entry.sessionId, { ...entry, score });
  }

  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
};

/**
 * Substring matches, which semantic search is worse at than plain matching.
 *
 * Kept separate and ranked first. If you type an error code or a filename you
 * want that exact string, and the five paragraphs most *like* it are not an
 * improvement — they are the feature getting in the way.
 */
export const literalMatches = (sessions, query) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const session of sessions || []) {
    if (!session) continue;
    const inTitle = String(session.title || '').toLowerCase().includes(q);
    const hit = (session.messages || []).findIndex(
      m => typeof m?.content === 'string' && m.content.toLowerCase().includes(q),
    );
    if (!inTitle && hit === -1) continue;
    out.push({
      sessionId: String(session.id),
      title: session.title || '',
      messageIndex: hit === -1 ? 0 : hit,
      text: hit === -1 ? String(session.title || '') : String(session.messages[hit].content).slice(0, MAX_PIECE),
      literal: true,
      score: 1,
      at: conversationTime(session),
    });
  }
  return out;
};

/** Literal hits first, then semantic ones for chats the literal pass missed. */
export const mergeResults = (literal, semantic) => {
  const seen = new Set(literal.map(r => r.sessionId));
  return [...literal, ...semantic.filter(r => !seen.has(r.sessionId))];
};
