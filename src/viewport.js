// Keeping the app the size of the part of the screen you can actually see.
//
// The app is one screenful with its own internal scrolling: a fixed header, a
// scrolling conversation, and a composer pinned to the bottom. That only works
// while "the screen" and "the app" are the same height, and an on-screen
// keyboard is exactly the thing that makes them differ.
//
// Two viewports are involved and the difference between them is the whole
// problem. The *layout* viewport is what CSS lengths — `100dvh` — are measured
// against. The *visual* viewport is the part of it the user can see. Opening
// the keyboard shrinks the visual viewport; whether it also shrinks the layout
// viewport is up to the browser:
//
//   * Chrome on Android does what `interactive-widget=resizes-content` in the
//     viewport meta tag asks, which is to shrink both. `100dvh` then already
//     means "above the keyboard" and there is nothing left to do here.
//   * Safari on iOS ignores that key. The layout viewport keeps its full
//     height and the browser scrolls it up instead, so a `100dvh` app keeps
//     its composer at the bottom — underneath the keyboard — and the user
//     types into a box they cannot see.
//
// So the measurement is taken from `visualViewport` and published as a CSS
// variable, and the stylesheet subtracts it. Where the browser already did the
// right thing the number comes out as zero and the variable costs nothing,
// which is why this can be unconditional rather than sniffing for Safari.

// How much of the layout viewport is hidden behind the keyboard, in px.
const KEYBOARD_INSET = '--kb-inset';

// Below this, a change in the visual viewport is the address bar collapsing,
// a zoom, or rounding — not a keyboard. Treating those as a keyboard makes the
// layout twitch while the user scrolls.
const KEYBOARD_MIN_PX = 90;

/**
 * Start tracking the keyboard, and stop when the returned function is called.
 *
 * Safe to call anywhere: a browser with no `visualViewport` gets the variable
 * fixed at zero, which is the same as not having this file at all.
 */
export const trackViewport = () => {
  const root = document.documentElement;
  const viewport = window.visualViewport;

  root.style.setProperty(KEYBOARD_INSET, '0px');
  if (!viewport) return () => {};

  let frame = 0;

  const measure = () => {
    frame = 0;

    // `offsetTop` is how far the browser has already scrolled the layout
    // viewport up to keep the focused field in view — iOS does this, and
    // without counting it the inset comes out short by exactly that much and
    // the composer still hides.
    const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
    const inset = hidden > KEYBOARD_MIN_PX ? Math.round(hidden) : 0;

    root.style.setProperty(KEYBOARD_INSET, `${inset}px`);
    // For anything that wants to behave differently rather than just be
    // shorter — the on-screen footer, for one, which is not worth a third of
    // what is left of the screen.
    root.classList.toggle('keyboard-open', inset > 0);

    // The app is now exactly as tall as the visible area, so there is nothing
    // to scroll to and the browser's own scroll is just a displaced page.
    // Undoing it is what stops the header disappearing off the top.
    if (inset > 0 && window.scrollY !== 0) window.scrollTo(0, 0);
  };

  // resize and scroll both fire in bursts while the keyboard animates; one
  // measurement per frame is plenty and keeps the layout from thrashing.
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };

  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  measure();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    window.removeEventListener('orientationchange', schedule);
    root.style.setProperty(KEYBOARD_INSET, '0px');
    root.classList.remove('keyboard-open');
  };
};
