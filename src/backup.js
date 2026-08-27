// Everything this app remembers lives in the browser, and the browser scopes it
// all to the origin. http://localhost:5173 and http://192.168.1.9:5173 are
// different origins, so opening the same app on a phone starts from nothing —
// and serving it on a different port hides what the old port saved.
//
// Nothing is lost when that happens, but nothing is reachable either. This
// gathers the whole state into one file and puts it back somewhere else.
//
// The pieces are spread across five stores:
//
//   localStorage                      settings, and which profile is signed in
//   localforage default store         chats, keyed per profile
//   localforage 'knowledge'           RAG documents and their embeddings
//   localforage 'memory'              cross-chat memories
//   localforage 'auth'                accounts (password hashes, passkeys)

import localforage from 'localforage';

export const BACKUP_VERSION = 2;

const named = (storeName) => localforage.createInstance({ name: 'ollama-webui', storeName });

// The default instance is where sessions live; localforage's own default
// database name is used for it, so it is addressed differently from the rest.
const SESSION_PREFIX = 'ollama-sessions';

// Settings that describe *this* machine rather than the user's preferences.
// Carrying them to another device would point it at the wrong paths.
const MACHINE_LOCAL = new Set(['ttsRefAudio']);

const dumpStore = async (store) => {
  const out = {};
  await store.iterate((value, key) => { out[key] = value; });
  return out;
};

/** Everything, ready to be written to a file. */
export const collectBackup = async ({
  includeAccounts = true, includeMachineSettings = false, primaryKey = '',
} = {}) => {
  const settings = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (!includeMachineSettings && MACHINE_LOCAL.has(key)) continue;
    settings[key] = localStorage.getItem(key);
  }

  // Chats sit in the default store under one key per profile.
  const sessions = {};
  await localforage.iterate((value, key) => {
    if (key === SESSION_PREFIX || key.startsWith(`${SESSION_PREFIX}:`)) sessions[key] = value;
  });

  const backup = {
    kind: 'ollama-webui-backup',
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    origin: typeof location !== 'undefined' ? location.origin : '',
    // Which of the session buckets belongs to whoever made this. Profile ids
    // are random per browser, so the same person signing in on a second device
    // gets a different key and would otherwise read an empty bucket while their
    // chats sat in one nothing ever looked at.
    primaryKey: primaryKey || null,
    settings,
    sessions,
    knowledge: await dumpStore(named('knowledge')),
    memory: await dumpStore(named('memory')),
  };

  // Accounts hold password hashes and passkey public keys. Useful when moving
  // to a new device, and not something to hand out by accident.
  if (includeAccounts) backup.auth = await dumpStore(named('auth'));

  return backup;
};

export const describeBackup = (backup) => ({
  chats: Object.values(backup?.sessions || {}).reduce((n, list) => n + (list?.length || 0), 0),
  profiles: Object.keys(backup?.sessions || {}).length,
  settings: Object.keys(backup?.settings || {}).length,
  documents: Object.keys(backup?.knowledge || {}).length,
  memories: Object.values(backup?.memory || {}).reduce((n, list) => n + (list?.length || 0), 0),
  accounts: Array.isArray(backup?.auth?.['ollama-users']) ? backup.auth['ollama-users'].length : 0,
  createdAt: backup?.createdAt || null,
  origin: backup?.origin || '',
});

export const isBackup = (data) =>
  !!data && data.kind === 'ollama-webui-backup' && typeof data.version === 'number';

