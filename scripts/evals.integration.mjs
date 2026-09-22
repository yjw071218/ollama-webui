// The marking pass, against a real judge.
//
// scripts/evals.test.mjs proves the arithmetic with the model stubbed: that a
// clamp clamps, that an unmarked case is not a regression, that the mean is
// over the marked cases only. None of that says whether a small local model
// can actually tell a right answer from a wrong one, which is the entire
// premise — a judge that returns 2 for everything makes the whole feature a
// number that moves with nothing.
//
// So this feeds it answers whose marks are known in advance, including the two
// that a naive judge gets wrong: a confident, fluent, detailed answer that is
// false, and a correct answer given in four words.
//
//   node scripts/evals.integration.mjs [model]
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.evals-live-bundle.mjs');
const MODEL = process.argv[2] || 'qwen3.6:35b-a3b';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/evals.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  buildJudgePrompt, judgeSchema, parseVerdict, summarise, compareRuns, parseSuite, isScorable,
} = await import(pathToFileURL(OUT).href);

try {
  const probe = await fetch(`${OLLAMA}/api/tags`);
  if (!probe.ok) throw new Error(String(probe.status));
} catch (e) {
  console.log(`SKIP  no Ollama at ${OLLAMA}; the judge cannot be tested`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const mark = async (testCase, answer) => {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      format: judgeSchema(),
      messages: buildJudgePrompt(testCase, answer),
      options: { temperature: 0, num_predict: 200, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return parseVerdict(data.message?.content || '');
};

/* Each row is an answer whose mark is known before the model sees it. `want`
   is the range that would have to hold for the marking to be worth anything --
   a range rather than a number, because 2 against 3 on a partial answer is a
   judgement call and 3 against 0 is not. */
const TRIALS = [
  {
    label: 'correct and complete',
    testCase: { question: 'What is the capital of Peru?', expect: 'Lima' },
    answer: 'The capital of Peru is Lima, on the Pacific coast.',
    want: [3, 3],
  },
  {
    // The failure a scale with no expectation cannot catch: fluent, detailed,
    // confident and false. A judge that rewards those marks it highly.
    label: 'confidently, fluently wrong',
    testCase: { question: 'What is the capital of Peru?', expect: 'Lima' },
    answer: 'The capital of Peru is Cusco. Situated high in the Andes at roughly '
      + '3,400 metres, Cusco has served as the seat of national government since '
      + 'the Republic was established, and today houses the Congress, the '
      + 'presidential palace and the supreme court.',
    want: [0, 1],
  },
  {
    // The other half of the same test: terse and right must beat long and wrong.
    label: 'correct in four words',
    testCase: { question: 'What is the capital of Peru?', expect: 'Lima' },
    answer: 'Lima.',
    want: [3, 3],
  },
  {
    label: 'right subject, does not contain the answer',
    testCase: {
      question: 'How much memory does the RTX 4080 have?',
      expect: '16 GB',
    },
    answer: 'The RTX 4080 is a very capable card for running language models locally, '
      + 'and its memory bandwidth is more than adequate for models of this size.',
    want: [0, 1],
  },
  {
    label: 'partly right',
    testCase: {
      question: 'Who wrote Dune, and when was it published?',
      expect: 'Frank Herbert; published 1965',
    },
    answer: 'Dune was written by Frank Herbert.',
    want: [1, 2],
  },
  {
    label: 'off topic entirely',
    testCase: { question: 'Who wrote Dune?', expect: 'Frank Herbert' },
    answer: 'Tomato plants prefer a deep soak two or three times a week.',
    want: [0, 0],
  },
];

console.log(`judge: ${MODEL}\n`);

const results = [];
for (const trial of TRIALS) {
  const verdict = await mark(trial.testCase, trial.answer);
  const score = verdict?.score;
  const [lo, hi] = trial.want;
  const ok = Number.isFinite(score) && score >= lo && score <= hi;
  console.log(`  ${ok ? ' ok ' : 'MISS'}  ${String(score).padStart(4)} (wanted ${lo}-${hi})  ${trial.label}`);
  console.log(`        why: ${verdict?.why || '(none)'}`);
  results.push({
    caseId: trial.label,
    question: trial.testCase.question,
    ...(Number.isFinite(score) ? { score, why: verdict.why } : {}),
    ms: 0,
    ok,
  });
}
console.log();

check('every answer came back with a usable mark',
  results.every(r => Number.isFinite(r.score)),
  JSON.stringify(results.map(r => r.score)));
check('a correct, complete answer is marked full', results[0].score === 3, String(results[0].score));

// The two that decide whether the whole feature means anything.
check('a fluent, confident, false answer is NOT marked highly', results[1].score <= 1,
  `${results[1].score}: ${results[1].why}`);
check('a correct answer of four words beats the long wrong one',
  results[2].score > results[1].score, `${results[2].score} vs ${results[1].score}`);
check('length did not decide it', results[2].score === 3, String(results[2].score));

check('an answer about the right subject that omits the fact is marked low',
  results[3].score <= 1, `${results[3].score}: ${results[3].why}`);
check('a half-answer lands between', results[4].score >= 1 && results[4].score <= 2,
  String(results[4].score));
check('an off-topic answer is zero', results[5].score === 0, String(results[5].score));
check('every mark carries a reason', results.every(r => r.why && r.why.length > 3),
  JSON.stringify(results.map(r => r.why)));

// ------------------------------------------------- the numbers over a run
const summary = summarise(results);
console.log(`\nrun: ${summary.percent}% (${summary.mean.toFixed(2)} of 3 over ${summary.scored} marked)`);
check('the summary marks every case', summary.scored === TRIALS.length);
check('nothing failed to be marked', summary.failed === 0 && summary.unscored === 0);
check('the worst case is one of the wrong ones',
  ['confidently, fluently wrong', 'off topic entirely', 'right subject, does not contain the answer']
    .includes(summary.worst[0].caseId), summary.worst[0].caseId);

// A second run where the wrong answers were fixed: the comparison has to see
// it as an improvement, and name the cases that moved.
const fixed = results.map(r => (r.score < 3 ? { ...r, score: 3 } : r));
const diff = compareRuns({ results }, { results: fixed });
console.log(`versus: ${diff.delta > 0 ? '+' : ''}${diff.delta.toFixed(2)}, ${diff.better} better, ${diff.worse} worse`);
check('an improved run reads as improved', diff.delta > 0 && diff.worse === 0);
check('and names the cases that moved', diff.moved.length === diff.better);

// ------------------------------------------------------------ a real suite
const SUITE = `What is the capital of Peru?
> Lima

Summarise the attached invoice.`;
const cases = parseSuite(SUITE);
check('a written suite parses into cases', cases.length === 2);
check('and only the one with an expectation is markable',
  cases.filter(isScorable).length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
