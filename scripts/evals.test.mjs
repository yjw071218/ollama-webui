// Marking, summarising and comparing runs. Every number this feature shows
// comes from one of these functions, so every way one of them can mislead is
// asserted here.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.evals-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/evals.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  SCALE, MAX_SCORE, isScorable, buildJudgePrompt, parseVerdict,
  summarise, compareRuns, describeRun, parseSuite, formatSuite,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------------ scorable
check('a case with an expectation can be marked', isScorable({ question: 'q', expect: 'a' }));
// A suite that refuses ungradeable questions is one people stop adding to.
check('one without cannot', !isScorable({ question: 'q' }));
check('whitespace is not an expectation', !isScorable({ question: 'q', expect: '   ' }));

// ------------------------------------------------------------------- prompt
const messages = buildJudgePrompt({ question: 'Capital of Peru?', expect: 'Lima' }, 'It is Lima.');
check('the rubric is in the prompt verbatim', messages[0].content.includes(SCALE[0]));
check('the question is included', messages[1].content.includes('Capital of Peru?'));
check('so is the expectation', messages[1].content.includes('Lima'));
check('and the answer being marked', messages[1].content.includes('It is Lima.'));
// The failure this rubric line exists to stop.
check('the judge is told not to reward length', /reward length or confidence/.test(messages[0].content));
check('and not to use what it knows', /Do not use anything you know/.test(messages[0].content));
check('a very long answer is cut before it is sent',
  buildJudgePrompt({ question: 'q', expect: 'e' }, 'x'.repeat(20000))[1].content.length < 8000);

// ------------------------------------------------------------------ verdict
check('a verdict is read', parseVerdict('{"score":2,"why":"missed the date"}').score === 2);
check('the reason comes with it', parseVerdict('{"score":2,"why":"missed the date"}').why === 'missed the date');
check('an object is accepted as well as text', parseVerdict({ score: 3, why: 'ok' }).score === 3);

// A judge that says 5 has said "as good as it gets"; throwing that away loses
// a real judgement over a formatting mistake.
check('a score above the scale is clamped', parseVerdict('{"score":9,"why":"x"}').score === MAX_SCORE);
check('a negative one is clamped to zero', parseVerdict('{"score":-4,"why":"x"}').score === 0);
check('a fractional one is rounded', parseVerdict('{"score":2.4,"why":"x"}').score === 2);

// The distinction that must never be flattened: "this answer is bad" is a
// result, "the marking did not happen" is a bug.
check('invalid JSON is a failed marking, not a zero', parseVerdict('not json') === null);
check('a reply with no score is a failed marking', parseVerdict('{"why":"hmm"}') === null);
check('a non-numeric score is a failed marking', parseVerdict('{"score":"good"}') === null);
check('a missing reason is not fatal', parseVerdict('{"score":1}').why === '');

// ---------------------------------------------------------------- summarise
const results = [
  { caseId: 'a', score: 3, ms: 1000 },
  { caseId: 'b', score: 1, ms: 2000 },
  { caseId: 'c', ms: 500 },                       // no expectation: unscored
  { caseId: 'd', error: 'model refused', ms: 100 },
];
const sum = summarise(results);

check('the mean is over the scored cases only', sum.mean === 2, String(sum.mean));
// A suite whose expectations were half written would otherwise look better
// than it is.
check('the unscored are counted separately', sum.unscored === 1 && sum.scored === 2);
check('so are failures', sum.failed === 1);
check('the total is every case', sum.total === 4);
check('the percentage carries the scale', sum.percent === 67, String(sum.percent));
check('time is added up', sum.ms === 3600);
check('the worst come first', sum.worst[0].caseId === 'b');
check('a perfect count is kept', sum.perfect === 1);

const nothing = summarise([]);
check('an empty run has no mean rather than zero', nothing.mean === null && nothing.percent === null);
check('and nothing else either', nothing.total === 0 && nothing.worst.length === 0);
check('nothing at all is safe', summarise(null).total === 0);

// A run where every case failed must not read as a score of zero.
const allFailed = summarise([{ caseId: 'a', error: 'x' }, { caseId: 'b', error: 'y' }]);
check('a run that wholly failed has no mean', allFailed.mean === null);
check('and says so', allFailed.failed === 2);

// ------------------------------------------------------------------ compare
const before = { results: [
  { caseId: 'a', score: 1, question: 'one' },
  { caseId: 'b', score: 2, question: 'two' },
  { caseId: 'c', score: 3, question: 'three' },
  { caseId: 'gone', score: 3, question: 'removed since' },
] };
const after = { results: [
  { caseId: 'a', score: 3, question: 'one' },
  { caseId: 'b', score: 2, question: 'two' },
  { caseId: 'c', score: 1, question: 'three' },
  { caseId: 'new', score: 2, question: 'added since' },
] };
const diff = compareRuns(before, after);

check('improvements are counted', diff.better === 1);
check('regressions too', diff.worse === 1);
check('and cases that held', diff.same === 1);
// By case id, not by position: comparing the fourth row against the fourth is
// how one deleted question makes every later case look like it moved.
check('a case only the new run has is not a change', diff.added === 1 && diff.better === 1);
check('and one only the old run had is not either', diff.dropped === 1);
check('the mean movement is reported', Math.abs(diff.delta - (2 - 2.25)) < 1e-9, String(diff.delta));
check('the worst regression is listed first', diff.moved[0].caseId === 'c', JSON.stringify(diff.moved));
check('and it carries its question', diff.moved[0].question === 'three');

check('comparing against nothing is safe', compareRuns(null, after).better === 0);
// A case that failed to be marked in one run cannot be said to have moved.
const unmarked = compareRuns(
  { results: [{ caseId: 'a', score: 2 }] },
  { results: [{ caseId: 'a', error: 'judge failed' }] },
);
check('an unmarked case is not a regression', unmarked.worse === 0 && unmarked.better === 0);

// ------------------------------------------------------------------- suites
const SUITE = `What is the capital of Peru?
> Lima

Summarise the attached invoice.

Who wrote Dune?
> Frank Herbert
> Published 1965`;

const cases = parseSuite(SUITE);
check('a suite is one case per block', cases.length === 3, String(cases.length));
check('the question is the unprefixed lines', cases[0].question === 'What is the capital of Peru?');
check('the expectation is the > lines', cases[0].expect === 'Lima');
check('a case with no expectation is kept', cases[1].expect === '' && isScorable(cases[1]) === false);
check('several expectation lines join up', cases[2].expect === 'Frank Herbert Published 1965');
check('every case gets an id', new Set(cases.map(c => c.id)).size === 3);

check('it round-trips', parseSuite(formatSuite(cases)).map(c => c.question).join('|')
  === cases.map(c => c.question).join('|'));
check('an empty suite is empty', parseSuite('').length === 0);
check('a block with only an expectation is not a case', parseSuite('> orphan').length === 0);
check('stray blank lines do not make cases', parseSuite('q\n\n\n\n').length === 1);

// -------------------------------------------------------------------- label
check('a run says what it was',
  describeRun({ model: 'qwen3:8b', promptName: 'Terse', settings: { temperature: 0.2 } })
    === 'qwen3:8b · prompt: Terse · temp 0.2');
check('and leaves out what it does not know', describeRun({ model: 'x' }) === 'x');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