// Chats are merged by id so restoring twice, or onto a device that has its own
// history, does not throw anything away. Newer wins on a genuine collision.
const mergeSessions = (existing, incoming) => {
  const byId = new Map((existing || []).map(s => [s.id, s]));
  for (const session of incoming || []) {
    const current = byId.get(session.id);
    if (!current || (session.updatedAt || 0) >= (current.updatedAt || 0)) byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};

/**
 * Put a backup back.
 *
 * `mode: 'merge'` keeps whatever is already here and adds what is missing;
 * `mode: 'replace'` makes this origin match the backup exactly. Merge is the
 * default because the destructive one should be asked for.
 */
export const restoreBackup = async (backup, {
  mode = 'merge', includeAccounts = true, primaryKey = '', settingsWin = false,
} = {}) => {
  if (!isBackup(backup)) throw new Error('That file is not an Ollama WebUI backup.');
  if (backup.version > BACKUP_VERSION) {
    throw new Error(`That backup was written by a newer version (${backup.version}).`);
  }

  const replace = mode === 'replace';
  const restored = { settings: 0, chats: 0, documents: 0, memories: 0, accounts: 0, remapped: null };

  // Settings are not a set to union. Every one of them already exists locally,
  // because the app writes its defaults on startup — so "keep what is here"
  // meant nothing was ever applied. When the account is the source of truth
  // (a sync pull) its values win; a restore from a file stays conservative.
  const settingsOverwrite = replace || settingsWin;
  for (const [key, value] of Object.entries(backup.settings || {})) {
    if (MACHINE_LOCAL.has(key)) continue;   // names a path on one machine
    const current = localStorage.getItem(key);
    if (!settingsOverwrite && current !== null) continue;
    if (current === value) continue;
    try { localStorage.setItem(key, value); restored.settings++; } catch (e) { /* quota */ }
  }

  // The backup's owner has a profile id from the browser that made it, and this
  // browser gave the same person a different random one. Without redirecting
  // that one bucket the chats land under a key nothing here ever reads.
  const rename = (key) =>
    (primaryKey && backup.primaryKey && key === backup.primaryKey) ? primaryKey : key;

  for (const [key, incoming] of Object.entries(backup.sessions || {})) {
    const target = rename(key);
    const existing = replace ? [] : await localforage.getItem(target);
    const merged = mergeSessions(existing, incoming);
    await localforage.setItem(target, merged);
    restored.chats += (incoming || []).length;
    if (target !== key) restored.remapped = { from: key, to: target };
  }

  const knowledge = named('knowledge');
  for (const [key, value] of Object.entries(backup.knowledge || {})) {
    if (!replace && (await knowledge.getItem(key)) !== null) continue;
    await knowledge.setItem(key, value);
    restored.documents++;
  }

  const memory = named('memory');
  for (const [key, value] of Object.entries(backup.memory || {})) {
    const existing = replace ? null : await memory.getItem(key);
    if (Array.isArray(existing) && Array.isArray(value)) {
      const seen = new Set(existing.map(m => m.id));
      const merged = [...existing, ...value.filter(m => !seen.has(m.id))];
      await memory.setItem(key, merged);
      restored.memories += merged.length - existing.length;
    } else {
      await memory.setItem(key, value);
      restored.memories += Array.isArray(value) ? value.length : 0;
    }
  }

  if (includeAccounts && backup.auth) {
    const auth = named('auth');
    for (const [key, value] of Object.entries(backup.auth)) {
      if (key === 'ollama-users' && !replace) {
        const existing = (await auth.getItem(key)) || [];
        const seen = new Set(existing.map(u => u.id));
        const merged = [...existing, ...(value || []).filter(u => !seen.has(u.id))];
        await auth.setItem(key, merged);
        restored.accounts += merged.length - existing.length;
        continue;
      }
      await auth.setItem(key, value);
      if (key === 'ollama-users') restored.accounts += (value || []).length;
    }
  }

  return restored;
};

/**
 * A fingerprint of the settings this browser holds.
 *
 * Auto-sync needs to know when anything changed, and there are around fifty
 * settings spread across as many pieces of React state. Listing them all in a
 * dependency array is the kind of thing that silently misses the fifty-first,
 * so the stored values are read directly instead — it is a few dozen
 * localStorage reads and costs nothing at the interval this runs on.
 */
export const settingsFingerprint = () => {
  const parts = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || MACHINE_LOCAL.has(key)) continue;
    parts.push(`${key}=${localStorage.getItem(key)}`);
  }
  return parts.sort().join(' ');
};
