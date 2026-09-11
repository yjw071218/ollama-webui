// Stepping through a transcript by message rather than by pixel.
//
// The corners are the whole of this. A single-letter shortcut that fires while
// somebody is typing makes the composer unusable and gets the feature removed
// a week later; a step that wraps at the end silently throws you a hundred
// messages backwards with no way to tell where you were; and a first press
// that always lands at index 0 is useless in the case people actually have,
// which is wanting the most recent answer.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({ input: path.resolve(HERE, '../src/messageNav.js'), platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.messagenav-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { NAV_KEYS, wantsNavigation, nextIndex, navigableIndices, step } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* --------------------------------------------- when the key means "move" */

const ev = (key, over = {}) => ({
  key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  target: { tagName: 'DIV', isContentEditable: false },
  ...over,
});

check('j moves', wantsNavigation(ev('j')));
check('k moves', wantsNavigation(ev('k')));

// The one that matters. `j` is a letter before it is a command.
check('but not inside the composer',
  !wantsNavigation(ev('j', { target: { tagName: 'TEXTAREA' } })));
check('nor inside a text field',
  !wantsNavigation(ev('j', { target: { tagName: 'INPUT' } })));
check('nor inside a select',
  !wantsNavigation(ev('j', { target: { tagName: 'SELECT' } })));
check('nor in anything contenteditable',
  !wantsNavigation(ev('j', { target: { tagName: 'DIV', isContentEditable: true } })));
check('nor while a message is being edited',
  !wantsNavigation(ev('j'), { editing: true }));

// A bare arrow already means something everywhere; it only means this with a
// modifier held.
check('a bare down arrow does not move', !wantsNavigation(ev('ArrowDown')));
check('Alt and down does', wantsNavigation(ev('ArrowDown', { altKey: true })));
check('Alt and up does', wantsNavigation(ev('ArrowUp', { altKey: true })));

// And a combination that belongs to the browser or to another shortcut is not
// ours to take.
check('Ctrl+j is not ours', !wantsNavigation(ev('j', { ctrlKey: true })));
check('Cmd+j is not ours', !wantsNavigation(ev('j', { metaKey: true })));
check('Shift+J is not ours', !wantsNavigation(ev('j', { shiftKey: true })));
check('Alt+j is not ours either', !wantsNavigation(ev('j', { altKey: true })));
check('an unrelated letter is not ours', !wantsNavigation(ev('a')));
check('no event at all is not ours', !wantsNavigation(null));

eq('the keys map to directions', [NAV_KEYS.j, NAV_KEYS.k, NAV_KEYS.ArrowDown, NAV_KEYS.ArrowUp], [1, -1, 1, -1]);

/* ------------------------------------------------------- where it lands */

// From nowhere: down starts at the top, up starts at the *bottom*, because
// "up from nowhere" means the newest message and that is what is wanted.
eq('the first press down starts at the top', nextIndex(null, 5, 1), 0);
eq('the first press up starts at the bottom', nextIndex(null, 5, -1), 4);
eq('undefined counts as nowhere too', nextIndex(undefined, 5, 1), 0);

eq('down moves down', nextIndex(2, 5, 1), 3);
eq('up moves up', nextIndex(2, 5, -1), 1);

// Stopping, not wrapping. A press at the end that jumps to the start loses
// your place with nothing to say it happened.
eq('the end is the end', nextIndex(4, 5, 1), 4);
eq('and the start is the start', nextIndex(0, 5, -1), 0);

eq('an empty transcript has nowhere to go', nextIndex(null, 0, 1), null);
eq('nor does a broken count', nextIndex(null, NaN, 1), null);

/* --------------------------------------------- which messages are stops */

const MESSAGES = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  // A tool result is a message in the list and not a thing to step onto.
  { role: 'user', content: '<TOOL_RESULT>\nsome output\n</TOOL_RESULT>' },
  { role: 'assistant', content: 'second answer' },
  // The placeholder a reply has not arrived into yet.
  { role: 'assistant', content: '' },
  { role: 'system', content: 'not shown' },
];
eq('tool results, empties and system messages are skipped',
  navigableIndices(MESSAGES), [0, 1, 3]);
eq('an image with no text is still a message',
  navigableIndices([{ role: 'user', content: '', images: ['data:...'] }]), [0]);
eq('rubbish does not throw', navigableIndices([null, undefined, { role: 'user', content: 'x' }]), [2]);
eq('nothing at all is nothing', navigableIndices(null), []);

/* ------------------------------------------------ the step, end to end */

eq('down from the first skips the tool result', step(MESSAGES, 1, 1), 3);
eq('up from after it skips it too', step(MESSAGES, 3, -1), 1);
eq('the newest is the end', step(MESSAGES, 3, 1), 3);
eq('the oldest is the start', step(MESSAGES, 0, -1), 0);
eq('from nowhere, up lands on the newest', step(MESSAGES, null, -1), 3);
eq('from nowhere, down lands on the oldest', step(MESSAGES, null, 1), 0);

// Focused on a message that has since been deleted, or on a tool result: not
// an error, just a fresh start.
eq('a focus that is no longer navigable starts over', step(MESSAGES, 2, 1), 0);
eq('and in the other direction too', step(MESSAGES, 99, -1), 3);
eq('an empty transcript has no step', step([], null, 1), null);

/* --------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.resolve(HERE, '../src/extras.css'), 'utf8');

check('the rows can be found by index', /data-message-index=\{i\}/.test(app));
check('the focused row is marked', /navIndex === i \? 'nav-focus' : ''/.test(app));
check('and the mark is visible', /\.message-row\.nav-focus\s*\{[^}]*outline:/.test(css));
check('the handler asks before taking the key', /wantsNavigation\(e, \{ editing: editingMessageIndex !== null \}\)/.test(app));
check('and scrolls the message into the middle', /block: 'center'/.test(app));

// The handler is installed once, so it must read through refs or it sees the
// first render's values for ever — the bug that has already cost three
// crashes in this file.
check('it reads the transcript through a ref', /step\(messagesRef\.current, navIndexRef\.current, direction\)/.test(app));
// Everything that is an index into *this* chat's messages has to be forgotten
// together, or it lands on whatever happens to be in that position over there.
check('switching chats forgets the focus',
  /setNavIndex\(null\);[\s\S]*?\}, \[currentSessionId\]\)/.test(app));
check('and anything else pointing at a message by index',
  /setNavIndex\(null\); setDiffFor\(null\); \}, \[currentSessionId\]\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
