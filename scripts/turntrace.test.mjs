// Where the two minutes went.
//
// `turnMetrics` folds a turn into one line -- `12.4s ×3 · 31 tokens/s` -- and
// that was the whole of what could be found out. A turn is no longer one
// request: it answers, calls a search, answers again, draws a picture in the
// middle of a sentence, and hands the graphics card back and forth while doing
// it. "×3" is not an explanation of where the time went.
//
// Everything needed was already on the messages -- each leg's own figures, the
// tool results, the pictures -- and nothing read it. This is the reading, and
// it is tested away from React for the reason `turnMetrics` is: "which leg was
// slow" has a wrong answer that looks perfectly reasonable on screen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const { traceOf, slowestLeg } = await import(pathToFileURL(path.join(ROOT, 'src/turnTrace.js')).href);

/* ------------------------------------------------------------- one request */

{
  const steps = traceOf([
    { role: 'assistant', content: 'here you go', model: 'qwen3:30b',
      metrics: { totalTime: '3.20', tokensPerSec: '41.5', evalCount: 133, promptTokens: 900 } },
  ]);
  eq('a turn of one request is one step', steps.length, 1);
  eq('  which says what answered it', steps[0].model, 'qwen3:30b');
  eq('  and what it cost', [steps[0].seconds, steps[0].rate, steps[0].tokens], [3.2, 41.5, 133]);
  eq('  with nothing to point at', slowestLeg(steps), null);
}

/* -------------------------------------------- a turn that called a tool */

const searched = [
  { role: 'assistant', content: '<TOOL_WEB_SEARCH>weather</TOOL_WEB_SEARCH>', model: 'qwen3:30b',
    metrics: { totalTime: '1.10', tokensPerSec: '30.0', evalCount: 33 } },
  { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_WEB_SEARCH ---\nrain tomorrow\n</TOOL_RESULT>' },
  { role: 'assistant', content: 'It will rain.', model: 'qwen3:30b',
    metrics: { totalTime: '12.40', tokensPerSec: '20.0', evalCount: 248 } },
];
{
  const steps = traceOf(searched);
  eq('the steps are in the order they happened',
    steps.map(s => s.kind), ['answer', 'tools', 'answer']);
  eq('  the legs are numbered as legs', steps.filter(s => s.kind === 'answer').map(s => s.leg), [1, 2]);
  eq('  and the tool is named', steps[1].tools, [{ name: 'TOOL_WEB_SEARCH', failed: false }]);
  // The question behind opening this is "what took so long". On a turn where
  // one leg is most of it, that leg is worth pointing at.
  eq('the leg that was most of the turn is the one pointed at', slowestLeg(steps), 2);
}

/* A turn that took ninety seconds because a search failed twice is exactly the
   turn somebody is asking about. Failures are marked, not dropped. */
{
  const steps = traceOf([
    { role: 'assistant', content: 'x', metrics: { totalTime: '1.0' } },
    { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_FETCH_URL ---\nError running TOOL_FETCH_URL: timed out\n</TOOL_RESULT>' },
  ]);
  eq('a tool that failed says so', steps[1].tools, [{ name: 'TOOL_FETCH_URL', failed: true }]);
}

/* ------------------------------------------------ a turn that drew something */

{
  const steps = traceOf([
    { role: 'assistant', content: 'here it is', model: 'qwen3:30b',
      metrics: { totalTime: '2.0', tokensPerSec: '30.0', evalCount: 60 },
      generated: [{ dataUrl: 'x', call: 0 }, { dataUrl: 'y', call: 0 }] },
  ]);
  // Often where most of a minute went, and it is on the message already.
  eq('the pictures a leg drew are counted', steps[0].pictures, 2);
  eq('  and so are its songs', steps[0].songs, 0);
}

/* ------------------------------------------------------- what cannot be said */

{
  const steps = traceOf([
    { role: 'assistant', content: 'stopped half way', model: 'qwen3:30b' },
  ]);
  // A stopped stream, or a leg whose whole output was a tool call: there is
  // nothing honest to report, and a zero would read as a measurement.
  eq('a leg with no figures says it has none', [steps[0].unmeasured, steps[0].seconds], [true, null]);
  eq('  and is not counted as the slowest anything', slowestLeg(steps), null);
}
{
  // Two legs of about the same length: neither is the answer to "what took so
  // long", and pointing at one would be an invention.
  const steps = traceOf([
    { role: 'assistant', content: 'a', metrics: { totalTime: '5.0' } },
    { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_TIME ---\n12:00\n</TOOL_RESULT>' },
    { role: 'assistant', content: 'b', metrics: { totalTime: '5.0' } },
  ]);
  eq('nothing is pointed at when nothing stands out', slowestLeg(steps), null);
}
{
  const steps = traceOf([
    { role: 'assistant', content: 'a', metrics: { totalTime: '2.0', estimated: true } },
  ]);
  // Marked everywhere else. A trace that hid it would be the one place
  // implying the figures were measured.
  eq('a figure this machine guessed at is marked as one', steps[0].estimated, true);
}
eq('and nothing at all is no steps', traceOf(null), []);

/* ------------------------------------------------------------------ the wiring */

const app = read('src/App.jsx');
check('the time opens it', /className=\{`metrics-time \$\{traceFor === i \? 'is-on' : ''\}`\}/.test(app));
check('  one turn at a time', /setTraceFor\(traceFor === i \? null : i\)/.test(app));
check('  and it reads the group it is under', /const steps = traceOf\(group\);/.test(app));
check('  marking the leg most of the turn was spent in',
  /const worst = slowestLeg\(steps\);/.test(app) && /step\.leg === worst \? 'is-slowest' : ''/.test(app));
// The tools are named the way the receipts name them, not as TOOL_FOO.
check('  naming tools the way the rest of the app does', /t\(verbKey\(tool\.name\)\)/.test(app));

const i18n = read('src/i18n.jsx');
for (const key of ['trace.open', 'trace.answer', 'trace.drew', 'trace.unmeasured']) {
  check(`${key} is translated everywhere`,
    (i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length === 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
