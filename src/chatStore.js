/* The chat list, stored one chat per record.

   It used to be one IndexedDB value per profile: the whole account's chats in
   a single array. Every save -- every 400-800 ms while a reply streams -- and
   both halves of every sync read that array whole and wrote it back whole,
   through a structured clone, on the main thread. Once an account held a few
   hundred megabytes that was the app's lag, and it made a first sync of a big
   account quadratic: each downloaded page rewrote everything before it, until
   a 120-second storage timeout gave up and the sync started over.

   Now each chat is its own record, and a small index says which chats exist
   and which version of each is current:

     database 'ollama-webui-chats', store 'chats'
       `${listKey}\u0001${chatId}`   -> the chat, exactly as it was stored before
       `${listKey}\u0000index`       -> { v: 1, items: { [chatId]: version } }

   A separate database on purpose: adding a store to the existing
   'ollama-webui' database is a version upgrade, and an upgrade waits for every
   other open tab to let go of the old version.

   The public shape does not change -- callers still read and write "the list".
   A write compares the list it is given with what is held and touches only the
   chats that differ, so a streamed token costs one chat, not the account. A
   read checks the index (a few kilobytes) and fetches only the chats whose
   version moved; another tab's write is therefore seen on the next read, with
   no extra signalling.

   The old single value is migrated on first write and then removed. Until a
   profile has been written once it is read where it is, so a bucket nobody
   opens (an old guest profile awaiting import) is left exactly as it was.

   Off by default: the app turns it on (App.jsx). Code run outside the app --
   the sync tests, which play two devices in one process and poke storage
   directly -- keeps the old whole-value behaviour through the callbacks. */

import localforage from 'localforage';

const SEP = '\u0001';
const INDEX = '\u0000index';
const recordKey = (listKey, id) => `${listKey}${SEP}${id}`;
const indexKey = (listKey) => `${listKey}${INDEX}`;

let split = false;
export const enableSplitChatStore = (on = true) => { split = !!on; if (!on) held.clear(); };
export const splitChatStoreEnabled = () => split;

let db = null;
const chatsDb = () => (db ??= localforage.createInstance({ name: 'ollama-webui-chats', storeName: 'chats' }));

/* What this page holds per list. Shared with callers, so treat as read-only:
   every caller builds new arrays and new objects rather than editing. */
const held = new Map(); // listKey -> { legacy, byId: Map, vers: Map, prints: Map, list }

