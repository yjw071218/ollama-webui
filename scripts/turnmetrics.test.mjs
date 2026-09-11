// The footer that appeared and then vanished.
//
// "tokens/s가 나왔다가 바로 사라지는 경우가 있어." It was not a render glitch.
// Two separate things were wrong, and they compounded:
//
//   * The tool loop restarts a turn by handing `handleSend` a whole new
//     message array, and it built the finished reply as a bare
//     `{ role: 'assistant', content }` beside a snapshot taken *before* the
//     reply began. Everything the `done` frame had written a tenth of a
//     second earlier — timings, model, citations — was deleted from the record.
//   * The footer read `group[group.length - 1].metrics`, and a group is the
//     whole run of bubbles that make up one answer. A turn that called a tool
//     ends on a tool result, which has no metrics at all.
//
// So the first half is checked against src/App.jsx itself (the bug was the
// shape of an object literal, and there is nothing else to assert it on) and
// the second against the function that replaced the expression.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({
  input: path.resolve(ROOT, 'src/turnMetrics.js'),
  platform: 'neutral',
});
const out = path.resolve(ROOT, 'node_modules/.turnmetrics-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { turnMetrics } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const leg = (totalTime, tokensPerSec, evalCount, promptTokens) =>
  ({ metrics: { totalTime, tokensPerSec, evalCount, promptTokens } });

/* -------------------------------------------------------- the ordinary case */

const plain = [leg('12.00', '31.40', 100, 222)];
eq('one request reports itself', turnMetrics(plain).totalTime, '12.00');
check('and is handed back unchanged', turnMetrics(plain) === plain[0].metrics);
eq('with no leg count to explain', turnMetrics(plain).legs, undefined);

/* ------------------------------------------------- the group that had none */

// This is what the reader saw: the answer arrives, the numbers appear, the
// tool result is appended, and the last message in the group has no metrics.
const withToolResult = [
  leg('12.00', '31.40', 100, 222),
  { role: 'user', content: '<TOOL_RESULT>…</TOOL_RESULT>' },
];
check('a trailing tool result does not blank the footer', !!turnMetrics(withToolResult));
eq('it still says what the answer cost', turnMetrics(withToolResult).totalTime, '12.00');

const withSecondLeg = [
  leg('12.00', '31.40', 100, 222),
  { role: 'assistant', content: 'still going', metrics: null },
];
check('nor does a leg that has not finished', !!turnMetrics(withSecondLeg));

eq('a turn with nothing measured has nothing to say', turnMetrics([{ role: 'assistant', content: 'x' }]), null);
eq('neither does an empty group', turnMetrics([]), null);
eq('nor a missing one', turnMetrics(null), null);
eq('nor a value that is not a list', turnMetrics('nonsense'), null);

/* ----------------------------------------------------------- adding it up */

// A search that took twelve seconds and a two-second reply after it is a
// fourteen-second turn. Reporting the last leg alone said "2.00s".
const roundTrip = [
  leg('12.00', '10.00', 100, 222),
  { role: 'user', content: '<TOOL_RESULT>…</TOOL_RESULT>' },
  leg('2.00', '50.00', 50, 1400),
];
const spent = turnMetrics(roundTrip);
eq('the time is what the reader waited', spent.totalTime, '14.00');
eq('the tokens generated are the total', spent.evalCount, 150);
eq('and the turn says how many requests it took', spent.legs, 2);

// 100 tokens at 10/s is 10 seconds; 50 at 50/s is one. 150 tokens in 11
// seconds is 13.64/s -- not the 30 that averaging the two rates would give,
// because the fast leg was a twentieth of the work.
eq('the rate is weighted by the work, not by the leg', spent.tokensPerSec, '13.64');

// Read as "how full is the context", and the composer's gauge reads the same
// field. Adding the legs would count one conversation twice.
eq('the prompt size is the latest, not the sum', spent.promptTokens, 1400);

/* ------------------------------------------------------------- the details */

const detailed = [
  { metrics: { totalTime: '3.00', tokensPerSec: '10.00', evalCount: 30, promptTokens: 10, ttft: 800, load: 2000, promptEval: 120 } },
  { metrics: { totalTime: '1.00', tokensPerSec: '10.00', evalCount: 10, promptTokens: 90, ttft: 40, load: 0, promptEval: 300 } },
];
const folded = turnMetrics(detailed);
eq('time-to-first-token is when the reader first saw something', folded.ttft, 800);
eq('loading time is summed', folded.load, 2000);
eq('so is the time spent reading the prompt', folded.promptEval, 420);

/* -------------------------------------------------- the awkward arithmetic */

// A leg that was stopped part-way through has a time but no rate. It should
// still count towards the clock, and not poison the average.
const halfMeasured = [
  { metrics: { totalTime: '5.00', tokensPerSec: null, evalCount: 0, promptTokens: 100 } },
  leg('5.00', '20.00', 100, 200),
];
eq('an unmeasured leg still costs time', turnMetrics(halfMeasured).totalTime, '10.00');
eq('but does not drag the rate down', turnMetrics(halfMeasured).tokensPerSec, '20.00');

const noRates = [
  { metrics: { totalTime: '5.00', tokensPerSec: null, evalCount: 0, promptTokens: 100 } },
  { metrics: { totalTime: '2.00', tokensPerSec: null, evalCount: 0, promptTokens: 200 } },
];
eq('with no rate anywhere there is no rate to show', turnMetrics(noRates).tokensPerSec, null);
eq('though the clock still runs', turnMetrics(noRates).totalTime, '7.00');

/* ------------------------------------------- the object the tool loop built */

// The bug that deleted the numbers. `finishedLeg()` carries the finished
// message forward; the literal it replaced did not, and a literal is all
// there is to assert on.
const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

const restarts = [...app.matchAll(/const nextMessages = \[\s*\n\s*\.\.\.initialMessages,\s*\n\s*([^\n]*)/g)]
  .map(m => m[1].trim());
check('the tool loop restarts the turn in two places', restarts.length === 2, JSON.stringify(restarts));
for (const line of restarts) {
  check(`it carries the finished reply forward: ${line}`, line.startsWith('finishedLeg()'));
}

// And what `finishedLeg` carries. A reply that reaches the next leg without
// its metrics is the bug, exactly.
const built = app.slice(app.indexOf('const finishedLeg = () => ({'));
const body = built.slice(0, built.indexOf('});'));
for (const field of ['metrics', 'model', 'citations', 'content']) {
  check(`the reply keeps its ${field}`, body.includes(field));
}

// Nothing else may rebuild an assistant message from `assistantContent` alone.
const bare = (app.match(/\{\s*role:\s*'assistant',\s*content:\s*assistantContent\s*\}/g) || []).length;
eq('and no bare literal is left to reintroduce it', bare, 0);

// The footer reads the whole group. The expression it replaced is the one to
// watch for, because it looks perfectly reasonable.
check('the footer no longer reads only the last bubble',
  !app.includes('group[group.length - 1].metrics'));
check('it folds the group instead', app.includes('turnMetrics(group)'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
