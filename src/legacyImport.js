// Bringing forward what the old account system left behind.
//
// Before identity moved to the server, this app kept accounts in the browser:
// a user table in IndexedDB, and one bucket of chats per local profile. Those
// accounts are gone — they were never verifiable and were the direct cause of
// data landing in the wrong place — but the chats under them are not, and
// deleting somebody's history because the login was rebuilt would be a poor
// trade.
//
// So the buckets are found, labelled with whatever the old user table called
// them, and offered once. Two rules, both deliberate:
//
//   * Offered, never automatic. On a shared computer, silently folding
//     whatever is lying around into the first account that signs in hands one
//     person another person's chats — which is the exact failure this whole
//     rework is about, arriving through the front door.
//   * Copy, then mark. The source is left where it is, so a mistaken import
//     costs nothing and the guest keeps being the guest.

import localforage from 'localforage';
import { readScopeSettings, writeScopeSettings, stampSetting } from './settingsStore.js';

const SESSION_PREFIX = 'ollama-sessions';
const OFFERED_KEY = 'legacyImportOffered';
const IMPORTED_MARK = 'legacyImportedFrom';

const named = (storeName) => localforage.createInstance({ name: 'ollama-webui', storeName });

/** The scope a session bucket belongs to, or '' for the guest's. */
const scopeOfBucket = (key) => (
  key === SESSION_PREFIX ? '' : key.slice(SESSION_PREFIX.length + 1)
);

/**
 * The names the old browser-local accounts went by.
 *
 * Read for labels only. Nothing in that table is ever treated as a login again,
 * and `purgeLegacyCredentials` strips the parts that were.
 */
const legacyNames = async () => {
  try {
    const users = await named('auth').getItem('ollama-users');
    const out = new Map();
    for (const user of users || []) out.set(user.id, user.name || user.email || '');
    return out;
  } catch (e) {
    return new Map();
  }
};

/**
 * Buckets in this browser that belong to no current account.
 *
 * A `srv-` bucket is a server account's and is reached by signing into it, so
 * it is never a candidate. Everything else is either the guest's or an orphan
 * of the old system.
 */
export const findLegacyData = async ({ currentScope = null } = {}) => {
  const names = await legacyNames();
  const found = [];

  await localforage.iterate((value, key) => {
    if (key !== SESSION_PREFIX && !key.startsWith(`${SESSION_PREFIX}:`)) return;
    const scope = scopeOfBucket(key);
    if (scope.startsWith('srv-')) return;         // belongs to a real account
    if (scope === currentScope) return;
    const chats = Array.isArray(value) ? value.length : 0;
    if (!chats) return;
    found.push({
      key,
      scope,
      chats,
      guest: scope === '',
      label: scope === '' ? '' : (names.get(scope) || ''),
      updatedAt: Math.max(0, ...(value || []).map(s => s.updatedAt || 0)),
    });
  });

  return found.sort((a, b) => b.updatedAt - a.updatedAt);
};

/** Whether this account has already been asked about legacy data here. */
export const wasOffered = (scope) => {
  try {
    return localStorage.getItem(`${OFFERED_KEY}@${scope}`) === '1';
  } catch (e) {
    return true;   // private mode: asking on every load would be worse
  }
};

export const markOffered = (scope) => {
  try { localStorage.setItem(`${OFFERED_KEY}@${scope}`, '1'); } catch (e) { /* quota */ }
};

