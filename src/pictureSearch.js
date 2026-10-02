/**
 * Finding a picture you half remember.
 *
 * The gallery matched substrings against the prompt each picture was drawn
 * from. That works when you remember the words, and the whole difficulty is
 * that you do not: what you remember is *a red sunset over water*, and what
 * was typed a month ago was `golden hour, ocean horizon, dramatic clouds`.
 * Nothing in those two strings matches.
 *
 * The same fix the conversations already have -- see src/chatSearch.js, which
 * this deliberately mirrors -- pointed at prompts instead of messages:
 *
 *   * substring matches are kept and ranked first, because semantic search is
 *     worse than plain matching at the thing plain matching is for. Type a
 *     filename or a LoRA name and you want that exact string, not the five
 *     prompts most *like* it;
 *   * the index is built on demand and cached, not maintained as pictures are
 *     made. Embedding every prompt as it is drawn would put an Ollama round
 *     trip in the middle of every generation to serve a search used once a
 *     week.
 *
 * A prompt is already about the size of a chunk, so there is one vector per
 * picture and no splitting -- which is the one simplification this has over
 * the conversation index.
 */

import localforage from 'localforage';
import { embedTexts, normalise, dot, DEFAULT_EMBED_MODEL } from './rag.js';

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'pictureIndex' });

const keyFor = (scope) => `pictureIndex:${scope || 'guest'}`;

/* A prompt can be a paragraph of tags. Truncated rather than split: the first
   part of a prompt is the subject, which is what anybody is searching for. */
const MAX_PIECE = 600;

/* How many pictures the index will hold, newest first. A vector is 768
   Float32s, about 3 KB, so this is around six megabytes -- and it is the newest
   two thousand, which is the right end to keep. */
export const MAX_INDEXED = 2000;

/** What is worth embedding about a picture: the prompt, and the chat it came from. */
export const pieceOf = (item) => [item?.prompt, item?.sessionTitle]
  .map(part => String(part || '').trim())
  .filter(Boolean)
  .join(' — ')
  .slice(0, MAX_PIECE);

/** The pictures to index, newest first and never more than the ceiling. */
export const indexablePictures = (items) => (items || [])
  .filter(item => item?.key && pieceOf(item))
  .slice(0, MAX_INDEXED)
  .map(item => ({ key: String(item.key), text: pieceOf(item) }));

/**
 * Whether an index still describes this gallery.
 *
 * The keys and nothing else: a picture's prompt cannot change after it is
 * drawn, so a set of the same keys is a set of the same vectors. Cheap enough
 * to compute on every search, which is what makes "is this stale" answerable
 * without reading the vectors themselves.
 */
export const indexSignature = (pieces) =>
  `${pieces.length}:${pieces.map(p => p.key).join(',').length}:${pieces[0]?.key || ''}:${pieces[pieces.length - 1]?.key || ''}`;

export const loadIndex = async (scope) => {
  try { return (await store.getItem(keyFor(scope))) || null; } catch (e) { return null; }
};

export const saveIndex = async (scope, index) => {
  try { await store.setItem(keyFor(scope), index); } catch (e) { /* a cache is allowed to fail */ }
};

export const clearIndex = async (scope) => {
  try { await store.removeItem(keyFor(scope)); } catch (e) { /* nothing to clear */ }
};

/**
 * Embed what is not embedded yet, keeping what is.
 *
 * Reuses the vectors of pictures that were in the previous index, so opening
 * the gallery after drawing three more costs three embeddings rather than two
 * thousand. `onProgress` is called with how many are left to do, because the
 * first build on a large gallery is a wait somebody has to be told about.
 */
export const buildIndex = async (scope, items, {
  model = DEFAULT_EMBED_MODEL,
  signal,
  onProgress = () => {},
  batch = 64,
} = {}) => {
  const pieces = indexablePictures(items);
  const previous = await loadIndex(scope);
  const known = new Map((previous?.entries || []).map(entry => [entry.key, entry.vector]));

  const missing = pieces.filter(piece => !known.has(piece.key));
  onProgress({ done: 0, total: missing.length });

  for (let at = 0; at < missing.length; at += batch) {
    signal?.throwIfAborted();
    const slice = missing.slice(at, at + batch);
    const vectors = await embedTexts(slice.map(p => p.text), model, signal);
    slice.forEach((piece, n) => {
      const vector = vectors[n];
      if (vector) known.set(piece.key, normalise(vector));
    });
    onProgress({ done: Math.min(at + batch, missing.length), total: missing.length });
  }

  const index = {
    at: Date.now(),
    model,
    signature: indexSignature(pieces),
    entries: pieces
      .filter(piece => known.has(piece.key))
      .map(piece => ({ key: piece.key, vector: known.get(piece.key) })),
  };
  await saveIndex(scope, index);
  return index;
};

/** The keys of the pictures closest to what was typed, best first. */
export const searchPictures = async (index, query, {
  model = DEFAULT_EMBED_MODEL,
  topK = 60,
  minScore = 0.35,
  signal,
} = {}) => {
  const wanted = String(query || '').trim();
  if (!wanted || !index?.entries?.length) return [];

  const [raw] = await embedTexts([wanted], model, signal);
  const vector = normalise(raw);

  return index.entries
    .map(entry => ({ key: entry.key, score: dot(vector, entry.vector) }))
    .filter(hit => hit.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
};

/**
 * Substring matches, which is what the gallery has always done.
 *
 * Kept, and ranked first. Typing part of a prompt you remember exactly should
 * not be answered with things that merely resemble it.
 */
export const literalPictures = (items, query) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items || [];
  return (items || []).filter(item =>
    String(item?.prompt || '').toLowerCase().includes(needle)
    || String(item?.sessionTitle || '').toLowerCase().includes(needle));
};

/** Literal hits first, then the semantic ones the literal pass missed. */
export const mergePictures = (items, literal, hits) => {
  const seen = new Set(literal.map(item => item.key));
  const byKey = new Map((items || []).map(item => [item.key, item]));
  const extra = (hits || [])
    .filter(hit => !seen.has(hit.key) && byKey.has(hit.key))
    .map(hit => ({ ...byKey.get(hit.key), score: hit.score }));
  return [...literal, ...extra];
};
