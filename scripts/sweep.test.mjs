// One setting, walked across a batch.
//
// The arithmetic is the part that will be wrong, and every way it can be wrong
// is expensive: a sweep is up to eight generations, and one that runs the same
// value twice, or that lets the seed move, costs minutes of GPU and teaches
// nothing. So the values are pinned here one by one.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// inpaint.js reads the dials out of storage at import time.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const S = await import(pathToFileURL(path.join(ROOT, 'src/sweep.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const steps = S.axisById('steps');
const cfg = S.axisById('cfg');
const guide = S.axisById('guideStrength');

/* -------------------------------------------------------------- the values

   Ends included, because the ends are what a sweep is usually asked: what does
   this look like turned off, and what does it look like at maximum. */

eq('a sweep runs from one end to the other', S.sweepValues(cfg, [1, 5], 5), [1, 2, 3, 4, 5]);
eq('and both ends are in it', S.sweepValues(cfg, [1, 12], 2), [1, 12]);
eq('steps come out whole, because a step is a count', S.sweepValues(steps, [8, 30], 4), [8, 15, 23, 30]);
eq('a dial comes out at the precision it is set in', S.sweepValues(guide, [0, 2], 5), [0, 0.5, 1, 1.5, 2]);
check('and never with the float noise of dividing', S.sweepValues(guide, [0, 1], 3).every(v => String(v).length <= 4),
  JSON.stringify(S.sweepValues(guide, [0, 1], 3)));

/* Paying for six generations to see three pictures twice is not what anybody
   meant by "sweep steps from 8 to 10". */
eq('a range too narrow for the count runs each value once',
  S.sweepValues(steps, [8, 10], 6), [8, 9, 10]);
eq('asking for one asks for a specific picture, not the middle',
  S.sweepValues(cfg, [1, 12], 1), [1]);
eq('a count past the cap is capped', S.sweepValues(steps, [1, 100], 99).length, 8);
eq('a count of nothing is one', S.sweepValues(cfg, [1, 5], 0), [1]);
eq('a range that is not one sweeps nothing', S.sweepValues(cfg, [5, 5], 4), []);
eq('and neither does no axis at all', S.sweepValues(null, [1, 5], 4), []);

/* --------------------------------------------------------------- the range */

eq('an axis with its own range uses it', S.axisRange(guide, {}), [0, 2]);
eq('one without it takes the workflow\'s', S.axisRange(steps, { steps: [8, 60] }), [8, 60]);
eq('a workflow that does not say has no range', S.axisRange(steps, {}), null);
eq('nor one that says something backwards', S.axisRange(steps, { steps: [30, 8] }), null);
eq('nor one that says nonsense', S.axisRange(steps, { steps: ['a', 'b'] }), null);

/* ---------------------------------------------------------------- the jobs

   The seed is held still, and that is the whole point: two pictures that
   differ in their seed differ everywhere, and nothing can be learnt by
   comparing them. */

{
  const jobs = S.sweepJobs({ axis: cfg, range: [1, 5], count: 3, seed: 4242 });
  eq('one job per value', jobs.map(j => j.value), [1, 3, 5]);
  check('every one at the same seed', jobs.every(j => j.seed === 4242));
  eq('and the patch names the field the job uses', jobs[0].patch, { cfg: 1, seed: 4242 });
}
{
  // Three of these are not form fields at all: they ride along with the request.
  const jobs = S.sweepJobs({ axis: guide, range: [0, 2], count: 3, seed: 7 });
  eq('a dial is patched under the name the job sends it as',
    jobs.map(j => j.patch.guideStrength), [0, 1, 2]);
}
eq('a sweep with no seed pinned is refused rather than run',
  S.sweepJobs({ axis: cfg, range: [1, 5], count: 4, seed: null }), []);
eq('and so is one along an axis that does not exist',
  S.sweepJobs({ axis: 'vibes', range: [1, 5], count: 4, seed: 1 }), []);
eq('an axis named as a string still works', S.sweepJobs({ axis: 'cfg', range: [1, 5], count: 2, seed: 1 }).length, 2);

/* --------------------------------------------------- what may be swept

   A workflow with no cfg input cannot be swept along it, and the two region
   dials do nothing without a picture to edit -- offering them would be
   offering a batch of identical pictures. */

eq('a workflow is swept only along what it has',
  S.axesFor({ has: { steps: true, cfg: true } }).map(a => a.id), ['steps', 'cfg']);
eq('strength needs a picture to work from',
  S.axesFor({ has: { steps: true, denoise: true }, hasReference: false }).map(a => a.id), ['steps']);
eq('and the region dials need a region as well',
  S.axesFor({ has: { steps: true, denoise: true }, hasReference: true, region: false }).map(a => a.id),
  ['steps', 'denoise']);
eq('with one, they are offered',
  S.axesFor({ has: { steps: true, cfg: true, denoise: true }, hasReference: true, region: true }).map(a => a.id),
  ['steps', 'cfg', 'denoise', 'guideStrength', 'maskGrowScale']);
eq('a workflow with none of them sweeps nothing', S.axesFor({ has: {} }).map(a => a.id), []);

/* ------------------------------------------------------------- the wiring */

{
  const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
  check('the Studio can sweep', /sweepJobs\(/.test(panel) && /axesFor\(/.test(panel));
  /* The seed is pinned to whatever ran, and written back into the box: a
     sweep whose seed moved is eight different pictures with a caption, and one
     whose seed is forgotten cannot be swept again along another axis and
     compared against this one. */
  check('and pins the seed while it does, or it is not a sweep',
    /sweepJobs\(\{ axis, range, count, seed:/.test(panel)
    && /set\('seed', String\(runs\[0\]\.seed\)\)/.test(panel)
    && /set\('lockSeed', true\)/.test(panel));
  check('each card says which of the sweep it is',
    /\.\.\.\(sweep \? \{ sweep \} : \{\}\)/.test(panel) && /job\.sweep &&/.test(panel));
  // And at the value it actually ran at, not the one still in the form.
  check('and at the value it ran at, not the one in the form',
    /steps: request\.steps \?\? form\.steps/.test(panel));
  const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
  const dicts = (i18n.match(/^const [a-zA-Z]+ = \{$/gm) || []).length;
  const keys = ['sweep.title', 'sweep.off', 'sweep.hint', 'sweep.needsSeed',
    ...S.AXES.map(axis => `sweep.axis.${axis.id}`)];
  const missing = keys.filter((key) => {
    const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    return n !== dicts;
  });
  check(`all ${keys.length} strings are translated into all ${dicts} languages`,
    missing.length === 0, missing.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
