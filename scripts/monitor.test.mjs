// The monitor's arithmetic.
//
// The panel used to show four percentages, which answer "is it busy" and
// nothing else. Everything here answers a comparison instead, and comparisons
// are where the mistakes are: a model half on the CPU reporting the same GPU
// utilisation as one that fits, a disk total that counts the same 4.7GB blob
// twice because it carries two tags, a "getting slower" claim from three runs.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/monitor.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.monitor-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-6) =>
  check(name, Math.abs(got - want) <= tol, `got ${got} want ${want}`);

const GB = 1024 ** 3;

/* ------------------------------------------------- where a model is running */

// The whole point of the block. A model that fits and one that has been half
// offloaded to system RAM look identical on a utilisation graph, and the
// second is an order of magnitude slower.
const loaded = M.residency([
  { name: 'fits:8b', size: 5 * GB, size_vram: 5 * GB, expires_at: '2026-01-01T00:05:00Z' },
  { name: 'spills:30b', size: 20 * GB, size_vram: 8 * GB },
], Date.parse('2026-01-01T00:00:00Z'));

eq('the largest model is listed first', loaded[0].name, 'spills:30b');
eq('a model that fits is not flagged', loaded.find(m => m.name === 'fits:8b').partial, false);
eq('one that does not, is', loaded.find(m => m.name === 'spills:30b').partial, true);
near('and says how much of it is on the card',
  loaded.find(m => m.name === 'spills:30b').onGpu, 0.4);
eq('the remainder is named in bytes, not left to be worked out',
  loaded.find(m => m.name === 'spills:30b').cpu, 12 * GB);
eq('and the unload time is a duration, not a timestamp',
  loaded.find(m => m.name === 'fits:8b').expiresIn, 5 * 60 * 1000);

// An older Ollama does not report `size_vram` at all. "0% on GPU" would be a
// confident wrong answer, and the flag it would raise is the loudest one here.
const old = M.residency([{ name: 'old:7b', size: 4 * GB }]);
eq('a missing figure is unknown, not zero', old[0].onGpu, null);
eq('and raises nothing', old[0].partial, false);

eq('a model already past its unload time is not an error',
  M.residency([{ name: 'x', size: 1, expires_at: '2020-01-01T00:00:00Z' }])[0].expiresIn < 0, true);
eq('nothing loaded is no rows', M.residency([]).length, 0);
eq('and neither is nonsense', M.residency([null, {}]).length, 0);

/* --------------------------------------------------------------- the disk */

// Two tags, one blob. Adding up `size` says 9.4GB and `du` says 4.7.
const disk = M.diskUsage([
  { name: 'llama3:8b', size: 4 * GB, digest: 'aaa' },
  { name: 'llama3:latest', size: 4 * GB, digest: 'aaa' },
  { name: 'qwen3:14b', size: 9 * GB, digest: 'bbb' },
]);
eq('the total counts a shared blob once', disk.total, 13 * GB);
eq('and says how much was shared', disk.shared, 4 * GB);
eq('every tag is still a row', disk.rows.length, 3);
eq('largest first', disk.rows[0].name, 'qwen3:14b');
eq('and the unique count is the honest one', disk.unique, 2);
eq('no models is zero, not NaN', M.diskUsage([]).total, 0);
// No digest at all: fall back to the name, so two different models are two
// entries rather than one.
eq('models with no digest are not collapsed together',
  M.diskUsage([{ name: 'a', size: GB }, { name: 'b', size: GB }]).total, 2 * GB);

/* ------------------------------------------------------------- the series */

const runs = [
  { at: 1, model: 'a', tokensPerSec: 40, inTokens: 1000 },
  { at: 2, model: 'b', tokensPerSec: 10, inTokens: 500 },
  { at: 3, model: 'a', tokensPerSec: 38, inTokens: 2000 },
  { at: 4, model: 'a', tokensPerSec: 12, inTokens: 3000 },
];
eq('a series can be about one model', M.speedSeries(runs, 'a').length, 3);
eq('or all of them', M.speedSeries(runs, '').length, 4);
eq('newest last, so the graph reads left to right',
  M.speedSeries(runs, 'a').at(-1).value, 12);
eq('a run with no speed is not a point',
  M.speedSeries([{ at: 1, model: 'a' }], 'a').length, 0);
eq('the series is capped', M.speedSeries(
  Array.from({ length: 100 }, (_, i) => ({ at: i, model: 'a', tokensPerSec: 5 })), 'a', 10).length, 10);
eq('and keeps the newest, not the oldest', M.speedSeries(
  Array.from({ length: 100 }, (_, i) => ({ at: i, model: 'a', tokensPerSec: i })), 'a', 10)[0].value, 90);

eq('prompt tokens are their own series', M.contextSeries(runs, 'a').length, 3);
eq('and a zero is not a measurement',
  M.contextSeries([{ at: 1, model: 'a', inTokens: 0 }], 'a').length, 0);

/* ------------------------------------------------------ context pressure */

const pressure = M.contextPressure(runs, 'a', 4096);
eq('the newest run is the fill level', pressure.tokens, 3000);
near('as a fraction of the window', pressure.used, 3000 / 4096, 1e-9);
eq('the step per turn is the median, not the mean', pressure.perTurn, 1000);
eq('which is what makes "how many turns left" sayable', pressure.turnsLeft, 1);
// Three-quarters full is not a warning. A panel that starts complaining at
// 70% is one that is always complaining.
eq('and three-quarters full is not yet worth saying', pressure.level, 'ok');
eq('but seven-eighths is',
  M.contextPressure([{ at: 1, model: 'a', inTokens: 3600 }], 'a', 4096).level, 'warn');