const asList = (value) => (Array.isArray(value) ? value.filter(c => c && c.id != null) : []);
const WRITE_BATCH_BYTES = 8 * 1024 * 1024;
/* Roughly a chat's size: its message text, where nearly all of it is. */
const approxChatBytes = (chat) => {
  let n = 256;
  for (const m of Array.isArray(chat?.messages) ? chat.messages : []) {
    if (typeof m?.content === 'string') n += m.content.length;
    for (const a of Array.isArray(m?.attachments) ? m.attachments : []) if (typeof a?.data === 'string') n += a.data.length;
    for (const k of ['images', 'pictures']) for (const p of Array.isArray(m?.[k]) ? m[k] : []) if (typeof p === 'string') n += p.length;
  }
  return n;
};
const byNewest =(a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
const newVersion = () => `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;

/* A cheap fingerprint, checked even when the object is the very one we stored:
   if anything ever edits a chat in place, identity alone would hide it. */
const printOf = (chat) => {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const last = messages[messages.length - 1];
  const text = typeof last?.content === 'string' ? last.content.length : 0;
  return `${chat?.updatedAt || 0}|${messages.length}|${text}|${chat?.title || ''}`;
};

/* Structural equality, all the way down.

   It was two levels (the chat's fields, then each message's), and on a real
   account that was not enough: `externalizeChat`, `withoutPictureBytes` and
   the merge hand back fresh objects at every depth -- an attachment list, a
   picture, its retouch -- with every value equal. Measured on a 519 MB account
   (536 chats), the shallow test called almost every chat changed, and a single
   sent message rewrote 380-590 MB. Walking the whole tree is cheap by
   comparison: unchanged strings are the very same instances, so `===` settles
   each leaf at once, and a real change exits at the first difference. */
const deepEqual = (a, b, depth = 0) => {
  if (a === b) return true;
  if (typeof a !== typeof b || !a || !b || typeof a !== 'object') return false; // strings compared by value above
  if (depth > 40) return false; // implausibly deep: treat as changed, which is only a write
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k], depth + 1)) return false;
  }
  return true;
};
const sameChat = (a, b) => deepEqual(a, b);

/* One writer at a time per list, across tabs where the browser can say so. */
const chains = new Map();
const exclusive = (listKey, fn) => {
  const run = () => (globalThis.navigator?.locks?.request
    ? globalThis.navigator.locks.request(`chat-store:${listKey}`, fn)
    : fn());
  const next = (chains.get(listKey) || Promise.resolve()).catch(() => {}).then(run);
  chains.set(listKey, next);
  return next;
};

const fromRecords = (records, vers, legacy) => {
  const byId = new Map(), prints = new Map();
  for (const chat of records) { const id = String(chat.id); byId.set(id, chat); prints.set(id, printOf(chat)); }
  return { legacy, byId, vers, prints, list: [...byId.values()].sort(byNewest) };
};

/* Everything, from scratch: the index's versions, and every record actually in
   the store -- including one whose write landed just before a crash took the
   index write with it, so a new chat is never orphaned. */
const coldRead = async (listKey) => {
  const store = chatsDb();
  const index = await store.getItem(indexKey(listKey));
  if (!index || typeof index !== 'object' || !index.items) {
    const legacy = asList(await localforage.getItem(listKey));
    return fromRecords(legacy, new Map(), true);
  }
  const prefix = `${listKey}${SEP}`;
  const records = [];
  await store.iterate((value, key) => { if (key.startsWith(prefix) && value && value.id != null) records.push(value); });
  const vers = new Map(Object.entries(index.items));
  for (const chat of records) if (!vers.has(String(chat.id))) vers.set(String(chat.id), 'orphan');
  return fromRecords(records, vers, false);
};

/* What changed since we last looked: one small read, then only the chats whose
   version moved -- another tab's edit, or the sync's. */
const warmRead = async (listKey, state) => {
  const store = chatsDb();
  const index = await store.getItem(indexKey(listKey));
  if (!index?.items) return coldRead(listKey); // migrated or removed elsewhere
  const items = index.items;
  const ids = Object.keys(items);
  let moved = ids.length !== state.vers.size;
  const byId = new Map(), prints = new Map(), vers = new Map();
  const fetches = [];
  for (const id of ids) {
    vers.set(id, items[id]);
    if (state.vers.get(id) === items[id] && state.byId.has(id)) {
      byId.set(id, state.byId.get(id)); prints.set(id, state.prints.get(id));
    } else {
      moved = true;
      fetches.push(store.getItem(recordKey(listKey, id)).then(chat => {
        if (chat && chat.id != null) { byId.set(id, chat); prints.set(id, printOf(chat)); }
      }));
    }
  }
  if (!moved) return state; // the same list object: nothing to re-render
  await Promise.all(fetches);
  return { legacy: false, byId, vers, prints, list: [...byId.values()].sort(byNewest) };
};

const newestOf = (list) => list.reduce((n, c) => Math.max(n, Number(c?.updatedAt) || 0), 0);

/* The old single value, reappearing after migration. That is what a tab still
   running the previous version does: it keeps writing the whole list where it
   always did. Ignoring it would hide that tab's chats from this one, so they
   are folded in (the newer copy of each chat wins), marked to be written at
   the next save, and the old value is removed once they are. */
const absorbLegacy = async (listKey, state) => {
  let raw;
  try { raw = await localforage.getItem(listKey); } catch { return state; }
  const legacy = asList(raw);
  if (!legacy.length) return state.pendingLegacy ? { ...state, pendingLegacy: 0 } : state;
  const byId = new Map(state.byId), vers = new Map(state.vers), prints = new Map(state.prints);
  for (const chat of legacy) {
    const id = String(chat.id);
    const mine = byId.get(id);
    if (mine && (Number(mine.updatedAt) || 0) >= (Number(chat.updatedAt) || 0)) continue;
    byId.set(id, chat); vers.set(id, 'legacy'); prints.set(id, printOf(chat));
  }
  return { legacy: false, byId, vers, prints, list: [...byId.values()].sort(byNewest), pendingLegacy: newestOf(legacy) || 1 };
};

const current = async (listKey) => {
  const state = held.get(listKey);
  let next = state && !state.legacy ? await warmRead(listKey, state) : await coldRead(listKey);
  if (!next.legacy) next = await absorbLegacy(listKey, next);
  held.set(listKey, next);
  return next;
};

/** The chats under `listKey`, newest first, as stored. Read-only. */
export const readChats = async (listKey, { legacyRead } = {}) => {
  if (!split) return asList(await (legacyRead ? legacyRead() : localforage.getItem(listKey)));
  try { return (await current(listKey)).list; }
  catch (e) { held.delete(listKey); throw e; }
};

/**
 * Read, change and write the list as one step: `change(current)` returns the
 * list to store, and nothing else can write in between.
 *
 * Not a convenience. A save that reads the list, awaits, and then writes is
 * a lost update waiting to happen: the account sync lands a page of chats in
 * the gap, the save writes its older picture over them, and the sync's next
 * look finds chats it had stored missing -- which is exactly what a deletion
 * looks like. Measured on a real account, a fresh device's first sync turned
 * 37 chats into tombstones on the server that way. Inside the lock the save
 * merges against what is really there.
 */
export const updateChats = async (listKey, change, { legacyRead, legacyWrite } = {}) => {
  if (!split) {
    const now = asList(await (legacyRead ? legacyRead() : localforage.getItem(listKey)));
    const next = await change(now);
    if (next == null) return now;
    await (legacyWrite ? legacyWrite(next) : localforage.setItem(listKey, next));
    return next;
  }
  return exclusive(listKey, async () => {
    try {
      const state = await current(listKey);
      const next = await change(state.list);
      if (next == null) return state.list; // nothing to write
      const store = chatsDb();
      const wanted = new Map();
      for (const chat of asList(next)) wanted.set(String(chat.id), chat);

      /* Written a few megabytes at a time, not all at once. Each write holds a
         structured clone of its chat until it lands; the migration of a
         whole account (and a first sync) writes every chat, and started
         together that was a second copy of the account in memory -- on an
         Android tablet's WebView, enough to kill the page, which the app
         reopened, which migrated again. A streamed reply still writes its one
         chat at once. */
      const vers = new Map(), prints = new Map();
      let inFlight = [], inFlightBytes = 0;
      for (const [id, chat] of wanted) {
        const prev = state.byId.get(id);
        const print = printOf(chat);
        const unchanged = !state.legacy && prev && state.vers.has(id) && !['orphan', 'legacy'].includes(state.vers.get(id))
          && state.prints.get(id) === print && sameChat(prev, chat);
        if (unchanged) { vers.set(id, state.vers.get(id)); prints.set(id, print); continue; }
        vers.set(id, newVersion()); prints.set(id, print);
        inFlight.push(store.setItem(recordKey(listKey, id), chat));
        inFlightBytes += approxChatBytes(chat);
        if (inFlightBytes >= WRITE_BATCH_BYTES) { await Promise.all(inFlight); inFlight = []; inFlightBytes = 0; }
      }
      await Promise.all(inFlight);
      const gone = [...state.byId.keys()].filter(id => !wanted.has(id));
      // The index first, so a crash after it leaves a removed chat unlisted
      // (a cold read would still find it -- harmless, it is merely kept).
      await store.setItem(indexKey(listKey), { v: 1, items: Object.fromEntries(vers) });
      await Promise.all(gone.map(id => store.removeItem(recordKey(listKey, id))));
      // Migrated: the single old value is not needed any more.
      if (state.legacy) { try { await localforage.removeItem(listKey); } catch { /* left behind, unread */ } }
      else if (state.pendingLegacy) {
        // Only if no older-version tab has written it again since it was read.
        try {
          const again = asList(await localforage.getItem(listKey));
          if (newestOf(again) <= state.pendingLegacy) await localforage.removeItem(listKey);
        } catch { /* absorbed again next time */ }
      }
      held.set(listKey, { legacy: false, byId: wanted, vers, prints, list: [...wanted.values()].sort(byNewest) });
      return next;
    } catch (e) {
      held.delete(listKey);
      throw e;
    }
  });
};

/** Make `listKey` hold exactly `list`, writing only the chats that differ. */
export const writeChats = (listKey, list, { legacyWrite } = {}) =>
  updateChats(listKey, () => list, { legacyWrite, legacyRead: () => null });

/** Forget every chat under `listKey`, in either layout. */
export const removeChats = async (listKey) => {
  held.delete(listKey);
  await localforage.removeItem(listKey).catch(() => {});
  if (!split) return;
  await exclusive(listKey, async () => {
    const store = chatsDb();
    const prefix = `${listKey}${SEP}`;
    const keys = (await store.keys()).filter(k => k.startsWith(prefix) || k === indexKey(listKey));
    await Promise.all(keys.map(k => store.removeItem(k)));
    held.delete(listKey);
  });
};

/** The lists kept in the per-chat layout (backups and imports enumerate them). */
export const splitChatLists = async () => {
  if (!split) return [];
  try {
    return (await chatsDb().keys()).filter(k => k.endsWith(INDEX)).map(k => k.slice(0, -INDEX.length));
  } catch { return []; }
};

/** Test hook: drop what this page holds, as a fresh page would. */
export const forgetHeldChats = () => held.clear();
