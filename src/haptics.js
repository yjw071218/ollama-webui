// A short buzz when something happened that has no other confirmation.
//
// On a phone half the app's feedback is visual and the finger is covering it:
// the row you just deleted, the drawer you just swiped, the message you just
// sent are all under the hand that did it. A 10ms pulse is the platform's
// answer to that, and it costs nothing where it is not supported — Safari on
// iOS has never implemented `navigator.vibrate` and simply has no `vibrate`
// property, so every call here is a no-op there rather than an error.
//
// Deliberately conservative about when it fires. Haptics on every tap is the
// setting people turn off first, so this is spent on state changes and
// destructive actions and nothing else.

// Kept in a module variable rather than read from storage on every call: this
// runs on the tap path, and a localStorage read is synchronous.
let enabled = true;

/** Follow the user's setting. Called by the app whenever it changes. */
export const setHapticsEnabled = (value) => { enabled = !!value; };

export const hapticsSupported = () =>
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

// Durations, not names, so a caller cannot invent a pattern of its own and
// make one part of the app feel unlike the rest.
const PATTERNS = {
  // A toggle, a drawer, a tab: something moved.
  light: 8,
  // Sent, saved, applied: something committed.
  medium: 14,
  // Deleted, or refused. Two pulses, because one of anything reads as success.
  warn: [12, 40, 12],
};

/**
 * Buzz, if the device can and the user has not said otherwise.
 *
 * Never throws: `vibrate` rejects patterns some browsers dislike, and a
 * failed buzz must not take down the action it was decorating.
 */
export const haptic = (kind = 'light') => {
  if (!enabled || !hapticsSupported()) return false;
  const pattern = PATTERNS[kind] ?? PATTERNS.light;
  try {
    return navigator.vibrate(pattern);
  } catch (err) {
    return false;
  }
};