// A new chat, or a compaction, drops the count. That is not a negative growth
// rate; it is a different conversation.
eq('a drop does not become a negative trend',
  M.contextPressure([
    { at: 1, model: 'a', inTokens: 8000 },
    { at: 2, model: 'a', inTokens: 200 },
    { at: 3, model: 'a', inTokens: 400 },
  ], 'a', 8192).perTurn, 200);

eq('a full window is high, not warn',
  M.contextPressure([{ at: 1, model: 'a', inTokens: 4000 }], 'a', 4096).level, 'high');
eq('an empty one is fine',
  M.contextPressure([{ at: 1, model: 'a', inTokens: 100 }], 'a', 4096).level, 'ok');
eq('with no window size there is nothing to be a fraction of',
  M.contextPressure(runs, 'a', 0), null);
eq('and with no runs, nothing to measure', M.contextPressure([], 'a', 4096), null);
eq('one run gives a level but no rate',
  M.contextPressure([{ at: 1, model: 'a', inTokens: 100 }], 'a', 4096).perTurn, null);

/* -------------------------------------------------------------- alerts */

const full = { gpus: [{ memoryUsed: 23 * GB, memoryTotal: 24 * GB, temperature: 60 }] };
let raised = M.alerts({ stats: full, running: [], pressure: null });
eq('a nearly full card is worth saying', raised.filter(a => a.kind === 'vram').length, 1);

raised = M.alerts({
  stats: { gpus: [{ memoryUsed: GB, memoryTotal: 24 * GB, temperature: 55 }] },
  running: [{ name: 'spills:30b', size: 20 * GB, size_vram: 8 * GB }],
});
eq('so is a model running half on the CPU', raised[0].kind, 'offloaded');
eq('naming which one', raised[0].model, 'spills:30b');

eq('a hot card is a warning',
  M.alerts({ stats: { gpus: [{ memoryUsed: 1, memoryTotal: 100, temperature: 91 }] } })
    .some(a => a.kind === 'thermal'), true);
eq('a card with no temperature sensor is not a cold one',
  M.alerts({ stats: { gpus: [{ memoryUsed: 1, memoryTotal: 100, temperature: null }] } })
    .some(a => a.kind === 'thermal'), false);

// The point of keeping this list short: a panel with eight standing warnings
// is a panel whose warnings are furniture.
eq('a quiet machine raises nothing',
  M.alerts({
    stats: { gpus: [{ memoryUsed: GB, memoryTotal: 24 * GB, temperature: 45 }] },
    running: [{ name: 'fits:8b', size: 5 * GB, size_vram: 5 * GB }],
    pressure: { level: 'ok' },
  }).length, 0);
eq('and no stats at all raises nothing either', M.alerts({}).length, 0);

/* ---------------------------------------------------------------- thinning */

eq('a short series is left alone', M.thin([1, 2, 3], 60).length, 3);
eq('a long one is cut to width', M.thin(Array.from({ length: 450 }, (_, i) => i), 60).length, 60);
// Maximum per bucket, not mean: on a load graph the spikes are the signal, and
// averaging is what turns a pegged GPU into a comfortable 40%.
eq('a spike survives the thinning',
  Math.max(...M.thin([0, 0, 0, 100, 0, 0, 0, 0], 2)), 100);
eq('nothing is nothing', M.thin([], 60).length, 0);
eq('and a gap is not a zero', M.thin([1, null, 3], 60).length, 2);

/* --------------------------------------------------------------- printing */

eq('bytes read as bytes', M.formatBytes(512), '512 B');
eq('and gigabytes as gigabytes', M.formatBytes(4.7 * GB), '4.7 GB');
eq('a large figure loses the decimal that was never precise', M.formatBytes(23 * GB), '23 GB');
eq('nothing is a dash, not zero', M.formatBytes(null), '—');
eq('seconds stay seconds', M.formatDuration(45000), '45s');
eq('minutes become minutes', M.formatDuration(300000), '5m');
eq('and hours, hours', M.formatDuration(7200000), '2h');
eq('a past time is not printed as a huge number', M.formatDuration(-500), '0s');

/* ------------------------------------------------------------- the wiring */

const panel = fs.readFileSync(path.join(ROOT, 'src/SystemMonitor.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the panel reads residency rather than printing sizes', /residency\(/.test(code));
check('and says when a model is not really on the GPU', /partial/.test(code));
check('the disk block deduplicates', /diskUsage\(/.test(code));
check('speed is shown as a series, not only a median', /speedSeries\(/.test(code));
check('context pressure is computed from the recorded runs', /contextPressure\(/.test(code));
check('alerts are rendered at the top, where they are read', /alerts\(/.test(code));
check('and the long history is thinned before drawing', /thin\(/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['sysmon.residency', 'sysmon.offloaded', 'sysmon.disk',
  'sysmon.contextPressure', 'sysmon.alertVram', 'sysmon.window']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['sysmon-alert', 'sysmon-residency', 'sysmon-disk', 'sysmon-window']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
