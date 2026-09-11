// The ceiling on a debounce, and the reply that never left the phone.
//
// Two timers batch up rapid changes to a chat: one before writing it to browser
// storage, one before uploading it to the account. Both were plain debounces,
// and a plain debounce has one failure mode that is easy to miss and total when
// it happens — if changes arrive more often than the delay, the timer is
// re-armed every time and never fires. Not late. Never.
//
// A streaming reply is exactly that: the chat is rewritten several times a
// second for as long as the model is talking. So for the whole of an answer,
// nothing was written to storage and nothing was uploaded. On the device doing
// the talking that was invisible, because the screen is drawn from React state.
// Everywhere else it was the entire bug: the upload reads *storage*, storage
// still held the empty assistant placeholder saved during the pause while the
// model loaded, and so the other device was sent an empty reply and then
// nothing — "Thinking...", for as long as the answer took, and after it too.
//
// What is checked here is the arithmetic both timers now share: quiet for
// `delay`, or `maxDelay` since the first unhandled change, whichever is sooner.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/coalesce.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.coalesce-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { dueAt, waitFor, isOverdue } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ the quiet case */

// One change, nothing else happening. The ceiling is far away and the ordinary
// delay is what applies -- a lone edit must not be rushed to the server just
// because a ceiling exists.
eq('a first change waits the full delay', dueAt(1000, 1000, 700, 1500), 1700);
eq('and a later one, still inside the ceiling, waits from itself',
  dueAt(1400, 1000, 700, 1500), 2100);

/* -------------------------------------------------------------- the ceiling */

// Now the same change arriving late enough that the ordinary delay would push
// the write past the ceiling. The ceiling wins, and it is measured from the
// *first* unhandled change, not from this one.
// At 1500ms in, the ordinary delay still lands before the ceiling, so it wins:
// a ceiling only ever brings the moment forward, never pushes it back.
eq('the delay still wins while it lands first', dueAt(1500, 1000, 700, 1500), 2200);
// At 1900ms in it does not, and the ceiling caps it -- measured from the first
// unhandled change at 1000, not from this one.
eq('the ceiling caps the wait once the delay would overshoot',
  dueAt(1900, 1000, 700, 1500), 2500);
eq('and it is measured from the first change', dueAt(2400, 1000, 700, 1500), 2500);

// Past the ceiling entirely -- which is where a stream of changes ends up --
// the answer is "now", and `waitFor` never returns a negative delay.
eq('past the ceiling it is due immediately', waitFor(3000, 1000, 700, 1500), 0);
eq('and never asks setTimeout for a negative wait', waitFor(9999, 1000, 700, 1500), 0);

/* ------------------------------------------------------- a streaming reply */

// The shape of the bug, run as a loop. A token every 100ms against a 700ms
// delay: under a plain debounce the write is postponed by every single one of
// them and the timer fires exactly never.
const TOKEN_EVERY = 100;
const DELAY = 700;
const CEILING = 1500;

let since = 0;
let fired = [];
for (let i = 0; i < 40; i++) {                 // four seconds of streaming
  const now = 1000 + i * TOKEN_EVERY;
  if (!since) since = now;
  const wait = waitFor(now, since, DELAY, CEILING);
  // The next token arrives before the timer would fire, so it is cleared and
  // re-armed -- unless it was already due, which is the whole point.
  if (wait < TOKEN_EVERY) { fired.push(now + wait); since = 0; }
}

check('a streaming reply is written repeatedly, not postponed', fired.length >= 2,
  `fired ${fired.length} times`);
check('and never goes longer than the ceiling between writes',
  fired.every((at, i) => (i === 0 ? at - 1000 : at - fired[i - 1]) <= CEILING + TOKEN_EVERY),
  JSON.stringify(fired));

// The same loop with no ceiling: the timer is re-armed forever and the reply is
// never written at all. This is the behaviour being fixed, asserted so that
// nobody restores it by deleting a parameter.
since = 0;
let firedWithout = 0;
for (let i = 0; i < 40; i++) {
  const now = 1000 + i * TOKEN_EVERY;
  if (!since) since = now;
  if (waitFor(now, since, DELAY, 0) < TOKEN_EVERY) { firedWithout++; since = 0; }
}
eq('without a ceiling it would never have been written', firedWithout, 0);

