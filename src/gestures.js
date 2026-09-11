// The drawer gesture: swipe in from the edge to open the chat list, swipe it
// back to close it.
//
// This is the one interaction a phone user expects to exist and this app did
// not have. The drawer could only be opened from a button in the corner of the
// header, which is the hardest place on a phone to reach one-handed and the
// exact reason every messaging app on both platforms puts the same drawer
// behind an edge swipe.
//
// The decision is separated from the plumbing on purpose. `decideSwipe` is a
// pure function of four numbers and two booleans, so the rules — how far, how
// straight, from where — are testable without a touch screen, and
// `trackDrawerSwipe` is the part that listens.
//
// Three rules, and each exists because of a gesture that would otherwise be
// stolen:
//
//   * Opening only counts from the screen edge. A swipe that begins in the
//     middle of the conversation is a scroll, or a drag across a code block,
//     or the browser's own back gesture — none of which should summon a panel.
//   * Every swipe must be more horizontal than vertical, by a margin. A
//     diagonal flick while scrolling a long answer is a scroll that wandered,
//     not a request for the chat list.
//   * A gesture that starts on something which scrolls sideways belongs to
//     that thing. A code block, the settings tab strip and a range slider all
//     consume horizontal drags, and taking those would make them unusable.

// How close to the leading edge a swipe must begin to count as opening. 24px
// is about a thumb's width and is what both platforms use for their own edge
// gestures.
export const EDGE_PX = 24;

// How far it must travel before it means anything. Below this it is a tap that
// moved, and a drawer that opens on those opens constantly.
export const SWIPE_MIN_PX = 56;

// Horizontal travel must beat vertical by this much. 1.5 rather than 1 leaves
// room for the arc a thumb naturally makes.
export const DIRECTION_RATIO = 1.5;

// A slow drag across the screen is not a swipe; it is a scroll that changed
// its mind, or a finger resting. Past this the gesture is abandoned.
export const SWIPE_MAX_MS = 700;

/** Elements that own horizontal dragging, and must keep it. */
export const SWIPE_BLOCKERS = [
  'pre', '.code-container', '.settings-tabs', '.artifact-panel', '.preview-stage',
  'input[type="range"]', '.dropdown-menu', '.cmd-list', '[data-no-swipe]',
].join(', ');

/**
 * What a completed drag means, or null if it means nothing.
 *
 * `dx` and `dy` are in CSS pixels, `dx` positive rightwards. `rtl` mirrors the
 * whole thing: the drawer lives on the right in Arabic, so "in from the edge"
 * is a leftward swipe there, and a rule written in terms of "rightwards" would
 * have the gesture backwards for one of the twelve languages this ships in.
 */
export const decideSwipe = ({ dx, dy, ms, fromEdge, isOpen, rtl = false }) => {
  if (ms > SWIPE_MAX_MS) return null;

  // Everything below is written as though the drawer opens rightwards; in RTL
  // the sign is flipped once, here, rather than in each comparison.
  const inward = rtl ? -dx : dx;
  if (Math.abs(inward) < SWIPE_MIN_PX) return null;
  if (Math.abs(inward) < Math.abs(dy) * DIRECTION_RATIO) return null;

  if (inward > 0) return (!isOpen && fromEdge) ? 'open' : null;
  return isOpen ? 'close' : null;
};

/**
 * Listen for the drawer gesture on `target`, and report it.
 *
 * `state()` is asked for `{ isOpen, rtl, enabled }` at the moment the gesture
 * starts rather than being passed in, because all three change while the
 * listener is attached — the drawer opens, the language changes, the window is
 * resized past the breakpoint — and a listener re-attached on every one of
 * those would drop a gesture in progress each time.
 *
 * Returns the function that removes the listeners.
 */
export const trackDrawerSwipe = (target, state, onSwipe) => {
  if (!target || typeof target.addEventListener !== 'function') return () => {};

  let start = null;

  const onTouchStart = (event) => {
    start = null;
    const context = state() || {};
    if (!context.enabled) return;

    // Two fingers is a pinch or a zoom, and neither is this.
    if (!event.touches || event.touches.length !== 1) return;

    const touch = event.touches[0];
    if (event.target?.closest?.(SWIPE_BLOCKERS)) return;

    const width = window.innerWidth || 0;
    const fromEdge = context.rtl
      ? touch.clientX >= width - EDGE_PX
      : touch.clientX <= EDGE_PX;

    // A closed drawer can only be opened from the edge, so a touch that starts
    // anywhere else is not worth following at all.
    if (!context.isOpen && !fromEdge) return;

    start = {
      x: touch.clientX,
      y: touch.clientY,
      at: Date.now(),
      fromEdge,
      isOpen: !!context.isOpen,
      rtl: !!context.rtl,
    };
  };

  const onTouchEnd = (event) => {
    const began = start;
    start = null;
    if (!began) return;

    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;

    const verdict = decideSwipe({
      dx: touch.clientX - began.x,
      dy: touch.clientY - began.y,
      ms: Date.now() - began.at,
      fromEdge: began.fromEdge,
      isOpen: began.isOpen,
      rtl: began.rtl,
    });
    if (verdict) onSwipe(verdict);
  };

  const onTouchCancel = () => { start = null; };

  // Passive: this listener never calls preventDefault — the drawer is decided
  // when the finger lifts, not while it moves — and saying so up front lets
  // the browser scroll without waiting to find out.
  const options = { passive: true };
  target.addEventListener('touchstart', onTouchStart, options);
  target.addEventListener('touchend', onTouchEnd, options);
  target.addEventListener('touchcancel', onTouchCancel, options);

  return () => {
    target.removeEventListener('touchstart', onTouchStart, options);
    target.removeEventListener('touchend', onTouchEnd, options);
    target.removeEventListener('touchcancel', onTouchCancel, options);
  };
};
