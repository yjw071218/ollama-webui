// Settings that belong to an account.
//
// Two things used to be wrong here and they compounded.
//
// Settings were stored under bare names — `systemPrompt`, `theme` — shared by
// every profile in the browser, so two people on one machine overwrote each
// other continuously. Keys carry the scope now, and two accounts simply cannot
// collide.
//
// And this file used to *decide* the scope, at boot, by reading a record out of
// sessionStorage and falling back to a browser-wide one. It had to, because
// identity was a client-side notion and there was nothing else to ask. That is
// what produced the split-brain: this guess was available instantly, the
// server's answer arrived a round trip later, and anything written in between
// went into whichever bucket the guess had named.
//
// It no longer decides anything. The session provider asks the server who is
// signed in and calls setActiveScope once, before the app renders.
//
// The third thing this file now does is remember *when* each setting last
// changed. Sync resolves conflicts per record by timestamp, and a setting with
// no timestamp cannot take part in that: two devices would fall back to
// comparing values, which cannot tell a change from a stale copy. The stamps
// are what let a phone and a laptop each change a different setting and both
// changes survive.

// Names a file or a device on this computer, so it is the same whoever is
// signed in and is deliberately not scoped, nor synced.
const MACHINE_LOCAL = new Set(['ttsRefAudio']);

// Not settings: other scopes' stores, and the app's own bookkeeping.
const NOT_A_SETTING = new Set([
  'ollama-sessions',
  // Left by the account system that used to live in the browser. Never synced,
  // never read as a login again.
  'ollama-users', 'ollama-auth-session',
  'webui-tab-session', 'webui-last-profile',
]);

// Prefixes of keys that carry their own scope suffix, or that record something
// *about* a scope rather than being a setting in it. Without this, a key like
// `syncRev@srv-x` reads back as a setting called `syncRev` belonging to srv-x,
// and then syncs itself to every device.
const NOT_A_SETTING_PREFIX = [
  'ollama-sessions', 'chatFolders', 'samplingPresets', 'systemPrompts', 'settingsSnapshot',
  // Who is asking. Scoped as `userProfile:<scope>`, like the lists above it,
  // and it was missing from this list — so the guest's sweep, which takes every
  // bare key with no `@` in it, was picking up *every* account's profile and
  // syncing them all as the guest's own settings.
  'userProfile',
  'settingsSeeded', 'legacyImportOffered', 'legacyImportedFrom',
  /* Whether this browser has had its context defaults raised. A fact about
     this install, not a preference — syncing it would mean a phone that had
     already been raised telling a desktop it had been too, and the desktop
     keeping its cut-off answers. */
  'ctxDefaultsRaised',
  'settingStamps', 'syncRev', 'syncSent',
  // Half-typed messages. They belong to this browser and this moment, not to
  // the account: syncing them would upload on every keystroke, and a draft
  // arriving on another device would overwrite whatever was being typed there.
  'chatDrafts',
  // Timings from this machine's GPU. Syncing them would average a laptop's
  // numbers together with a desktop's and describe neither.
  'perfRuns',
  /* The Studio's saved form and its gallery. Both carry their own `:scope`
     suffix and both are synced as whole-list records of their own, so the
     settings sweep must not also pick them up as bare settings — that is how
     `userProfile` came to be uploaded once per account by the guest. */
  'studioSettings', 'studioHistory',
  /* What the image classifier said about pictures seen in this browser. A
     cache, keyed by URL and by hashes of pictures — not a preference, and
     re-derivable anywhere. Studio jobs carry their own verdict, synced with
     the job. */
  'nsfwVerdicts',
];

export const isScopedSetting = (key) =>
  !!key
  && !NOT_A_SETTING.has(key)
  && !MACHINE_LOCAL.has(key)
  && !NOT_A_SETTING_PREFIX.some(prefix => key.startsWith(prefix));

/**
 * Where a setting is stored for a given scope.
 *
 * The guest keeps the bare name. That is not only for tidiness: every install
 * that existed before any of this has its settings under bare keys, and the
 * guest — the signed-out state of this browser — is who they belong to.
 */
export const scopedKey = (key, scope) =>
  (scope && isScopedSetting(key)) ? `${key}@${scope}` : key;

// ---------------------------------------------------------------- the scope

let activeScope = '';

export const getActiveScope = () => activeScope;

