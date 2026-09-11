/**
 * Cutting text without cutting a character in half.
 *
 * JavaScript strings are UTF-16, and everything outside the Basic Multilingual
 * Plane — every emoji, and a good many rare CJK characters — is stored as two
 * code units. `"완료 🎉".slice(0, 4)` therefore ends in half of the emoji: a
 * lone surrogate, which is not a character at all.
 *
 * A lone surrogate looks harmless right up until the string crosses a boundary
 * that has to encode it. `JSON.stringify` over the wire, `TextEncoder`,
 * IndexedDB — each replaces it with U+FFFD, and what the reader sees is:
 *
 *     완료 �
 *
 * There is no error and nothing in the log. It simply appears in the middle of
 * an answer, and only sometimes, because it needs a cut to land on exactly the
 * wrong index — which is why it looks random and why it survived so long.
 *
 * Everything here is the same as the built-in it replaces except that it steps
 * off a surrogate boundary before cutting.
 */

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The nearest index at or before `index` that is not inside a pair.
 *
 * Backwards rather than forwards, always: a cut is a budget, and moving the
 * boundary later could take the result past a limit somebody is relying on.
 * One code unit is never the difference that matters; a broken character is.
 */
export const safeIndex = (text, index) => {
  const s = String(text ?? '');
  const at = Math.max(0, Math.min(s.length, Math.trunc(index)));
  if (at <= 0 || at >= s.length) return at;
  // `at` is where the cut lands, so the question is about the unit before it
  // and the one at it: high then low means the cut is between them.
  return isLowSurrogate(s.charCodeAt(at)) && isHighSurrogate(s.charCodeAt(at - 1))
    ? at - 1
    : at;
};

/** `String.prototype.slice`, moved off any surrogate boundary it would split. */
export const safeSlice = (text, start = 0, end) => {
  const s = String(text ?? '');
  const from = start < 0 ? Math.max(0, s.length + start) : start;
  const to = end === undefined ? s.length : (end < 0 ? Math.max(0, s.length + end) : end);
  return s.slice(safeIndex(s, from), safeIndex(s, to));
};

/** The first `n` code units, rounded down to a whole character. */
export const safeHead = (text, n) => safeSlice(text, 0, n);

/**
 * The last `n` code units, rounded to a whole character.
 *
 * The start moves *forward* here, not back: a tail that begins on a low
 * surrogate begins in the middle of a character, and including the high half
 * would be reaching outside the tail that was asked for.
 */
export const safeTail = (text, n) => {
  const s = String(text ?? '');
  if (n >= s.length) return s;
  let from = Math.max(0, s.length - Math.max(0, Math.trunc(n)));
  if (from > 0 && from < s.length && isLowSurrogate(s.charCodeAt(from))) from += 1;
  return s.slice(from);
};

/**
 * Remove any half-character that is already in the string.
 *
 * The last line of defence, for text that arrived broken from somewhere this
 * module does not control — an older chat saved before any of this existed, a
 * model that genuinely emitted one, a paste out of another application. A
 * dropped half-character is not a loss: it was never a character, and leaving
 * it in means U+FFFD in the next thing that encodes it, plus a corrupted
 * prompt on every subsequent turn of the conversation.
 */
export const stripLoneSurrogates = (text) => {
  const s = String(text ?? '');
  // Cheap test first: the overwhelming majority of strings have no surrogates
  // at all, and this runs on every committed answer.
  if (!/[\uD800-\uDFFF]/.test(s)) return s;
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
};

/** Whether a string contains half a character. */
export const hasLoneSurrogate = (text) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(String(text ?? ''));
