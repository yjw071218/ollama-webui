// The drawer gesture, and everything it must refuse.
//
// Swiping in from the edge to open the chat list is the one interaction a
// phone user expects to exist, and the reason it is worth a test file rather
// than an event handler is that almost every *other* drag on the screen is
// something else: a scroll, a code block being pushed sideways, the browser's
// own back gesture, a pinch. A drawer that opens on any of those is worse than
// one that opens only from a button.
//
// So the decision is a pure function of six values and the plumbing is
// separate. What is checked here is that function: how far, how straight, from
// where, and how quickly — plus the mirror image of all of it in Arabic, where
// the drawer is on the right and "in from the edge" is the other direction.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/gestures.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.gestures-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  decideSwipe, trackDrawerSwipe,
  EDGE_PX, SWIPE_MIN_PX, DIRECTION_RATIO, SWIPE_MAX_MS, SWIPE_BLOCKERS,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// A swipe with only the parts a case cares about spelled out.
const swipe = (over) => decideSwipe({
  dx: 0, dy: 0, ms: 200, fromEdge: false, isOpen: false, rtl: false, ...over,
});

/* ----------------------------------------------------------------- opening */

eq('a firm swipe in from the edge opens the drawer',
  swipe({ dx: 120, fromEdge: true }), 'open');

// The whole point of the edge rule. A swipe that begins in the middle of a
// conversation is somebody dragging a table or a code block sideways, or the
// platform's back gesture, and taking it would make those unusable.
eq('the same swipe from the middle of the screen does nothing',
  swipe({ dx: 120, fromEdge: false }), null);

// Already open, so there is nothing to open. Without this the gesture would
// fire again on every rightward flick across an open drawer.
eq('an open drawer is not opened again',
  swipe({ dx: 120, fromEdge: true, isOpen: true }), null);

/* ----------------------------------------------------------------- closing */

eq('swiping the open drawer back closes it',
  swipe({ dx: -120, isOpen: true }), 'close');

// Closing is not edge-anchored: the drawer covers the left of the screen, so a
// swipe that starts on it starts nowhere near the edge.
eq('closing does not require starting at the edge',
  swipe({ dx: -120, fromEdge: false, isOpen: true }), 'close');

eq('a closed drawer cannot be closed', swipe({ dx: -120, isOpen: false }), null);

/* ------------------------------------------------------------- how far, how straight */

// A tap that moved. Below the threshold this is noise, and a drawer that
// opens on noise opens while you are trying to read.
eq('a short drag is not a swipe',
  swipe({ dx: SWIPE_MIN_PX - 1, fromEdge: true }), null);
eq('and one just past the threshold is',
  swipe({ dx: SWIPE_MIN_PX + 1, fromEdge: true }), 'open');

// The case this rule exists for: scrolling a long answer with a thumb draws an
// arc, and the horizontal part of that arc can easily clear the distance
// threshold on its own.
eq('a mostly-vertical drag is a scroll, not a swipe',
  swipe({ dx: 80, dy: 200, fromEdge: true }), null);
check('horizontal must beat vertical by the stated ratio',
  swipe({ dx: 100, dy: 100 / DIRECTION_RATIO - 5, fromEdge: true }) === 'open'
  && swipe({ dx: 100, dy: 100 / DIRECTION_RATIO + 5, fromEdge: true }) === null);

// A finger resting on the screen and eventually drifting is not a gesture.
eq('a slow drag times out', swipe({ dx: 200, fromEdge: true, ms: SWIPE_MAX_MS + 1 }), null);
eq('a quick one does not', swipe({ dx: 200, fromEdge: true, ms: SWIPE_MAX_MS - 1 }), 'open');

/* -------------------------------------------------------------------- Arabic */

// The drawer is on the right in RTL, so every rule above is mirrored. Getting
// this wrong is not a small bug: it makes the gesture open the drawer only
// when you swipe it *away*, for one of the twelve languages this ships in.
eq('in RTL, opening is a leftward swipe',
  swipe({ dx: -120, fromEdge: true, rtl: true }), 'open');