/**
 * Point this browser at an account's settings.
 *
 * Called once per identity, by the session provider, before anything renders.
 * There is deliberately no inheritance from whatever scope was active a moment
 * ago: an account is portable and a browser is not, so seeding one from the
 * other makes an account's setup depend on which machine first signed into it —
 * the same class of leak between identities that the rest of this rework
 * removes, just wearing a friendlier hat.
 */
export const setActiveScope = (scope) => {
  activeScope = scope || '';
  return activeScope;
};

// ------------------------------------------------------------- the stamps

const stampsKey = (scope) => `settingStamps@${scope || 'guest'}`;

/** When each of a scope's settings last changed here, as `key -> epoch ms`. */
export const settingStamps = (scope) => {
  try {
    return JSON.parse(localStorage.getItem(stampsKey(scope)) || '{}');
  } catch (e) {
    return {};
  }
};

const writeStamps = (scope, stamps) => {
  try { localStorage.setItem(stampsKey(scope), JSON.stringify(stamps)); } catch (e) { /* quota */ }
};

/**
 * Record when a setting changed.
 *
 * `at` is passed explicitly when the value came from another device, so the
 * stamp is the one that travelled with it rather than the moment it arrived —
 * otherwise every download would look like the newest edit and win every
 * subsequent conflict.
 */
export const stampSetting = (scope, key, at = Date.now()) => {
  const stamps = settingStamps(scope);
  stamps[key] = at;
  writeStamps(scope, stamps);
};

export const forgetSettingStamp = (scope, key) => {
  const stamps = settingStamps(scope);
  if (!(key in stamps)) return;
  delete stamps[key];
  writeStamps(scope, stamps);
};

/** Drop a scope's stamps, so its next sync treats everything as new. */
export const clearSettingStamps = (scope) => {
  try { localStorage.removeItem(stampsKey(scope)); } catch (e) { /* private mode */ }
};

// ------------------------------------------------------------ the accessors

/**
 * Reads only this account's own value.
 *
 * There is deliberately no fallback to the browser-wide key. Falling back means
 * every account that has not overridden a setting reads the guest's, so
 * changing something while signed out changes it for all of them.
 */
export const getSetting = (key) => {
  try {
    return localStorage.getItem(scopedKey(key, activeScope));
  } catch (e) {
    return null;   // private mode with storage disabled
  }
};

/**
 * Writes it, and records when.
 *
 * The stamp is not optional bookkeeping: it is what the account uses to decide
 * whose version of this setting is newer when two devices have both touched it.
 */
export const setSetting = (key, value) => {
  try {
    const target = scopedKey(key, activeScope);
    if (localStorage.getItem(target) === String(value)) return;   // no real change
    localStorage.setItem(target, value);
    if (isScopedSetting(key)) stampSetting(activeScope, key);
  } catch (e) { /* quota */ }
};

export const removeSetting = (key) => {
  try {
    localStorage.removeItem(scopedKey(key, activeScope));
    forgetSettingStamp(activeScope, key);
  } catch (e) { /* private mode */ }
};

/** Remove a key belonging to a scope other than the active one. */
export const removeScopedKey = (scope, key) => {
  try { localStorage.removeItem(scopedKey(key, scope)); } catch (e) { /* private mode */ }
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
      // The guest's are the bare keys, so anything carrying a scope suffix
      // belongs to somebody else.
      if (!isScopedSetting(key) || key.includes('@')) continue;
      out[key] = localStorage.getItem(key);
    }
  }
  return out;
};

/**
 * Write settings into a scope.
 *
 * `onlyMissing` is what the legacy import uses: an account can already hold
 * settings — synced from another device, say — and filling in around them is
 * importing, while writing over them would be losing the very thing that came
 * down.
 *
 * Deliberately does not stamp. Callers know whether the value is a local edit
 * (stamp it now) or one that arrived from the account (stamp it with the time
 * it carried), and guessing here would make every download look like the newest
 * edit on this device.
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

/**
 * Forget everything an account cached in this browser.
 *
 * Signing out on a shared computer should not leave the account's settings
 * sitting in localStorage for the next person to read, and a stale cache is
 * also how a later sign-in can appear to show the wrong setup.
 */
export const clearScopeSettings = (scope) => {
  if (!scope) return 0;                          // never the guest's bare keys
  const suffix = `@${scope}`;
  const doomed = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.endsWith(suffix)) doomed.push(key);
  }
  for (const key of doomed) {
    try { localStorage.removeItem(key); } catch (e) { /* private mode */ }
  }
  clearSettingStamps(scope);
  return doomed.length;
};
