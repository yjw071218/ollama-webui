/**
 * Walking back through what you already asked.
 *
 * The commonest thing anyone does after a bad answer is send the same question
 * again with one word changed, and the only way to do that was to scroll up,
 * select the old message by hand, copy it, and scroll back down. Every shell
 * written in the last forty years solves this with the up arrow.
 *
 * The rules that make it feel right rather than merely present are:
 *
 *  - newest first, because the thing you want is almost always the last thing
 *    you sent;
 *  - consecutive duplicates collapse, so pressing send twice does not cost two
 *    presses of the arrow to get past;
 *  - walking forward past the newest entry restores what you had been typing,
 *    rather than emptying the box — otherwise a stray arrow key loses work.
 */

/** Entering history from an empty composer sits here, before the first entry. */
export const NOT_BROWSING = -1;

/**
 * The prompts to offer, newest first.
 *
 * Attachments and images are not carried, so a message that was only a file
 * has no text to recall and is skipped rather than offered as an empty line.
 */
export const promptsFrom = (messages) => {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    // Only *consecutive* duplicates collapse. The same question asked again
    // twenty messages later is a real second entry, and dropping it would
    // silently reorder the history.
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out;
};

/**
 * One step through the history.
 *
 * `index` is `NOT_BROWSING` before the first press. `draft` is whatever was in
 * the composer when browsing started, and comes back when you walk off the
 * newest end.
 *
 * Returns `null` when the step should not be taken at all — past the oldest
 * entry, or forward when not browsing — so the caller can leave the key to the
 * textarea and let the caret move normally.
 */
export const stepHistory = (prompts, index, direction, draft = '') => {
  if (direction === 'back') {
    const next = index + 1;
    if (next >= prompts.length) return null;
    return { index: next, value: prompts[next] };
  }
  if (index <= NOT_BROWSING) return null;
  const next = index - 1;
  // Off the newest end: back to what the person had actually been writing.
  if (next === NOT_BROWSING) return { index: NOT_BROWSING, value: draft };
  return { index: next, value: prompts[next] };
};

/**
 * Should this arrow mean "history" rather than "move the caret"?
 *
 * Only at the boundary: up from the first line, down from the last, with
 * nothing selected. This is what every modern shell does, and it is the rule
 * that makes both halves work at once — a multi-line prompt stays editable
 * line by line, and once the caret can go no further the same key carries on
 * into history instead of doing nothing.
 *
 * Asking only "is the box empty?" would have been simpler and wrong in both
 * directions: it would steal the arrow from a one-line prompt someone was
 * still writing, and it would strand the walk on the first multi-line entry
 * it recalled.
 */
export const wantsHistory = ({ value = '', selectionStart = 0, selectionEnd = 0 } = {}, direction = 'back') => {
  if (selectionStart !== selectionEnd) return false;
  return direction === 'back'
    ? value.slice(0, selectionStart).indexOf('\n') === -1
    : value.slice(selectionEnd).indexOf('\n') === -1;
};
