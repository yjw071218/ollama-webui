/**
 * Keeping the screen on while an answer is being written.
 *
 * A phone turns its screen off after thirty seconds or so, and a browser whose
 * screen is off does not merely stop painting — it is eventually frozen
 * outright, and a frozen page runs no JavaScript at all. The half-read reply
 * stops arriving, and the request to Ollama may be dropped with it. Nothing in
 * the app can work around that from the inside, which is why this exists: the
 * only fix is to ask the operating system not to do it.
 *
 * Held for exactly as long as an answer is streaming, and released the moment
 * it finishes. A lock that outlives its reason is a flat battery.
 *
 * The awkward part of the API is that the system revokes the lock whenever the
 * page is hidden and does not give it back — so anything that takes one has to
 * re-take it on the way back, or the second half of a long answer is
 * unprotected. That is what the visibility listener below is for.
 */

/** Is there a lock to take? Absent on desktop Safari and on Firefox. */
export const wakeLockSupported = () => (
  typeof navigator !== 'undefined'
  && !!navigator.wakeLock
  && typeof navigator.wakeLock.request === 'function'
);

/**
 * Start holding the screen awake. Returns a function that stops.
 *
 * Calling the returned function is the only way to release: there is
 * deliberately no module-level singleton, because two callers with one lock
 * between them is how a lock outlives the thing that wanted it.
 *
 * Never throws. A refused lock — low battery, an unsupported browser, a
 * permissions policy — leaves the app working exactly as it did before, which
 * is the right outcome for something that is an improvement rather than a
 * requirement.
 */
export const holdScreenAwake = ({ onChange } = {}) => {
  if (!wakeLockSupported()) {
    onChange?.(false);
    return () => {};
  }

  let sentinel = null;
  let released = false;

  // `released === false` is the sentinel saying it is definitely still held.
  // Anything else -- true, or missing because the browser never told us -- is
  // treated as gone. Deliberately not `if (sentinel)`: the system revokes the
  // lock when the page hides, and a `release` event that never arrives (or one
  // fired while nothing was listening) would otherwise leave this holding a
  // dead sentinel and refusing to ask for a live one, which is precisely the
  // case this whole function exists to cover.
  const stillHeld = () => !!sentinel && sentinel.released === false;

  const take = async () => {
    if (released || stillHeld()) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener?.('release', () => { onChange?.(false); });
      onChange?.(true);
    } catch (e) {
      sentinel = null;
      onChange?.(false);
    }
  };

  // The system takes the lock away whenever the page is hidden. Coming back is
  // the only chance to take it again, and without this the screen would sleep
  // through the second half of any answer the reader looked away from.
  const onVisibility = () => {
    if (!released && document.visibilityState === 'visible') take();
  };
  document.addEventListener('visibilitychange', onVisibility);

  take();

  return () => {
    released = true;
    document.removeEventListener('visibilitychange', onVisibility);
    const held = sentinel;
    sentinel = null;
    onChange?.(false);
    try { held?.release?.(); } catch (e) { /* already gone */ }
  };
};