// Chats are merged by id, so importing twice cannot duplicate anything and a
// genuine collision keeps whichever was touched last.
const mergeSessions = (existing, incoming) => {
  const byId = new Map((existing || []).map(s => [s.id, s]));
  for (const session of incoming || []) {
    const current = byId.get(session.id);
    if (!current || (session.updatedAt || 0) >= (current.updatedAt || 0)) byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};

/**
 * Copy one legacy bucket into the signed-in account.
 *
 * Everything that hangs off a scope comes with it: chats, the knowledge base,
 * memories, folders, presets and settings. Settings fill in around what the
 * account already has rather than overwriting it — the account's own setup was
 * chosen more recently than a bucket nobody has opened since the rebuild.
 */
export const importLegacyBucket = async (fromScope, toScope) => {
  if (!toScope) throw new Error('There is no account to import into.');
  if (fromScope === toScope) throw new Error('That is already this account.');

  const sourceKey = fromScope ? `${SESSION_PREFIX}:${fromScope}` : SESSION_PREFIX;
  const targetKey = `${SESSION_PREFIX}:${toScope}`;
  const imported = { chats: 0, documents: 0, memories: 0, settings: 0 };

  const incoming = (await localforage.getItem(sourceKey)) || [];
  if (incoming.length) {
    const existing = (await localforage.getItem(targetKey)) || [];
    const merged = mergeSessions(existing, incoming);
    await localforage.setItem(targetKey, merged);
    imported.chats = merged.length - existing.length;
  }

  const knowledge = named('knowledge');
  const sourceDocs = (await knowledge.getItem(`knowledge:${fromScope || 'guest'}`)) || [];
  if (sourceDocs.length) {
    const existing = (await knowledge.getItem(`knowledge:${toScope}`)) || [];
    const seen = new Set(existing.map(d => d.id));
    const merged = [...existing, ...sourceDocs.filter(d => !seen.has(d.id))];
    await knowledge.setItem(`knowledge:${toScope}`, merged);
    imported.documents = merged.length - existing.length;
  }

  const memory = named('memory');
  const sourceMemories = (await memory.getItem(`memory:${fromScope || 'guest'}`)) || [];
  if (sourceMemories.length) {
    const existing = (await memory.getItem(`memory:${toScope}`)) || [];
    const seen = new Set(existing.map(m => m.id));
    const merged = [...existing, ...sourceMemories.filter(m => !seen.has(m.id))];
    await memory.setItem(`memory:${toScope}`, merged);
    imported.memories = merged.length - existing.length;
  }

  // Folders and presets keep suffixed keys of their own rather than going
  // through the settings scope, so they are moved by name.
  for (const base of ['chatFolders', 'samplingPresets']) {
    const from = fromScope ? `${base}:${fromScope}` : base;
    const to = `${base}:${toScope}`;
    const value = localStorage.getItem(from);
    if (value === null || localStorage.getItem(to) !== null) continue;
    try { localStorage.setItem(to, value); imported.settings++; } catch (e) { /* quota */ }
  }

  const carried = readScopeSettings(fromScope);
  imported.settings += writeScopeSettings(toScope, carried, { onlyMissing: true });
  // Stamped as of now: these values are being chosen for this account at this
  // moment, and an unstamped setting reads as older than everything and loses
  // every conflict it ever takes part in.
  for (const key of Object.keys(carried)) stampSetting(toScope, key);

  // Recorded on the target, so the same bucket is not offered again and so
  // there is a trace of where an account's early history came from.
  try {
    const previous = JSON.parse(localStorage.getItem(`${IMPORTED_MARK}@${toScope}`) || '[]');
    localStorage.setItem(
      `${IMPORTED_MARK}@${toScope}`,
      JSON.stringify([...new Set([...previous, fromScope || '(guest)'])]),
    );
  } catch (e) { /* quota */ }

  return imported;
};

/** Which buckets this account has already taken, so they stop being offered. */
export const alreadyImported = (scope) => {
  try {
    return new Set(JSON.parse(localStorage.getItem(`${IMPORTED_MARK}@${scope}`) || '[]'));
  } catch (e) {
    return new Set();
  }
};

/**
 * Remove what the old login left on disk that was never safe to keep.
 *
 * Password hashes and passkey public keys for an account system that no longer
 * exists are pure liability: nothing can authenticate against them, and they
 * are still material scraped out of an unlocked browser profile. The names stay
 * so the import offer can still label a bucket.
 */
export const purgeLegacyCredentials = async () => {
  try {
    const auth = named('auth');
    const users = await auth.getItem('ollama-users');
    if (Array.isArray(users)) {
      await auth.setItem('ollama-users', users.map(u => ({ id: u.id, name: u.name || '' })));
    }
    await auth.removeItem('ollama-auth-session');
  } catch (e) {
    // Best effort. A browser that will not let us clean up is not a reason to
    // fail a sign-in.
  }
  try { localStorage.removeItem('ollama-auth-session'); } catch (e) { /* private mode */ }
};
