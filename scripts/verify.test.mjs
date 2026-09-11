// Checking an answer against what it was given.
//
// A local model's failure mode is not being wrong loudly; it is one wrong
// sentence in nine, in the same confident register as the other eight. This is
// the second pass that catches it — a comparison with both texts in front of
// the model, which is a job small models are markedly better at than writing.
//
// The trap is false assurance. An answer written from memory cannot be checked
// against that same memory, and a page of green ticks saying it was is worse
// than no feature at all: it converts uncertainty into confidence.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/verify.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.verify-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const V = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- what it was given */

const grounded = [
  {
    role: 'user',
    content: 'When was Rust 1.0 released?\n\n--- [Grounding] Web results for "rust 1.0" ---\n'
      + '[1] Rust 1.0 shipped on 15 May 2015.\n'
      + '--- Cite these as [1] when you use them. ---',
  },
  {
    role: 'assistant',
    content: 'Rust 1.0 shipped in May 2015 [1]. It was the first stable release.',
    citations: [{ url: 'https://example', docName: 'Rust blog', text: 'Announcing Rust 1.0, 15 May 2015.' }],
  },
];

const evidence = V.evidenceFor(grounded, 1);
check('the injected block is evidence', evidence.includes('15 May 2015'));
check('and so is a citation', evidence.includes('Announcing Rust 1.0'));
check('labelled by where it came from', evidence.includes('[Grounding]') && evidence.includes('[Source]'));

// The block is the evidence, not the question. Leaving it in would make the
// question five hundred words of search results.
const question = V.questionFor(grounded, 1);
eq('the question is the question', question, 'When was Rust 1.0 released?');
check('with the injected block taken out', !question.includes('Grounding'));

eq('an answer with nothing behind it has no evidence',
  V.evidenceFor([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], 1), '');
eq('and no messages at all does not throw', V.evidenceFor([], 0), '');
eq('nor does asking for the question of nothing', V.questionFor([], 0), '');

/* ------------------------------------------------------------ the two briefs */

const withSources = V.verifyPrompt({
  question: 'When was Rust 1.0 released?',
  answer: 'Rust 1.0 shipped in May 2015.',
  evidence: '[1] Rust 1.0 shipped on 15 May 2015.',
  language: 'Korean',
});
check('the sources are in the brief', withSources.includes('15 May 2015'));
check('and so is the answer', withSources.includes('Rust 1.0 shipped in May 2015.'));
check('it is told to use nothing else', /Do not use anything else you know/i.test(withSources));
check('all three verdicts are offered', /\[supported\]/.test(withSources)
  && /\[unsupported\]/.test(withSources) && /\[contradicted\]/.test(withSources));
// Different findings. "No source mentions this" is not "a source says
// otherwise", and collapsing them would make every gap look like an error.
check('and the difference between them is spelled out', /unsupported, not contradicted/i.test(withSources));
check('quoting is required', /word for word/i.test(withSources));
check('and invented objections are pre-empted', /invented objection is worse/i.test(withSources));
check('the language is named', withSources.includes('Korean'));

// The half that matters. An answer written from memory cannot be checked
// against the same memory, and saying it was is the failure this must not have.
const fromMemory = V.verifyPrompt({ question: 'q', answer: 'Some claim.', evidence: '' });
check('with no sources it says so outright', /no sources/i.test(fromMemory));
check('and explains why checking is impossible', /same memory/i.test(fromMemory));
check('nothing may be marked supported', /Do not mark anything as supported/i.test(fromMemory));
check('so the only verdict offered is "unchecked"', /\[unchecked\]/.test(fromMemory));
check('and "supported" is not offered as an option', !/\[supported\]/.test(fromMemory));
check('a way to check is asked for instead', /how to check it/i.test(fromMemory));

check('a silent pass has a way to say nothing', /NOTHING TO CHECK/.test(withSources));

/* -------------------------------------------------------------- reading it back */

