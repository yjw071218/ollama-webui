// Keeping one profile's settings out of another's.
//
// Chats, documents, memories, folders and presets are each stored under a key
// that carries the profile id. Settings are not: there are around eighty
// localStorage reads and writes scattered through the app, all of them using a
// bare name like `systemPrompt`. So the live keys are, in effect, "whoever is
// signed in right now".
//
// Rewriting eighty call sites to carry a scope would be a large change with a
// lot of places to get it wrong. Snapshotting instead keeps the live keys
// exactly as they are and swaps their contents when the profile changes: the
// outgoing profile's values are stored under its own key, the incoming
// profile's are put back. One place to be correct rather than eighty.

const SNAPSHOT_PREFIX = 'settingsSnapshot';

// Not settings: identity, other profiles' data, and the snapshots themselves.
const NOT_A_SETTING = [
  /^settingsSnapshot(:|$)/,
  /^ollama-users$/,
  /^ollama-auth-session$/,
  /^ollama-sessions(:|$)/,
  /^chatFolders(:|$)/,
  /^samplingPresets(:|$)/,
];

// Names a file or device on this machine, so it must not travel with a profile.
const MACHINE_LOCAL = new Set(['ttsRefAudio']);

export const isSettingKey = (key) =>
  !!key && !NOT_A_SETTING.some(pattern => pattern.test(key));

export const snapshotKeyFor = (scope) =>
  scope ? `${SNAPSHOT_PREFIX}:${scope}` : `${SNAPSHOT_PREFIX}:guest`;

/** The settings currently in effect in this browser. */
export const readLiveSettings = () => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!isSettingKey(key)) continue;
    out[key] = localStorage.getItem(key);
  }
  return out;
};

/** Store the live settings as belonging to `scope`. */
export const saveSnapshot = (scope) => {
  try {
    localStorage.setItem(snapshotKeyFor(scope), JSON.stringify(readLiveSettings()));
    return true;
  } catch (e) {
    return false;   // quota; the live values are still correct
  }
};

export const readSnapshot = (scope) => {
  try {
    const raw = localStorage.getItem(snapshotKeyFor(scope));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
};

/**
 * Make `scope`'s settings the ones in effect.
 *
 * Returns whether anything actually changed, so the caller can decide whether a
 * reload is warranted — the values live in React state read at mount, so
 * writing them is not enough on its own.
 *
 * A profile with no snapshot yet keeps whatever is in effect: that is a first
 * sign-in, and inheriting the current setup is friendlier than resetting
 * someone to defaults. It is snapshotted immediately so the next switch is
 * clean.
 */
export const applySnapshot = (scope) => {
  const incoming = readSnapshot(scope);
  if (!incoming) {
    saveSnapshot(scope);
    return false;
  }

  let changed = false;
  const live = readLiveSettings();

  // Anything the incoming profile does not have should not linger from the
  // outgoing one — except machine-local values, which describe this computer
  // rather than the person.
  for (const key of Object.keys(live)) {
    if (MACHINE_LOCAL.has(key) || key in incoming) continue;
    localStorage.removeItem(key);
    changed = true;
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (MACHINE_LOCAL.has(key)) continue;
    if (localStorage.getItem(key) === value) continue;
    try { localStorage.setItem(key, value); changed = true; } catch (e) { /* quota */ }
  }

  return changed;
};

/**
 * Hand one profile's settings over to another.
 *
 * The order matters: the outgoing profile has to be recorded before the
 * incoming one overwrites the live keys, or its settings are lost.
 */
export const switchScope = (fromScope, toScope) => {
  if (fromScope === toScope) return false;
  saveSnapshot(fromScope);
  return applySnapshot(toScope);
};
