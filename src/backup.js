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
//
// There used to be a fifth: an 'auth' store holding browser-local accounts,
// password hashes and passkey public keys. Accounts live on the server now, so
// a backup no longer carries credentials at all — which is the right shape for
// a file people email to themselves.

import localforage from 'localforage';
import { readScopeSettings, writeScopeSettings, isScopedSetting } from './settingsStore.js';

export const BACKUP_VERSION = 3;

const named = (storeName) => localforage.createInstance({ name: 'ollama-webui', storeName });

// The default instance is where sessions live; localforage's own default
// database name is used for it, so it is addressed differently from the rest.
const SESSION_PREFIX = 'ollama-sessions';

// Settings that describe *this* machine rather than the user's preferences.
// Carrying them to another device would point it at the wrong paths.
const MACHINE_LOCAL = new Set(['ttsRefAudio']);

// `onlyKey` keeps one profile's entry and drops every other profile's, which is
// what makes a sync payload contain one person's data.
const dumpStore = async (store, onlyKey = null) => {
  const out = {};
  await store.iterate((value, key) => {
    if (onlyKey && key !== onlyKey) return;
    out[key] = value;
  });
  return out;
};



// Keys that belong to one profile, in the stores that are shared between them.
const scopedKeys = (scope) => ({
  sessions: scope ? `${SESSION_PREFIX}:${scope}` : SESSION_PREFIX,
  knowledge: `knowledge:${scope || 'guest'}`,
  memory: `memory:${scope || 'guest'}`,
  folders: scope ? `chatFolders:${scope}` : 'chatFolders',
  presets: scope ? `samplingPresets:${scope}` : 'samplingPresets',
});

/**
 * Everything, ready to be written to a file.
 *
 * `scope` limits it to one account. Sync always passes one: the stores are
 * shared between accounts on a machine, so gathering them wholesale would
 * publish the guest's chats and anyone else's alongside the account's, and put
 * them on every other device. A file backup with no scope still takes
 * everything, which is what "back up this browser" should mean.
 *
 * `ownerId` stamps the payload with the account it belongs to. A sync payload
 * always carries one and is refused at both ends without it matching; a file
 * backup leaves it null, because a file belongs to whoever is holding it.
 */
export const collectBackup = async ({
  includeMachineSettings = false, primaryKey = '', scope = null, ownerId = null,
} = {}) => {
  const only = scope === null ? null : scopedKeys(scope);
  // Settings are stored per profile, so this is a lookup rather than a filter.
  // An unscoped backup still sweeps the browser, which is what backing up a
  // browser means.
  const settings = {};
  if (only) {
    Object.assign(settings, readScopeSettings(scope));
    // Folders and presets keep their own suffixed keys; take just this one's.
    for (const key of [only.folders, only.presets]) {
      const value = localStorage.getItem(key);
      if (value !== null) settings[key] = value;
    }
  } else {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!includeMachineSettings && MACHINE_LOCAL.has(key)) continue;
      settings[key] = localStorage.getItem(key);
    }
  }

  // Chats sit in the default store under one key per profile.
  const sessions = {};
  await localforage.iterate((value, key) => {
    if (only) { if (key === only.sessions) sessions[key] = value; return; }
    if (key === SESSION_PREFIX || key.startsWith(`${SESSION_PREFIX}:`)) sessions[key] = value;
  });

  const backup = {
    kind: 'ollama-webui-backup',
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    origin: typeof location !== 'undefined' ? location.origin : '',
    // Which of the session buckets belongs to whoever made this, so a device
    // that keys the same account differently still knows which bucket to read.
    primaryKey: primaryKey || null,
    // The account this belongs to. A sync payload is refused at both ends when
    // this disagrees with the session, which is what stops one person's chats
    // being filed under another person's name.
    ownerId: ownerId || null,
    settings,
    sessions,
    knowledge: await dumpStore(named('knowledge'), only && only.knowledge),
    memory: await dumpStore(named('memory'), only && only.memory),
  };

  return backup;
};

export const describeBackup = (backup) => ({
  chats: Object.values(backup?.sessions || {}).reduce((n, list) => n + (list?.length || 0), 0),
  profiles: Object.keys(backup?.sessions || {}).length,
  settings: Object.keys(backup?.settings || {}).length,
  documents: Object.keys(backup?.knowledge || {}).length,
  memories: Object.values(backup?.memory || {}).reduce((n, list) => n + (list?.length || 0), 0),
  createdAt: backup?.createdAt || null,
  origin: backup?.origin || '',
  ownerId: backup?.ownerId || null,
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
  mode = 'merge', primaryKey = '', settingsWin = false,
} = {}) => {
  if (!isBackup(backup)) throw new Error('That file is not an Ollama WebUI backup.');
  if (backup.version > BACKUP_VERSION) {
    throw new Error(`That backup was written by a newer version (${backup.version}).`);
  }

  const replace = mode === 'replace';
  const restored = { settings: 0, chats: 0, documents: 0, memories: 0, remapped: null };

  // Settings are not a set to union. Every one of them already exists locally,
  // because the app writes its defaults on startup — so "keep what is here"
  // meant nothing was ever applied. When the account is the source of truth
  // (a sync pull) its values win; a restore from a file stays conservative.
  const settingsOverwrite = replace || settingsWin;
  const scope = primaryKey && primaryKey.startsWith(`${SESSION_PREFIX}:`)
    ? primaryKey.slice(SESSION_PREFIX.length + 1)
    : '';

  for (const [key, value] of Object.entries(backup.settings || {})) {
    if (MACHINE_LOCAL.has(key)) continue;   // names a path on one machine

    // A scoped setting has to land where that profile reads it, or it is
    // written into the browser-wide slot and every profile inherits it.
    if (isScopedSetting(key)) {
      if (!settingsOverwrite) {
        const existing = readScopeSettings(scope);
        if (key in existing) continue;
      }
      restored.settings += writeScopeSettings(scope, { [key]: value });
      continue;
    }

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

    // What actually changed, not what arrived. The caller reloads the page when
    // this is non-zero, so counting every incoming chat every time would mean
    // reloading forever against an account that is already in sync.
    const before = JSON.stringify(existing || []);
    const after = JSON.stringify(merged);
    if (before !== after) {
      await localforage.setItem(target, merged);
      restored.chats += Math.max(merged.length - (existing?.length || 0), 1);
    }
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

  // A version 2 backup carries an `auth` store of browser-local accounts. It is
  // deliberately ignored: those accounts no longer exist, and restoring
  // password hashes for a login that was removed would put credentials back on
  // disk for nothing.

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
