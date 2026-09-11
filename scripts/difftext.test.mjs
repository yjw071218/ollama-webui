// What changed between two answers.
//
// Regenerating already keeps both and offers a "2 / 3" pager. What it does not
// say is the thing you regenerated to find out: whether the second attempt is
// different, and where. Six hundred words four minutes apart is not something
// anybody compares from memory.
//
// The two traps are the unit and the cost. Character diffs of prose produce
// confetti; line diffs mark a whole paragraph for one changed word. And the
// obvious algorithm is quadratic, which for two long answers is a frozen tab.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/diffText.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.difftext-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const D = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const text = (parts, type) => parts.filter(p => p.type === type).map(p => p.text).join('').trim();
const rejoin = (parts, side) => parts
  .filter(p => p.type === 'same' || p.type === (side === 'before' ? 'remove' : 'add'))
  .map(p => p.text)
  .join('');

/* ------------------------------------------------------------- tokenising */

// Rejoining the tokens has to reproduce the original exactly. A diff that
// silently normalises whitespace is one you cannot trust about code, and half
// these answers are code.
const roundTrip = (s) => D.tokenise(s).join('') === s;
check('tokens rejoin to the original', roundTrip('one two three'));
check('including the indentation', roundTrip('  def f():\n      return 1\n'));
check('and the blank lines', roundTrip('a\n\n\nb'));
check('and trailing space', roundTrip('a   '));
eq('nothing tokenises to nothing', D.tokenise('').length, 0);
eq('and so does undefined', D.tokenise(undefined).length, 0);

/* ---------------------------------------------------------------- the diff */

let { parts } = D.diffText('the cat sat on the mat', 'the cat sat on the rug');
eq('what was removed', text(parts, 'remove'), 'mat');
eq('what was added', text(parts, 'add'), 'rug');
check('and the rest is untouched', text(parts, 'same').startsWith('the cat sat on the'));

// Both sides must be reconstructible, or the rendering is showing something
// neither model actually wrote.
check('the before text can be rebuilt', rejoin(parts, 'before') === 'the cat sat on the mat');
check('and the after text too', rejoin(parts, 'after') === 'the cat sat on the rug');

parts = D.diffText('same words entirely', 'same words entirely').parts;
eq('identical answers are one unchanged run', parts.length, 1);
eq('and it is marked unchanged', parts[0].type, 'same');

parts = D.diffText('', 'a whole new answer').parts;
eq('everything is an addition when there was nothing', text(parts, 'add'), 'a whole new answer');
parts = D.diffText('an answer that vanished', '').parts;
eq('and a removal when nothing is left', text(parts, 'remove'), 'an answer that vanished');

// One `<ins>`, not forty. Adjacent runs of the same kind are joined, or the
// markup is unreadable and the styling flickers word by word.
parts = D.diffText('a b c', 'a x y z c').parts;
eq('a run of additions is one run', parts.filter(p => p.type === 'add').length, 1);

// Word-level, not character-level: "cats" against "cat" is one changed word,
// not a kept "cat" and an added "s".
parts = D.diffText('the cat', 'the cats').parts;
eq('a changed word is a whole word', text(parts, 'add'), 'cats');
eq('and its predecessor a whole word', text(parts, 'remove'), 'cat');

// Word-level, not line-level: changing one word in a paragraph must not mark
// the paragraph, which is exactly the information the diff exists to remove.
const para = 'Grid handles two dimensional layout, and flexbox handles one dimensional layout, so the answer depends on what you are building.';
parts = D.diffText(para, para.replace('two', 'three')).parts;
eq('one changed word in a paragraph is one changed word', text(parts, 'add'), 'three');
check('the paragraph is not marked wholesale', text(parts, 'same').length > 80);

/* --------------------------------------------------------------- the cost */

// Regenerations usually share an opening and a closing. Stripping the common
// head and tail first is often the difference between nine million cells and
// nine thousand.
const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
const started = Date.now();
const big = D.diffText(long, `${long} and one more`);
check('two long, near-identical answers diff quickly', Date.now() - started < 500,
  `${Date.now() - started}ms`);
eq('and the difference is found', text(big.parts, 'add'), 'and one more');
eq('without falling back to paragraphs', big.coarse, false);

// Two long answers that share nothing cannot be done word by word in any
// reasonable time, so they are done by paragraph and say so.
const alpha = Array.from({ length: 1200 }, (_, i) => `alpha${i}`).join(' ');
const beta = Array.from({ length: 1200 }, (_, i) => `beta${i}`).join(' ');
const coarse = D.diffText(alpha, beta);
eq('two long, unrelated answers fall back', coarse.coarse, true);
// The caller shows that it happened: a paragraph marked wholly changed when
// one word moved is a lie the reader has no way to detect.
check('and there is still a diff to show', coarse.parts.length > 0);

/* ------------------------------------------------------------- the summary */

let summary = D.summariseDiff(D.diffText('one two three four', 'one two THREE four five').parts);
eq('added words are counted', summary.added, 2);
eq('removed ones too', summary.removed, 1);
eq('and the untouched ones', summary.same, 3);
eq('a real change is not identical', summary.identical, false);

// Worth naming: two regenerations of a deterministic prompt really can come
// back the same, and being told so beats squinting at an empty diff.
summary = D.summariseDiff(D.diffText('exactly the same', 'exactly the same').parts);
eq('nothing changed is said outright', summary.identical, true);
eq('with nothing added', summary.added, 0);
eq('and nothing removed', summary.removed, 0);

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the transcript can diff two variants', /diffText\(/.test(code));
check('offered only where there is more than one', /variantCount\(/.test(code));
check('it compares against the previous one by default', /variantIndexOf\([^)]*\) - 1/.test(code));
check('and says when nothing changed', /identical/.test(code));
check('the coarse fallback is disclosed', /coarse/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['diff.show', 'diff.hide', 'diff.identical', 'diff.summary', 'diff.coarse']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['variant-diff', 'diff-add', 'diff-remove']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