let verdicts = V.parseVerdicts(`
Here is my check:
[supported] "shipped in May 2015" — source [1] gives 15 May 2015
- [unsupported] "It was the first stable release" — no source says this
* [contradicted] "written in C" — the source says Rust
`);
eq('every verdict line is read', verdicts.length, 3);
eq('the verdict', verdicts[0].verdict, 'supported');
eq('the quote', verdicts[0].quote, 'shipped in May 2015');
check('and the reason', verdicts[0].note.includes('15 May 2015'));
eq('a bullet in front changes nothing', verdicts[1].verdict, 'unsupported');
eq('and an asterisk neither', verdicts[2].verdict, 'contradicted');
check('the preamble is not a verdict', !verdicts.some(v => /Here is my check/.test(v.quote)));

// Models repeat themselves when they have run out of things to say and have
// budget left.
eq('the same claim twice is one verdict',
  V.parseVerdicts('[supported] "a claim" — x\n[supported] "A CLAIM" — y').length, 1);
eq('curly quotes are quotes', V.parseVerdicts('[supported] “a claim” — why').length, 1);
eq('reasoning is stripped first',
  V.parseVerdicts('<think>[supported] "not a real one" — x</think>\n[supported] "real" — y')[0].quote, 'real');
eq('a clean pass is no verdicts, not a parse failure', V.parseVerdicts('NOTHING TO CHECK').length, 0);
eq('and prose with no verdict lines is none', V.parseVerdicts('It all looks fine to me.').length, 0);
eq('nothing at all is none', V.parseVerdicts('').length, 0);
eq('a verdict with no reason is still a verdict',
  V.parseVerdicts('[unsupported] "a claim"').length, 1);

/* ------------------------------------------------------- did it quote the answer */

// The likeliest way this misleads anybody: a verdict about words the answer
// does not contain is a verdict about something the checker made up.
const answer = 'Rust 1.0 shipped in May  2015. It was the first stable release.';
const located = V.locateQuotes([
  { verdict: 'supported', quote: 'shipped in May 2015', note: '' },
  { verdict: 'contradicted', quote: 'written in C', note: '' },
], answer);
// Whitespace is normalised on both sides, or a line wrap in the answer makes a
// perfectly good quote look invented.
eq('a real quote is found even across odd spacing', located[0].found, true);
eq('and one that is not there is marked', located[1].found, false);
// Marked rather than dropped: "the checker quoted something that is not in the
// answer" is itself worth seeing.
eq('but it is kept, not thrown away', located.length, 2);

/* --------------------------------------------------------------- the summary */

let summary = V.summariseVerdicts(verdicts);
eq('supported claims are counted', summary.supported, 1);
eq('and the problems together', summary.problems, 2);
eq('an answer with problems is not clean', summary.clean, false);

summary = V.summariseVerdicts([{ verdict: 'supported', quote: 'a' }, { verdict: 'supported', quote: 'b' }]);
eq('one with none is', summary.clean, true);
// Not the same as "verified": a check that found nothing to check has not
// established anything.
eq('but nothing checked at all is not clean either', V.summariseVerdicts([]).clean, false);
eq('and unchecked claims are their own count',
  V.summariseVerdicts([{ verdict: 'unchecked', quote: 'a' }]).unchecked, 1);
eq('which are not problems', V.summariseVerdicts([{ verdict: 'unchecked', quote: 'a' }]).problems, 0);
// The one that matters most. Every verdict on an answer written from memory is
// "unchecked", and "no problems found" there means nothing was checked -- the
// opposite finding, with the same problem count.
eq('but a pass that checked nothing is never clean',
  V.summariseVerdicts([{ verdict: 'unchecked', quote: 'a' }, { verdict: 'unchecked', quote: 'b' }]).clean, false);

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('an answer can be checked', /const verifyAnswer = /.test(code));
check('against the evidence its own turn was given', /evidenceFor\(/.test(code));
check('the verdicts are parsed rather than shown raw', /parseVerdicts\(/.test(code));
check('and each is located in the answer', /locateQuotes\(/.test(code));
check('the result is kept on the message', /verification/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['verify.action', 'verify.running', 'verify.clean', 'verify.noSources',
  'verify.toCheck', 'verify.verdict.unsupported', 'verify.notInAnswer']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['verify-panel', 'verify-verdict']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
