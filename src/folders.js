// Chats were grouped only by date, which stops helping once there are more than
// a screenful. A folder is a named bucket that can also carry its own system
// prompt, so "everything I ask about this project" shares a setup.

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

export const saveFolders = (userId, folders) => {
  try { localStorage.setItem(folderStorageKey(userId), JSON.stringify(folders)); } catch (e) {}
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
