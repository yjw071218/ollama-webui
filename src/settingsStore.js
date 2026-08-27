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

// Marks a profile whose settings have been seeded, so the inheritance below
// happens once instead of forever.
const SEEDED_PREFIX = 'settingsSeeded';

export const isScopedSetting = (key) =>
  !!key && !NOT_A_SETTING.has(key) && !MACHINE_LOCAL.has(key)
  && !key.startsWith('ollama-sessions') && !key.startsWith('chatFolders')
  && !key.startsWith('samplingPresets') && !key.startsWith('settingsSnapshot')
  && !key.startsWith(SEEDED_PREFIX);

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

const seedMarker = (scope) => `${SEEDED_PREFIX}@${scope}`;

export const isSeeded = (scope) =>
  !scope || localStorage.getItem(seedMarker(scope)) === '1';

/**
 * Give a profile the settings that were in effect when it first appeared.
 *
 * Once, and never again: after this the profile owns its settings outright and
 * nothing another profile does can reach them.
 */
export const seedScope = (scope, fromScope = '') => {
  if (!scope || isSeeded(scope)) return 0;
  const copied = writeScopeSettings(scope, readScopeSettings(fromScope), { onlyMissing: true });
  try { localStorage.setItem(seedMarker(scope), '1'); } catch (e) { /* quota */ }
  return copied;
};

/** Point this tab at a profile. Other tabs are untouched. */
export const setActiveScope = (scope, localUserId = null) => {
  const previous = activeScope;
  activeScope = scope || '';
  // A profile being activated for the first time takes over the setup that was
  // on screen a moment ago, rather than snapping to defaults.
  if (activeScope) seedScope(activeScope, previous);
  const record = { scope: activeScope, localUserId };
  try { globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(record)); } catch (e) {}
  // Only so a *new* tab opens where you left off; existing tabs never read it.
  try { globalThis.localStorage?.setItem(LAST_USED_KEY, JSON.stringify(record)); } catch (e) {}
};

// ------------------------------------------------------------ the accessors

/**
 * Reads only this profile's own value.
 *
 * There is deliberately no fallback to the browser-wide key. Falling back
 * looked like "a new profile inherits the current setup", and it is: once. As a
 * read-time rule it means every profile that has not overridden a setting keeps
 * reading the guest's, so changing something as the guest changes it for all of
 * them. Inheritance happens once, when the profile is first activated.
 */
export const getSetting = (key) => localStorage.getItem(scopedKey(key, activeScope));

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

/**
 * Write settings into a scope.
 *
 * `onlyMissing` is what seeding uses. A profile can already hold settings
 * before it is first activated here — restored from its account on another
 * device, say — and filling in around them is inheritance; writing over them
 * would be losing the very thing that was synced.
 */
export const writeScopeSettings = (scope, settings, { onlyMissing = false } = {}) => {
  let changed = 0;
  for (const [key, value] of Object.entries(settings || {})) {
    if (!isScopedSetting(key)) continue;
    const target = scopedKey(key, scope);
    const current = localStorage.getItem(target);
    if (current === value) continue;
    if (onlyMissing && current !== null) continue;
    try { localStorage.setItem(target, value); changed++; } catch (e) { /* quota */ }
  }
  return changed;
};
