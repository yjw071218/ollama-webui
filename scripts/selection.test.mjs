// Asking about a passage you selected.
//
// Two things here are easy to get wrong in a way nothing else catches. A
// blockquote that marks only its first line ends at the first blank line, so
// half a long passage arrives as the *question* rather than as the thing being
// asked about — and the model answers something nobody asked. And a bar that
// appears for any selection anywhere would pop up over the sidebar, the
// composer and the user's own messages.
//
// Both are pure functions, so both are checked here rather than by eye.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/selection.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.selection-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  quotePassage, buildSelectionPrompt, selectionTarget,
  SELECTION_LIMIT, SELECTION_MIN, SELECTION_ACTIONS,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the quoting */

eq('a single line is quoted', quotePassage('hello'), '> hello');
eq('every line gets its own marker', quotePassage('a\nb\nc'), '> a\n> b\n> c');

// This is the one that matters. Without a marker on the blank line the quote
// ends there, and the second paragraph reads as the instruction.
eq('a blank line stays inside the quote', quotePassage('a\n\nb'), '> a\n> \n> b');

// The repo is checked out with CRLF endings, and a selection copied out of a
// rendered answer on Windows can carry them.
eq('carriage returns do not survive', quotePassage('a\r\nb'), '> a\n> b');
eq('a lone carriage return too', quotePassage('a\rb'), '> a\n> b');

eq('surrounding whitespace goes', quotePassage('  hi  '), '> hi');
eq('an empty selection makes no quote', quotePassage('   '), '');
eq('so does nothing at all', quotePassage(null), '');

/* ----------------------------------------------------------- the truncation */

const long = 'x'.repeat(SELECTION_LIMIT + 500);
const cut = quotePassage(long);
check('a huge passage is cut', cut.length < long.length, String(cut.length));
check('and says so', cut.endsWith('…'));
check('the cut is at the limit', cut.length <= SELECTION_LIMIT + 4, String(cut.length));
eq('a passage at the limit is untouched', quotePassage('y'.repeat(SELECTION_LIMIT)).endsWith('…'), false);

/* -------------------------------------------------------------- the message */

const built = buildSelectionPrompt('one\ntwo', 'Explain this in Korean.');
eq('passage first, instruction after', built, '> one\n> two\n\nExplain this in Korean.');
check('the instruction is on its own, unquoted', built.split('\n\n')[1] === 'Explain this in Korean.');
eq('nothing selected means nothing to send', buildSelectionPrompt('', 'Explain'), '');

// The four buttons and the four prompt keys have to stay in step; a missing
// key would silently send the key name to the model as the instruction.
eq('there are four actions', SELECTION_ACTIONS.length, 4);
const i18n = fs.readFileSync(path.resolve(HERE, '../src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const kind of SELECTION_ACTIONS) {
  const label = `'selection.${kind}':`;
  const prompt = `'selection.${kind}Prompt':`;
  eq(`every language labels "${kind}"`, (i18n.split(label).length - 1), 12);
  eq(`every language has the "${kind}" prompt`, (i18n.split(prompt).length - 1), 12);
}
// Each prompt names the answer language; without the placeholder a Korean UI
// gets an English answer about a Korean passage.
for (const line of i18n.split('\n').filter(l => l.includes('Prompt\':') && l.includes('selection.'))) {
  check(`the prompt names a language: ${line.trim().slice(0, 40)}…`, line.includes('{language}'));
}

/* ---------------------------------------------------- where the bar appears */

// A miniature of the parts of the DOM this asks about, since there is no
// document here: `closest` walking up a chain of parents is the whole of it.
const node = (className, parent = null) => {
  const self = {
    nodeType: 1,
    className,
    parentElement: parent,
    closest: (sel) => {
      const wanted = sel.split(' ').pop().replace('.', '');
      for (let n = self; n; n = n.parentElement) {
        if (String(n.className).split(' ').includes(wanted)) {
          // The selector is descendant-based: check the ancestry too.
          const outer = sel.split(' ')[0].split('.').filter(Boolean);
          for (let a = n; a; a = a.parentElement) {
            if (outer.every(c => String(a.className).split(' ').includes(c))) return n;
          }
          return null;
        }
      }
      return null;
    },
  };
  return self;
};
const answer = node('markdown-body', node('message-row assistant'));
const mine = node('markdown-body', node('message-row user'));
const sidebar = node('chat-list-item', node('sidebar'));

const sel = (text, anchor) => ({ toString: () => text, anchorNode: anchor });

eq('a passage in an answer counts', selectionTarget(sel('a real passage', answer)), 'a real passage');
eq('the same text in your own message does not', selectionTarget(sel('a real passage', mine)), null);
eq('nor in the sidebar', selectionTarget(sel('Chat about pandas', sidebar)), null);
eq('a stray tap is not a selection', selectionTarget(sel('a', answer)), null);
eq('whitespace is not a selection', selectionTarget(sel('   \n  ', answer)), null);
eq('the minimum is honoured', selectionTarget(sel('x'.repeat(SELECTION_MIN), answer)), 'x'.repeat(SELECTION_MIN));

// A selection anchor is usually a text node, which has no `closest` of its
// own — the element above it is what has to be asked.
const textNode = { nodeType: 3, parentElement: answer };
eq('a text node resolves through its parent', selectionTarget(sel('some words here', textNode)), 'some words here');
eq('a detached node is refused', selectionTarget(sel('some words here', { nodeType: 3, parentElement: null })), null);
eq('no selection at all is refused', selectionTarget(sel('some words', null)), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
