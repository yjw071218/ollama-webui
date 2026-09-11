// The numbers behind "which of these models is worth running here".
//
// Ollama reports precise timings at the end of every generation. The app
// showed two of them under the answer and forgot the rest, which is the wrong
// way round: a single answer's speed is noise — it depends on what else wanted
// the GPU, whether the weights had just been loaded, and how long the prompt
// was — while the same measurement taken forty times answers a question that
// cannot be answered any other way. Whether a 30B model fits in this machine's
// VRAM is a property of the pair, and nothing about the file says which side
// of the line it falls on.
//
// So the arithmetic matters, and it is the arithmetic this file checks.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const map = new Map();
globalThis.localStorage = {
  get length() { return map.size; },
  key: (i) => [...map.keys()][i] ?? null,
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
};

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/perf.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.perf-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { recordRun, loadRuns, clearRuns, summarise, median, promptCostTrend } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const KEY = 'perfRuns:srv-abc';

/* ------------------------------------------------------------ the median */

// A mean would follow the outlier; the median describes the run you are going
// to get. That is the whole reason this is not an average.
eq('median of an odd count', median([10, 30, 20]), 20);
eq('median of an even count', median([10, 20, 30, 40]), 25);
eq('one slow run does not move it', median([30, 31, 32, 33, 2]), 31);
eq('an empty set has no median', median([]), null);
eq('rubbish is ignored', median([10, NaN, 20, undefined, 30]), 20);

/* -------------------------------------------------------- what is recorded */

clearRuns(KEY);
recordRun(KEY, { model: 'fast:7b', tokensPerSec: 40, ttft: 300, load: 0, promptEval: 120, outTokens: 200 });
recordRun(KEY, { model: 'fast:7b', tokensPerSec: 44, ttft: 280, load: 0, promptEval: 140, outTokens: 220 });
recordRun(KEY, { model: 'slow:70b', tokensPerSec: 3, ttft: 9000, load: 8000, promptEval: 900, outTokens: 150 });
eq('runs are kept', loadRuns(KEY).length, 3);

// A stopped turn, or a model that reports no timings, must not be averaged in
// as a zero — it would drag a model's figure down for something that is not
// about the model.
recordRun(KEY, { model: 'fast:7b', tokensPerSec: 0 });
recordRun(KEY, { model: 'fast:7b', tokensPerSec: null });
recordRun(KEY, { model: 'fast:7b' });
eq('a run with no usable speed is not recorded', loadRuns(KEY).length, 3);
recordRun(KEY, { tokensPerSec: 20 });
eq('nor is one with no model', loadRuns(KEY).length, 3);

/* ------------------------------------------------------------ the summary */

const rows = summarise(loadRuns(KEY));
eq('one row per model', rows.length, 2);
eq('fastest first', rows[0].model, 'fast:7b');
eq('the speed is the median of that model\'s runs', rows[0].tokensPerSec, 42);
eq('and the counts are per model', rows[0].runs, 2);
eq('so is the first-word time', rows[0].ttft, 290);

// Loading the weights is not the model generating slowly, and folding it into
// the speed would say that it was.
const slow = rows.find(r => r.model === 'slow:70b');
eq('a cold load is counted separately', slow.coldLoads, 1);
eq('with its own time', slow.loadTime, 8000);
eq('and a warm run counts no load', rows[0].coldLoads, 0);
eq('total output is summed', rows[0].totalTokens, 420);

/* ------------------------------------ a conversation slowing itself down */

// Reading the prompt is work that grows with the chat while the answer stays
// the same size, so a long conversation gets slower in a way that looks like
// the model getting worse. Saying so is the one piece of advice these numbers
// can actually support — and saying it wrongly is unwelcome, hence the
// conservative thresholds.
clearRuns(KEY);
for (const promptEval of [100, 110, 105, 120, 115, 130, 125, 140, 600, 650, 700, 720]) {
  recordRun(KEY, { model: 'chatty:8b', tokensPerSec: 30, promptEval });
}
const trend = promptCostTrend(loadRuns(KEY), 'chatty:8b');
check('a conversation whose prompt cost has grown is noticed', !!trend, JSON.stringify(trend));
check('and the ratio is real', trend && trend.ratio >= 2, JSON.stringify(trend));

clearRuns(KEY);
for (const promptEval of [100, 110, 105, 120, 115, 130, 125, 140, 120, 135]) {
  recordRun(KEY, { model: 'steady:8b', tokensPerSec: 30, promptEval });
}
check('a steady conversation is left alone', promptCostTrend(loadRuns(KEY), 'steady:8b') === null);

// Two runs is an anecdote, and telling somebody their chat is too long on that
// basis is worse than saying nothing.
clearRuns(KEY);
recordRun(KEY, { model: 'new:8b', tokensPerSec: 30, promptEval: 100 });
recordRun(KEY, { model: 'new:8b', tokensPerSec: 30, promptEval: 900 });
check('too few runs says nothing', promptCostTrend(loadRuns(KEY), 'new:8b') === null);

/* ------------------------------------------------------------ the storage */

clearRuns(KEY);
for (let i = 0; i < 450; i++) recordRun(KEY, { model: 'm', tokensPerSec: 10 + (i % 5) });
check('the history is bounded', loadRuns(KEY).length <= 400, String(loadRuns(KEY).length));
check('and keeps the newest', loadRuns(KEY).length === 400);

// It describes a machine, not an account: a laptop's numbers averaged with a
// desktop's describe neither. Asserted against the store rather than assumed.
const settings = await rolldown({
  input: path.resolve(HERE, '../src/settingsStore.js'), platform: 'neutral',
});
const settingsOut = path.resolve(HERE, '../node_modules/.perf-settings-bundle.mjs');
await settings.write({ file: settingsOut, format: 'esm' });
await settings.close();
const { isScopedSetting } = await import(pathToFileURL(settingsOut).href);
check('timings are not synced to the account', !isScopedSetting('perfRuns:srv-abc'));
check('nor under the guest key', !isScopedSetting('perfRuns'));

clearRuns(KEY);
eq('clearing empties it', loadRuns(KEY).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