eq('in RTL, a rightward swipe from the edge opens nothing',
  swipe({ dx: 120, fromEdge: true, rtl: true }), null);
eq('in RTL, closing is a rightward swipe',
  swipe({ dx: 120, isOpen: true, rtl: true }), 'close');

/* ------------------------------------------------------------------ the rules */

check('the edge is a thumb-width, not the whole screen', EDGE_PX > 0 && EDGE_PX <= 48);
check('the blocker list covers what scrolls sideways',
  ['pre', '.code-container', '.settings-tabs'].every(sel => SWIPE_BLOCKERS.includes(sel)),
  SWIPE_BLOCKERS);

/* ------------------------------------------------------------- the plumbing */

// A tiny stand-in for a touch surface: enough to drive the listener without a
// DOM. `closest` is what the blocker check calls, so the fake target answers it.
const makeTarget = () => {
  const handlers = {};
  return {
    listeners: handlers,
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => {
      handlers[type] = (handlers[type] || []).filter(f => f !== fn);
    },
    fire: (type, event) => (handlers[type] || []).forEach(fn => fn(event)),
    count: () => Object.values(handlers).reduce((n, list) => n + list.length, 0),
  };
};

const touch = (x, y, blocked = false) => ({
  touches: [{ clientX: x, clientY: y }],
  changedTouches: [{ clientX: x, clientY: y }],
  target: { closest: () => (blocked ? {} : null) },
});

globalThis.window = { innerWidth: 400 };

const drive = (state, from, to, { blocked = false } = {}) => {
  const target = makeTarget();
  const seen = [];
  const stop = trackDrawerSwipe(target, () => state, v => seen.push(v));
  target.fire('touchstart', touch(from[0], from[1], blocked));
  target.fire('touchend', touch(to[0], to[1]));
  stop();
  return seen;
};

const ENABLED = { isOpen: false, rtl: false, enabled: true };

eq('a real edge swipe reaches the callback',
  drive(ENABLED, [5, 300], [200, 310]).join(), 'open');

// The listener is attached on a desktop too -- it is cheaper than adding and
// removing it as the window is resized -- so it has to decline there itself.
eq('nothing fires while the drawer is a column, not a drawer',
  drive({ ...ENABLED, enabled: false }, [5, 300], [200, 310]).length, 0);

// A drag that starts on a code block belongs to the code block.
eq('a swipe starting on something that scrolls sideways is left alone',
  drive(ENABLED, [5, 300], [200, 310], { blocked: true }).length, 0);

// A pinch or a two-finger scroll arrives as a touchstart like any other.
{
  const target = makeTarget();
  const seen = [];
  const stop = trackDrawerSwipe(target, () => ENABLED, v => seen.push(v));
  target.fire('touchstart', {
    touches: [{ clientX: 5, clientY: 300 }, { clientX: 200, clientY: 300 }],
    target: { closest: () => null },
  });
  target.fire('touchend', touch(200, 310));
  stop();
  eq('two fingers is not a swipe', seen.length, 0);
}

// A gesture the browser took over -- a scroll that started winning, a call
// arriving -- must not be completed from wherever the finger happened to be.
{
  const target = makeTarget();
  const seen = [];
  const stop = trackDrawerSwipe(target, () => ENABLED, v => seen.push(v));
  target.fire('touchstart', touch(5, 300));
  target.fire('touchcancel', {});
  target.fire('touchend', touch(200, 310));
  stop();
  eq('a cancelled gesture is abandoned', seen.length, 0);
}

{
  const target = makeTarget();
  const stop = trackDrawerSwipe(target, () => ENABLED, () => {});
  const attached = target.count();
  stop();
  check('every listener is removed again', attached > 0 && target.count() === 0,
    `attached ${attached}, left ${target.count()}`);
}

check('a missing target is survivable', typeof trackDrawerSwipe(null, () => ENABLED, () => {}) === 'function');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
