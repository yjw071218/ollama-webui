// Reading several answers at once.
//
// Side-by-side comparison is useful for seeing that a 3B model is shallow and
// much less useful for the case people reach for it — a question where no one
// local model is reliable — because nobody reads three columns of four
// paragraphs three times.
//
// The trap this has to avoid is voting. Three models agreeing is three samples
// of overlapping training data, not three witnesses, and a shared
// misconception is exactly what they will all state confidently. So the prompt
// asks for agreement to be reported and never for a winner.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/consensus.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.consensus-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const C = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* -------------------------------------------------- which runs are opinions */

const runs = [
  { model: 'fast:3b', status: 'done', content: 'Grid is faster for two-dimensional layout.', metrics: { tokensPerSec: 90 } },
  { model: 'big:30b', status: 'done', content: '<think>hmm</think>\nFlexbox is faster for one-dimensional layout.', metrics: { tokensPerSec: 9 } },
  { model: 'broken:7b', status: 'error', content: '', error: 'HTTP 500' },
  { model: 'stopped:7b', status: 'stopped', content: 'half an ans' },
  { model: 'silent:7b', status: 'done', content: '   ' },
];

const answers = C.answersFor(runs);
eq('only the finished runs count', answers.length, 2);
// Reasoning is the model talking to itself, not an answer, and feeding it in
// invites the synthesis to comment on the deliberation instead of the claim.
check('and the reasoning is not part of the answer',
  !answers.find(a => a.model === 'big:30b').answer.includes('hmm'));
eq('a failed run is not an opinion', answers.some(a => a.model === 'broken:7b'), false);
eq('nor a stopped one', answers.some(a => a.model === 'stopped:7b'), false);
// Including it would invite the model to explain the silence.
eq('nor an empty one', answers.some(a => a.model === 'silent:7b'), false);

eq('two answers can be compared', C.canSynthesise(runs), true);
eq('one cannot', C.canSynthesise([runs[0]]), false);
eq('and none certainly cannot', C.canSynthesise([]), false);

/* ----------------------------------------------------------- the brief */

const prompt = C.consensusPrompt('Is grid faster than flexbox?', answers, 'Korean');
check('the question is in it', prompt.includes('Is grid faster than flexbox?'));
check('every model is named', prompt.includes('fast:3b') && prompt.includes('big:30b'));
check('attribution is by name rather than by number', /by name, exactly as written/i.test(prompt));
check('the four sections are asked for',
  /Agreed/.test(prompt) && /Disagreed/.test(prompt) && /Only one noticed/.test(prompt) && /Worth checking/.test(prompt));

// The rule the whole thing turns on.
check('agreement is explicitly not proof', /agreement is not proof/i.test(prompt));
check('and the reason is given', /not independent witnesses/i.test(prompt));
check('it is told not to answer the question itself', /do not answer the question yourself/i.test(prompt));
check('nor to add anything of its own', /do not add facts/i.test(prompt));
// A model asked to compare will pick a winner unless told not to, and a winner
// is exactly the conclusion three correlated samples cannot support.
check('and never to pick a winner', /do not declare a winner/i.test(prompt));
check('manufactured differences are pre-empted', /manufacturing differences/i.test(prompt));
check('the language is named', prompt.includes('Korean'));

const long = C.consensusPrompt('q', [{ model: 'm', answer: 'x'.repeat(9000) }]);
check('a very long answer is trimmed rather than dropped',
  long.includes('x'.repeat(100)) && long.length < 9000);

/* ------------------------------------------------------------- overlap */

// Explicitly not a measure of agreement: two answers can say opposite things
// in near-identical words. It answers one question -- are these even about the
// same thing -- which is the fastest useful signal on this screen.
const same = C.wordOverlap([
  { model: 'a', answer: 'the borrow checker rejects this because the lifetime is too short' },
  { model: 'b', answer: 'the borrow checker rejects this because the lifetime is too short' },
]);
eq('identical answers overlap completely', same, 1);

const different = C.wordOverlap([
  { model: 'a', answer: 'aardvark buffalo crocodile dolphin' },
  { model: 'b', answer: 'zebra yak walrus vulture' },
]);
eq('unrelated ones do not overlap at all', different, 0);
check('and a real pair lands in between',
  C.wordOverlap([
    { model: 'a', answer: 'grid handles two dimensional layout better' },
    { model: 'b', answer: 'flexbox handles one dimensional layout better' },
  ]) > 0);
eq('one answer has nothing to overlap with', C.wordOverlap([{ model: 'a', answer: 'x' }]), null);
eq('and neither does none', C.wordOverlap([]), null);
// No stoplist. "the" counts, and so do "CSS", "GPU" and "map"; a list of
// function words would have to exist in twelve languages to be fair here. It
// is why this is documented as resemblance of *wording* and never presented
// as agreement.
eq('function words are counted like any other, and the measure says so',
  C.wordOverlap([{ model: 'a', answer: 'the and but' }, { model: 'b', answer: 'the and but' }]), 1);
eq('a word shorter than three letters is not a word here',
  C.wordOverlap([{ model: 'a', answer: 'a b c' }, { model: 'b', answer: 'a b c' }]), null);

/* -------------------------------------------------------- who does the reading */

// A second wait after a wait people have already sat through, and comparing
// texts in front of you is a much easier job than the original question.
eq('the fastest model that answered reads them', C.pickJudge(runs), 'fast:3b');
eq('unless one was asked for', C.pickJudge(runs, 'big:30b'), 'big:30b');
eq('a model that did not answer cannot read', C.pickJudge(runs, 'broken:7b'), 'fast:3b');
eq('and nothing answered is nobody', C.pickJudge([]), '');
eq('a run with no timings is still eligible',
  C.pickJudge([{ model: 'a', status: 'done', content: 'x' }]), 'a');

/* ------------------------------------------------------------- the wiring */

const compare = fs.readFileSync(path.join(ROOT, 'src/ModelCompare.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the compare screen can synthesise', /consensusPrompt\(/.test(compare));
check('offered only when there are answers to compare', /canSynthesise\(/.test(compare));
check('the reading model is chosen rather than assumed', /pickJudge\(/.test(compare));
check('and the result is streamed like every other answer',
  /consensus/.test(compare) && /getReader\(\)/.test(compare));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['compare.synthesise', 'compare.consensus', 'compare.judge', 'compare.overlap']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['compare-consensus', 'compare-judge']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
