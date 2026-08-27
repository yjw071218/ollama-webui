// Settings that belong to a profile, and a tab that knows which profile it is.
//
// Two things were wrong and they compound.
//
// Settings were stored under bare names — `systemPrompt`, `theme` — shared by
// every profile in the browser. Snapshotting them at the moment a profile
// changed worked inside one tab and fell apart across two, because both tabs
// write the same keys. Keys are scoped now, so two profiles simply cannot
// collide.
//
// And the signed-in profile lived in localStorage, which the whole origin
// shares, so two tabs could never be two people: whichever signed in last
// dragged the other with it. A tab's session lives in sessionStorage instead,
// seeded once from the last-used profile so opening a new tab still lands you
// where you were.
//
// The guest keeps the bare keys, so an existing install opens with everything
// exactly where it left it.

const SESSION_KEY = 'webui-tab-session';
const LAST_USED_KEY = 'webui-last-profile';

// Names a file or a device on this computer, so it is the same whoever is
// signed in and is deliberately not scoped.
const MACHINE_LOCAL = new Set(['ttsRefAudio']);

// Not settings: identity, other profiles' stores, and the app's own bookkeeping.
const NOT_A_SETTING = new Set([
  'ollama-sessions', 'ollama-users', 'ollama-auth-session',
  SESSION_KEY, LAST_USED_KEY,
]);

export const isScopedSetting = (key) =>
  !!key && !NOT_A_SETTING.has(key) && !MACHINE_LOCAL.has(key)
  && !key.startsWith('ollama-sessions') && !key.startsWith('chatFolders')
  && !key.startsWith('samplingPresets') && !key.startsWith('settingsSnapshot');

/**
 * Where a setting is stored for a given profile.
 *
 * The guest keeps the bare name. That is not only for tidiness: every install
 * that existed before this has its settings under bare keys, and the guest is
 * who they belong to.
 */
export const scopedKey = (key, scope) =>
  (scope && isScopedSetting(key)) ? `${key}@${scope}` : key;

// ---------------------------------------------------------------- the scope

let activeScope = '';

const readJson = (storage, key) => {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

/**
 * The profile this tab is showing, decided once at boot.
 *
 * Read synchronously so the settings that React reads while first rendering are
 * already the right profile's. A tab with no session of its own inherits the
 * last one used in this browser, so opening a new tab is not a surprise.
 */
export const bootScope = () => {
  const own = readJson(globalThis.sessionStorage, SESSION_KEY);
  if (own) {
    activeScope = own.scope || '';
    return { scope: activeScope, localUserId: own.localUserId || null, adopted: false };
  }

  const last = readJson(globalThis.localStorage, LAST_USED_KEY) || {};
  activeScope = last.scope || '';
  // Recorded for this tab so it stops following the rest of the browser.
  try {
    globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(last));
  } catch (e) { /* private mode */ }
  return { scope: activeScope, localUserId: last.localUserId || null, adopted: true };
};

export const getActiveScope = () => activeScope;

/** Point this tab at a profile. Other tabs are untouched. */
export const setActiveScope = (scope, localUserId = null) => {
  activeScope = scope || '';
  const record = { scope: activeScope, localUserId };
  try { globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(record)); } catch (e) {}
  // Only so a *new* tab opens where you left off; existing tabs never read it.
  try { globalThis.localStorage?.setItem(LAST_USED_KEY, JSON.stringify(record)); } catch (e) {}
};

// ------------------------------------------------------------ the accessors

export const getSetting = (key) => {
  const scoped = scopedKey(key, activeScope);
  const value = localStorage.getItem(scoped);
  if (value !== null || scoped === key) return value;

  // First time this profile reads a setting it has never written: fall back to
  // the browser-wide value so a new profile starts from the current setup
  // rather than from defaults, which is what people expect on a first sign-in.
  return localStorage.getItem(key);
};

export const setSetting = (key, value) => {
  try { localStorage.setItem(scopedKey(key, activeScope), value); } catch (e) { /* quota */ }
};

export const removeSetting = (key) => {
  try { localStorage.removeItem(scopedKey(key, activeScope)); } catch (e) {}
};

/** Every setting belonging to a scope, for sync and backup. */
export const readScopeSettings = (scope) => {
  const out = {};
  const suffix = scope ? `@${scope}` : '';
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (scope) {
      if (!key.endsWith(suffix)) continue;
      const bare = key.slice(0, -suffix.length);
      if (!isScopedSetting(bare)) continue;
      out[bare] = localStorage.getItem(key);
    } else {
      if (!isScopedSetting(key) || key.includes('@')) continue;
      out[key] = localStorage.getItem(key);
    }
  }
  return out;
};

export const writeScopeSettings = (scope, settings) => {
  let changed = 0;
  for (const [key, value] of Object.entries(settings || {})) {
    if (!isScopedSetting(key)) continue;
    const target = scopedKey(key, scope);
    if (localStorage.getItem(target) === value) continue;
    try { localStorage.setItem(target, value); changed++; } catch (e) { /* quota */ }
  }
  return changed;
};
