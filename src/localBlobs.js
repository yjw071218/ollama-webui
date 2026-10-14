/**
 * Large strings out of the chat list, into a store of their own.
 *
 * The chat list is one IndexedDB value. Attached photos were kept in it as
 * base64 -- 235 MB of a 251 MB list on one machine -- and that value is read,
 * merged and written back every ~700 ms while a reply streams, and read again
 * (and cloned across a worker) by every sync. The page ran out of memory and
 * Electron reloaded it: the "lags, then refreshes" the reader saw.
 *
 * Now every string of LOCAL_MIN or more inside a message is stored once, by
 * SHA-256, in the 'blobs' store, and the list holds `local-blob:v1:<hash>`.
 * Written once per picture, never again; the list shrinks to its text.
 *
 * `internalize` puts the bytes back, for the places that need them: loading
 * the list into the app, uploading a chat, exporting a backup.
 */
import localforage from 'localforage';

export const LOCAL_BLOB_PREFIX = 'local-blob:v1:';
const LOCAL_MIN = 32 * 1024;

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'blobs' });

/* String -> hash, so a picture already stored is not hashed on every save.
   A Map keyed by the string itself: V8 hashes a string's contents once and
   keeps it, and the strings are alive in the app's state anyway. */
const hashOf = new Map();
/* Hash -> string, for putting them back. Bounded loosely; the app holds the
   same strings, so this mostly shares them rather than copying. */
const textOf = new Map();
const written = new Set();
const pendingWrites = new Map();

const encoder = new TextEncoder();
const sha256 = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
};

const remember = (text, hash) => {
  if (hashOf.size > 4000) hashOf.clear();
  if (textOf.size > 4000) textOf.clear();
  hashOf.set(text, hash);
  textOf.set(hash, text);
};

const storeText = async (text) => {
  let hash = hashOf.get(text);
  if (!hash) {
    hash = await sha256(text);
    remember(text, hash);
  }
  if (!written.has(hash)) {
    if (!pendingWrites.has(hash)) {
      pendingWrites.set(hash, (async () => {
        const have = await store.getItem(hash).then(v => typeof v === 'string', () => false);
        if (!have) await store.setItem(hash, text);
        written.add(hash);
      })().finally(() => pendingWrites.delete(hash)));
    }
    await pendingWrites.get(hash);
  }
  return LOCAL_BLOB_PREFIX + hash;
};

export const isLocalBlob = (value) => typeof value === 'string' && value.startsWith(LOCAL_BLOB_PREFIX);

const hasBig = (value, depth = 0) => {
  if (typeof value === 'string') return value.length >= LOCAL_MIN && !isLocalBlob(value);
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => hasBig(v, depth + 1));
  for (const k in value) if (hasBig(value[k], depth + 1)) return true;
  return false;
};

const outOf = async (value, depth = 0) => {
  if (typeof value === 'string') return value.length >= LOCAL_MIN && !isLocalBlob(value) ? storeText(value) : value;
  if (depth > 8 || !value || typeof value !== 'object') return value;
  if (!hasBig(value, depth)) return value;
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await outOf(v, depth + 1));
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = await outOf(v, depth + 1);
  return out;
};

/* Only what a message carries. The chat's own fields (title, ids, model)
   are small, and text a reader wrote stays where search can read it: a
   message's `content` is never moved, however long. */
const KEEP_INLINE = new Set(['content', 'thinking', 'role', 'id']);

const messageOut = async (message) => {
  if (!message || typeof message !== 'object' || !hasBig(message)) return message;
  const out = {};
  for (const [k, v] of Object.entries(message)) out[k] = KEEP_INLINE.has(k) ? v : await outOf(v);
  return out;
};

/** A chat with its large message strings by address. Same object when nothing moved. */
export const externalizeChat = async (chat) => {
  const messages = chat?.messages;
  if (!Array.isArray(messages)) return chat;
  let touched = false;
  const next = [];
  for (const m of messages) {
    const moved = await messageOut(m);
    if (moved !== m) touched = true;
    next.push(moved);
  }
  return touched ? { ...chat, messages: next } : chat;
};

export const externalizeList = async (list) => {
  const out = [];
  for (const chat of list || []) {
    try { out.push(await externalizeChat(chat)); } catch { out.push(chat); }
  }
  return out;
};

const hasMarker = (value, depth = 0) => {
  if (typeof value === 'string') return isLocalBlob(value);
  if (depth > 10 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => hasMarker(v, depth + 1));
  for (const k in value) if (hasMarker(value[k], depth + 1)) return true;
  return false;
};

const fetchText = async (hash) => {
  const held = textOf.get(hash);
  if (held !== undefined) return held;
  const text = await store.getItem(hash).catch(() => null);
  if (typeof text === 'string') {
    remember(text, hash);
    written.add(hash);
    return text;
  }
  return null;
};

const inOf = async (value, depth = 0) => {
  if (typeof value === 'string') {
    if (!isLocalBlob(value)) return value;
    const text = await fetchText(value.slice(LOCAL_BLOB_PREFIX.length));
    // A blob that is gone stays a marker rather than turning into nothing.
    return text ?? value;
  }
  if (depth > 10 || !value || typeof value !== 'object' || !hasMarker(value, depth)) return value;
  if (Array.isArray(value)) return Promise.all(value.map(v => inOf(v, depth + 1)));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = await inOf(v, depth + 1);
  return out;
};

/** Any value with every local-blob marker replaced by its bytes. */
export const internalize = (value) => inOf(value);
export const internalizeList = async (list) => Array.isArray(list) ? Promise.all(list.map(c => inOf(c))) : list;
