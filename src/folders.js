// Chats were grouped only by date, which stops helping once there are more than
// a screenful. A folder is a named bucket that can also carry its own system
// prompt, so "everything I ask about this project" shares a setup.

import { stampSetting } from './settingsStore.js';

const STORAGE_KEY = 'chatFolders';

let counter = 0;
const nextId = () => `f${Date.now().toString(36)}${(counter++).toString(36)}`;

export const MAX_NAME = 60;

export const newFolder = (name, systemPrompt = '') => ({
  id: nextId(),
  name: String(name || '').trim().slice(0, MAX_NAME) || 'Untitled',
  systemPrompt: String(systemPrompt || ''),
  createdAt: Date.now(),
  collapsed: false,
});

export const folderStorageKey = (userId) =>
  userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;

export const loadFolders = (userId) => {
  try {
    const raw = localStorage.getItem(folderStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(f => f && f.id && typeof f.name === 'string') : [];
  } catch (e) {
    return [];
  }
};

/**
 * Write the folder list, and record when it changed.
 *
 * The stamp is not bookkeeping. The whole list travels to the account as one
 * record, and the sync decides whether this device has anything to say by
 * comparing that record's timestamp with the one it last sent -- so a list
 * written without moving the stamp is a list the sync cannot see has changed.
 *
 * This was missing, and the effect was exact: the first save went up, because
 * there was no previous timestamp to match, and nothing ever did again.
 * Creating, renaming and deleting folders all worked perfectly on the machine
 * doing them and reached no other device, permanently. Deleting was the one
 * that showed: the folder stayed on the phone, and no amount of syncing or
 * reloading removed it, because as far as the account was concerned nothing
 * had happened.
 *
 * The key includes the scope (`chatFolders:srv-abc`), which is what
 * `syncEngine.js` reads it under -- see `keysFor`.
 */
export const saveFolders = (userId, folders) => {
  try {
    localStorage.setItem(folderStorageKey(userId), JSON.stringify(folders));
    stampSetting(userId, folderStorageKey(userId));
  } catch (e) { /* quota, or storage disabled */ }
};

export const renameFolder = (folders, id, name) => {
  const clean = String(name || '').trim().slice(0, MAX_NAME);
  if (!clean) return folders;
  return folders.map(f => (f.id === id ? { ...f, name: clean } : f));
};

export const updateFolder = (folders, id, patch) =>
  folders.map(f => (f.id === id ? { ...f, ...patch, id: f.id } : f));

// Deleting a folder must never delete the chats inside it — they go back to
// being loose, which is what the sidebar shows when folderId does not resolve.
export const removeFolder = (folders, sessions, id) => ({
  folders: folders.filter(f => f.id !== id),
  sessions: sessions.map(s => (s.folderId === id ? { ...s, folderId: null } : s)),
});

export const assignToFolder = (sessions, sessionId, folderId) =>
  sessions.map(s => (s.id === sessionId ? { ...s, folderId: folderId || null } : s));

// A chat whose folder has been deleted elsewhere still has to appear somewhere,
// so membership is decided by what actually resolves, not by the stored id.
export const groupByFolder = (sessions, folders) => {
  const known = new Set(folders.map(f => f.id));
  const buckets = new Map(folders.map(f => [f.id, []]));
  const loose = [];

  for (const session of sessions) {
    if (session.folderId && known.has(session.folderId)) buckets.get(session.folderId).push(session);
    else loose.push(session);
  }

  return {
    grouped: folders.map(folder => ({ folder, sessions: buckets.get(folder.id) })),
    loose,
  };
};

export const folderOf = (session, folders) =>
  folders.find(f => f.id === session?.folderId) || null;
