// Walking back through what you already asked.
//
// The failure modes here are all about losing text. Walking forward off the
// newest entry has to give back the draft you were writing, not an empty box.
// Stealing the up arrow inside a multi-line prompt makes that prompt
// uneditable. And a step that should not happen has to be refused rather than
// clamped, so the key falls through to the textarea and the caret moves the
// way the caret is supposed to.
import { rolldown } from 'rolldown';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({ input: path.resolve(HERE, '../src/promptHistory.js'), platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.history-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { promptsFrom, stepHistory, wantsHistory, NOT_BROWSING } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* --------------------------------------------------- what goes into history */

const chat = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
  { role: 'user', content: 'second question' },
  { role: 'assistant', content: 'second answer' },
  { role: 'user', content: 'third question' },
];
eq('newest first', promptsFrom(chat), ['third question', 'second question', 'first question']);
eq('answers are not prompts', promptsFrom([{ role: 'assistant', content: 'hi' }]), []);
eq('an empty chat has no history', promptsFrom([]), []);

// Pressing send twice should not cost two presses of the arrow to get past.
eq('consecutive duplicates collapse', promptsFrom([
  { role: 'user', content: 'same' },
  { role: 'user', content: 'same' },
  { role: 'user', content: 'other' },
]), ['other', 'same']);

// …but the same question asked again later is genuinely a second entry, and
// dropping it would silently reorder everything after it.
eq('a repeat later in the chat is kept', promptsFrom([
  { role: 'user', content: 'same' },
  { role: 'assistant', content: 'a' },
  { role: 'user', content: 'other' },
  { role: 'assistant', content: 'b' },
  { role: 'user', content: 'same' },
]), ['same', 'other', 'same']);

// A message that was only an attachment has no text to recall; offering it
// would put an empty line in the composer.
eq('a message with no text is skipped', promptsFrom([
  { role: 'user', content: '   ' },
  { role: 'user', content: 'real' },
]), ['real']);
eq('so is one with no string content at all', promptsFrom([
  { role: 'user' },
  { role: 'user', content: 'real' },
]), ['real']);
eq('and rubbish in the list does not throw', promptsFrom([null, undefined, { role: 'user', content: 'real' }]), ['real']);

/* ------------------------------------------------------------ walking back */

const prompts = ['third question', 'second question', 'first question'];

eq('the first press gives the newest', stepHistory(prompts, NOT_BROWSING, 'back', ''),
  { index: 0, value: 'third question' });
eq('the second gives the one before it', stepHistory(prompts, 0, 'back', ''),
  { index: 1, value: 'second question' });
eq('and so on to the oldest', stepHistory(prompts, 1, 'back', ''),
  { index: 2, value: 'first question' });

// Refused, not clamped: the caller leaves the key to the textarea, so the
// caret still moves instead of the box appearing frozen.
eq('past the oldest is refused', stepHistory(prompts, 2, 'back', ''), null);
eq('an empty history refuses immediately', stepHistory([], NOT_BROWSING, 'back', ''), null);

/* --------------------------------------------------------- walking forward */

eq('forward comes back down the list', stepHistory(prompts, 2, 'forward', ''),
  { index: 1, value: 'second question' });

// The one that matters: a stray arrow key must not eat what you were writing.
eq('walking off the newest end restores the draft',
  stepHistory(prompts, 0, 'forward', 'half-written thought'),
  { index: NOT_BROWSING, value: 'half-written thought' });
eq('an empty draft comes back as empty', stepHistory(prompts, 0, 'forward', ''),
  { index: NOT_BROWSING, value: '' });
eq('forward while not browsing is refused', stepHistory(prompts, NOT_BROWSING, 'forward', 'x'), null);

/* ------------------------------------------- when the arrow means "history" */

const at = (value, caret) => ({ value, selectionStart: caret, selectionEnd: caret });

eq('an empty box, up, yes', wantsHistory(at('', 0), 'back'), true);
eq('an empty box, down, yes', wantsHistory(at('', 0), 'forward'), true);
eq('a one-line prompt, up, yes', wantsHistory(at('hello', 5), 'back'), true);

// The boundary rule. Up from anywhere on the first line is history; up from a
// later line moves the caret, because a multi-line prompt is a thing people
// edit and stealing the arrow inside one would make it unusable.
eq('multi-line, caret on the last line, up, no', wantsHistory(at('one\ntwo', 6), 'back'), false);
eq('multi-line, caret on the first line, up, yes', wantsHistory(at('one\ntwo', 2), 'back'), true);

// …and the mirror image, which is what lets a walk continue after it has
// recalled a multi-line entry: down off the last line carries on into history.
// Without this the walk stranded itself on the first long prompt it found —
// observed in the browser, not reasoned about.
eq('multi-line, caret on the last line, down, yes', wantsHistory(at('one\ntwo', 6), 'forward'), true);
eq('multi-line, caret on the first line, down, no', wantsHistory(at('one\ntwo', 2), 'forward'), false);

// A recall leaves the caret at the end, which is the last line, so pressing up
// there moves the caret up one line first and the press after that walks back.
// Two presses rather than one — exactly how a shell behaves.
const recalled = '> quoted line\n\nExplain this.';
eq('the caret at the end of a recall is not at the top', wantsHistory(at(recalled, recalled.length), 'back'), false);
eq('but once it reaches the first line it is', wantsHistory(at(recalled, 3), 'back'), true);

eq('with a selection, no', wantsHistory({ value: 'hello', selectionStart: 0, selectionEnd: 5 }, 'back'), false);
eq('nothing at all, yes', wantsHistory(), true);
eq('the default direction is back', wantsHistory(at('one\ntwo', 6)), false);

/* -------------------------------------------------- a walk end to end */

// The sequence a person actually performs: type half a thought, arrow up
// twice, change your mind, arrow down twice, and find the half thought.
let index = NOT_BROWSING;
const draft = 'half a thought';
let value = draft;
for (const dir of ['back', 'back']) {
  const s = stepHistory(prompts, index, dir, draft);
  index = s.index; value = s.value;
}
eq('two presses back land on the second entry', [index, value], [1, 'second question']);
for (const dir of ['forward', 'forward']) {
  const s = stepHistory(prompts, index, dir, draft);
  index = s.index; value = s.value;
}
eq('two presses forward return the draft', [index, value], [NOT_BROWSING, 'half a thought']);

/* ---------------------------------------------------------- the wiring */

// The composer must leave history when the text becomes the person's own
// again — by typing, or by sending. Asserted against the source because the
// bug it prevents (the next up arrow resuming mid-walk) is invisible until
// somebody hits it.
const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('typing leaves history',
  /setInput\(e\.target\.value\);[\s\S]{0,400}?historyIndexRef\.current = NOT_BROWSING/.test(app));
check('sending leaves history',
  /setAttachments\(\[\]\);[\s\S]{0,300}?historyIndexRef\.current = NOT_BROWSING/.test(app));
check('the arrow is only taken when wantsHistory agrees, in that direction',
  /wantsHistory\(e\.currentTarget, e\.key === 'ArrowUp' \? 'back' : 'forward'\)/.test(app));

// Holding the up arrow fires key repeats faster than React re-renders. A
// `useState` index read from the handler's closure would still say
// NOT_BROWSING on the third repeat and walk to the same entry every time, so
// the position has to live in a ref -- and the draft has to be read off the
// element rather than from the `input` state, for the same reason.
check('the position is a ref, not state', /const historyIndexRef = useRef\(NOT_BROWSING\)/.test(app));
check('no state copy of it survives to go stale', !/setHistoryIndex/.test(app));
check('the draft is read from the element', /const typed = e\.currentTarget\.value/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
