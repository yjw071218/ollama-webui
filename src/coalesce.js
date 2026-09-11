// Waiting for the dust to settle, with a promise that it will settle.
//
// Two timers in this app batch up rapid changes: one before writing the chat
// list to browser storage, one before uploading it to the account. Both were
// plain debounces — clear the timer, set it again — and a plain debounce has a
// failure mode that is easy to miss and total when it happens: if changes
// arrive more often than the delay, the timer is re-armed every time and never
// fires at all. Not late. Never.
//
// A streaming reply is exactly that. It rewrites the chat several times a
// second for as long as the model is talking, so neither timer fired for the
// whole of an answer. Locally that was invisible, because the screen is drawn
// from React state rather than from storage; everywhere else it was the whole
// bug. Storage still held the empty assistant placeholder saved during the
// pause while the model loaded, the upload reads storage, and so the other
// devices were sent an empty reply and then nothing at all — "Thinking...",
// for as long as the answer took, and after it too.
//
// So the wait has a ceiling. Quiet for `delay`, or `maxDelay` since the first
// change that has not been handled yet, whichever comes first.

/**
 * When a batched action should run.
 *
 * `since` is when the oldest unhandled change arrived. Zero, or absent, means
 * this is the first — the caller records `now` and passes it back next time.
 * A `maxDelay` of 0 asks for the old behaviour, an ordinary debounce with no
 * ceiling, which is right where the changes being batched cannot be continuous.
 *
 * Returns an absolute time, not a duration, because the caller has to compare
 * it with `now` anyway and a duration hides which of the two limits applied.
 */
export const dueAt = (now, since, delay, maxDelay = 0) => {
  const quiet = now + delay;
  if (!maxDelay || !since) return quiet;
  return Math.min(quiet, since + maxDelay);
};

/** The same answer as a delay for `setTimeout`, never negative. */
export const waitFor = (now, since, delay, maxDelay = 0) =>
  Math.max(0, dueAt(now, since, delay, maxDelay) - now);

/**
 * Has the ceiling already passed, so that the action should run *now* rather
 * than be handed to a timer?
 *
 * The ceiling above is enforced by `setTimeout`, and `setTimeout` is not a
 * clock you can rely on in a page nobody is looking at. Chrome clamps a hidden
 * page's timers to one a second, and to one a minute once it has been hidden
 * for five; Safari on a locked phone stops them altogether. So a reply
 * streaming in a backgrounded window was written to storage — and uploaded to
 * the account — a fraction as often as the ceiling promised, or not at all,
 * and the other devices watching it saw the answer arrive in jerks and then
 * stop.
 *
 * Both schedulers are driven by the change that needs saving, and those
 * changes come off the network, which nothing throttles. Asking this question
 * when the change arrives is therefore a clock that keeps working when the
 * timer does not.
 */
export const isOverdue = (now, since, maxDelay = 0) =>
  Boolean(maxDelay) && Boolean(since) && now - since >= maxDelay;