/* -------------------------------------------------------------- the corners */

// `maxDelay: 0` is how a caller asks for a plain debounce, and some should:
// where the changes cannot be continuous, a ceiling only adds writes.
eq('no ceiling asked for means the plain delay', dueAt(5000, 1000, 700, 0), 5700);
eq('and a missing ceiling means the same', dueAt(5000, 1000, 700), 5700);

// No pending change recorded yet -- the caller's "first one" -- has nothing to
// measure a ceiling from, so the delay is all there is.
eq('nothing pending yet means the plain delay', dueAt(5000, 0, 700, 1500), 5700);

/* ------------------------------------- the ceiling, without trusting a timer

   The ceiling above is enforced by `setTimeout`, and `setTimeout` is not a
   clock that a page nobody is looking at still has. Measured in Edge on this
   machine, over twenty seconds, with another tab in front of it:

       requestAnimationFrame   1201 -> 0     (stops outright)
       setTimeout(..., 250)      78 -> 20    (clamped to one a second)
       chunks off the network    78 -> 76    (untouched)

   So a reply streaming into a backgrounded window was committed never, and
   uploaded a fraction as often as the ceiling promised — the answer froze on
   every other device until that window came back to the front. Both
   schedulers are called *from the change*, and the changes come off the
   network, so asking "is it already overdue?" at that moment is a clock that
   still works when the timer does not. */

eq('not yet overdue', isOverdue(1400, 1000, 800), false);
eq('exactly at the ceiling is overdue', isOverdue(1800, 1000, 800), true);
eq('past it is overdue', isOverdue(5000, 1000, 800), true);

// A caller that asked for a plain debounce has no ceiling to pass, however
// long it has been waiting.
eq('no ceiling is never overdue', isOverdue(999999, 1000, 0), false);
eq('a missing ceiling is never overdue', isOverdue(999999, 1000), false);

// Nothing pending has nothing to measure from. Treating zero as "since the
// epoch" would fire on the very first change and defeat the batching entirely.
eq('nothing pending is never overdue', isOverdue(999999, 0, 800), false);

// The two agree: overdue is exactly the case where the timer would have been
// asked to wait no time at all.
for (const [now, since] of [[1000, 1000], [1500, 1000], [1800, 1000], [3000, 1000]]) {
  eq(`overdue matches a zero wait at now=${now}`,
    isOverdue(now, since, 800), waitFor(now, since, 400, 800) === 0);
}

/* --------------------------------------------------- the pace this now sets

   What the other devices see is the storage ceiling plus the upload ceiling,
   because the upload is scheduled from the write and can only ever send what
   the write left behind. These are the numbers in App.jsx; a change to either
   that pushes the total back over a second is a change that makes the phone
   lurch again, so they are asserted here rather than left as a comment. */
const SAVE_MAX = 800;
const UPLOAD_MAX = 1000;
check('a reply reaches the other device inside two seconds',
  SAVE_MAX + UPLOAD_MAX <= 2000, `${SAVE_MAX} + ${UPLOAD_MAX}`);
check('and the save is not the slower of the two', SAVE_MAX <= UPLOAD_MAX);

const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
check('App.jsx still uses those numbers',
  app.includes(`SAVE_MAX_DELAY_MS = ${SAVE_MAX};`) && app.includes(`maxDelay: ${UPLOAD_MAX},`));

// Both ceilings are checked on the change as well as by their timer.
check('the storage write checks the ceiling itself',
  /isOverdue\(now, saveSinceRef\.current, SAVE_MAX_DELAY_MS\)/.test(app));
check('the upload checks the ceiling itself',
  /isOverdue\(now, pendingSince, maxDelay\)/.test(
    fs.readFileSync(new URL('../src/syncEngine.js', import.meta.url), 'utf8')));

// The frame clock is right for painting and useless for anything that has to
// keep happening while the window is behind another one.
check('the streaming commit does not rely on animation frames alone',
  /visibilityState === 'hidden'[\s\S]{0,260}flushNow\(\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
