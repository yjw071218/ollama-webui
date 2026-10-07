/**
 * The chats a page was still holding when it went away, written where the next
 * page can read them at once.
 *
 * Leaving writes what the save timer has not yet (see the flush in App.jsx),
 * but that write is IndexedDB, and IndexedDB is asynchronous: a refresh starts
 * the next page while the old one's write is still in flight, and the new page
 * read the store before it landed. The last answer, the last edit, were simply
 * not there -- and a second refresh, by which time the write had finished,
 * showed them. That is "it takes two refreshes to refresh properly".
 *
 * localStorage is synchronous, so what is written here on the way out is there
 * when the next page starts. It holds only the few chats most recently
 * changed, bounded in size, and is cleared as soon as it has been read.
 */

const MAX_CHATS = 4;
const MAX_BYTES = 1.5 * 1024 * 1024;

const journalKey = (storageKey) => `unloadJournal:${storageKey}`;

/** Write the most recently changed chats. Never throws. */
export const writeJournal = (storageKey, chats, prepare = (chat) => chat) => {
  try {
    const recent = (chats || [])
      .filter(chat => chat && chat.id != null && Array.isArray(chat.messages) && chat.messages.length)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_CHATS);
    const kept = [];
    let bytes = 0;
    for (const chat of recent) {
      const text = JSON.stringify(prepare(chat));
      if (bytes + text.length > MAX_BYTES) continue;
      bytes += text.length;
      kept.push(text);
    }
    if (!kept.length) return false;
    localStorage.setItem(journalKey(storageKey), `{"at":${Date.now()},"chats":[${kept.join(',')}]}`);
    return true;
  } catch (e) {
    return false; // quota, private mode: the IndexedDB write still runs
  }
};

/** Read and clear: `{ at, chats }`. Journals older than a day are stale and dropped. */
export const takeJournal = (storageKey, now = Date.now()) => {
  const none = { at: 0, chats: [] };
  try {
    const raw = localStorage.getItem(journalKey(storageKey));
    if (!raw) return none;
    localStorage.removeItem(journalKey(storageKey));
    const parsed = JSON.parse(raw);
    const at = Number(parsed?.at || 0);
    if (!parsed || now - at > 24 * 60 * 60 * 1000) return none;
    return { at, chats: Array.isArray(parsed.chats) ? parsed.chats : [] };
  } catch (e) {
    return none;
  }
};

/* A chat storage does not have is added back only if it was new when the page
   left -- started in the last few minutes, so the write that would have saved
   it is the one that lost the race. An older one missing from storage was
   deleted (here, in another tab, or on another device), and bringing it back
   would undo that. */
const NEW_CHAT_MS = 10 * 60 * 1000;

/**
 * The stored list with the journal laid over it: a journalled chat replaces
 * its stored copy only when it is newer, and is added when storage never got
 * it at all. Returns the same array when nothing changed.
 */
export const withJournal = (stored, { at: leftAt = 0, chats = [] } = {}) => {
  if (!chats.length) return stored;
  const list = [...(stored || [])];
  let changed = false;
  for (const chat of chats) {
    if (!chat || chat.id == null) continue;
    const at = list.findIndex(x => String(x?.id) === String(chat.id));
    if (at === -1) {
      if (leftAt - (Number(chat.createdAt) || 0) > NEW_CHAT_MS) continue;
      list.push(chat);
      changed = true;
      continue;
    }
    if ((chat.updatedAt || 0) > (list[at].updatedAt || 0)) { list[at] = chat; changed = true; }
  }
  if (!changed) return stored;
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};
