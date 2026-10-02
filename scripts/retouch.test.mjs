// Checking a finished picture, and redrawing only the part that came back wrong.
//
// Every interesting failure here is a quiet one. A verdict that cannot be read
// starts no redraw and says nothing; a region the mask-finder cannot find
// redraws nothing and says nothing; a prompt built from the picture's own
// words draws the whole picture inside the outline of a hand and looks, at a
// glance, like the model simply did a bad job. So the reading of a model's
// answer is pinned here against the shapes local models actually reply in, and
// the wiring is pinned too -- a judgement nobody acts on fixes nothing.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// settingsStore keeps the mode; it reads and writes through this.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const R = await import(pathToFileURL(path.join(ROOT, 'src/retouch.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ------------------------------------------------------------- the answer

   Local models do not reply in bare JSON. They fence it, they explain
   themselves before it, and -- the one that broke a greedy regex -- they
   explain themselves after it, ending the reply with a brace of their own. */

eq('a plain answer is read', R.readVerdict('{"ok": true}'), { ok: true });
eq('a fenced answer is read',
  R.readVerdict('```json\n{"parts":[{"region":"hands","problem":"six fingers"}]}\n```'),
  { ok: false, parts: [{ region: 'hands', problem: 'six fingers' }] });
eq('prose before the JSON is stepped over',
  R.readVerdict('Looking at the picture, I can see a problem.\n{"parts":[{"region":"eyes","problem":"eyes do not match"}]}'),
  { ok: false, parts: [{ region: 'eyes', problem: 'eyes do not match' }] });
eq('and prose after it, braces and all',
  R.readVerdict('{"parts":[{"region":"hands","problem":"melted thumb"}]}\nI chose this because {the thumb} is fused.'),
  { ok: false, parts: [{ region: 'hands', problem: 'melted thumb' }] });

/* An unreadable answer is not evidence that the picture is wrong. The
   expensive mistake in both directions is redrawing a picture that was fine,
   so silence, prose and broken JSON all mean "nothing to do". */
eq('an answer with no JSON at all leaves the picture alone',
  R.readVerdict('The picture looks great to me!'), { ok: true });
eq('broken JSON leaves it alone', R.readVerdict('{"parts": [{"region": '), { ok: true });
eq('an empty reply leaves it alone', R.readVerdict(''), { ok: true });
eq('so does a reply of nothing at all', R.readVerdict(null), { ok: true });
eq('an empty list is nothing wrong', R.readVerdict('{"parts": []}'), { ok: true });

/* The word is fed to SAM3 as the thing to find in the picture, so a word SAM3
   cannot find is worse than no answer: it is a generation that redraws an
   empty mask. Anything off the list is dropped, and the rest of the answer
   still counts. */
eq('a region that is not on the list is dropped',
  R.readVerdict('{"parts":[{"region":"the whole left side","problem":"muddled"},{"region":"hands","problem":"six fingers"}]}'),
  { ok: false, parts: [{ region: 'hands', problem: 'six fingers' }] });
eq('a reply of nothing but unknown regions is nothing to do',
  R.readVerdict('{"parts":[{"region":"vibes","problem":"off"}]}'), { ok: true });
eq('the singular a model writes for one of them is the region',
  R.readVerdict('{"parts":[{"region":"Hand","problem":"bent thumb"}]}'),
  { ok: false, parts: [{ region: 'hands', problem: 'bent thumb' }] });
eq('one part named twice is one part',
  R.readVerdict('{"parts":[{"region":"hands","problem":"six fingers"},{"region":"hand","problem":"fused"}]}'),
  { ok: false, parts: [{ region: 'hands', problem: 'six fingers' }] });
eq('a region named as a word', R.asRegion('  EYE '), 'eyes');
eq('and one that is not', R.asRegion('shoulder'), '');
check('a problem that runs on is cut rather than carried',
  R.readVerdict(`{"parts":[{"region":"hands","problem":"${'x'.repeat(200)}"}]}`).parts[0].problem.length === 80);

/* ---------------------------------------------------------------- the plan */

{
  const three = R.readVerdict('{"parts":[{"region":"hands","problem":"six fingers"},'
    + '{"region":"eyes","problem":"mismatched"},{"region":"shoes","problem":"odd pair"}]}');
  const plan = R.retouchPlan(three);
  eq('two parts at most, in one pass', plan.region, 'hands, eyes');
  eq('and the worst one is what the reader is told', plan.problem, 'six fingers');
}
eq('nothing wrong is no plan', R.retouchPlan({ ok: true }), null);
eq('nor is nothing at all', R.retouchPlan(null), null);

/* ------------------------------------------------------------- the redraw

   The prompt is the part as it should have been drawn, and nothing else. A
   region edit draws whatever the prompt names *inside the mask*, so the
   picture's own prompt would draw the whole scene inside the outline of a
   hand -- which reads as the model having simply failed. */

{
  const plan = R.retouchPlan(R.readVerdict('{"parts":[{"region":"hands","problem":"six fingers"}]}'));
  const prompt = R.retouchPrompt(plan);
  check('the redraw is told to draw hands', /finger/.test(prompt) && /hand/.test(prompt));
  check('and nothing about the picture around them',
    !/girl|background|uniform|field/i.test(prompt));
}
eq('two parts are described together',
  R.retouchPrompt({ parts: [{ region: 'eyes' }, { region: 'mouth' }] }),
  'matching eyes, symmetrical eyes, clean eye detail, cleanly drawn mouth, correct teeth');
check('every region the model may name has words to redraw it with',
  R.REGIONS.every(region => R.retouchPrompt({ parts: [{ region }] }).length > 0));
check('automatic repairs keep a moderate strength to preserve character identity',
  R.RETOUCH_DENOISE >= 0.4 && R.RETOUCH_DENOISE <= 0.7);

/* ------------------------------------------------------------- the question */

check('the model is given the words it may answer in',
  R.REGIONS.every(region => R.INSPECT_PROMPT.includes(region)));
check('and told that nothing wrong is the expected answer',
  /\{"ok": true\}/.test(R.INSPECT_PROMPT) && /expected answer/.test(R.INSPECT_PROMPT));
check('and told to judge nothing else',
  /composition|style/i.test(R.INSPECT_PROMPT) && /Judge nothing else/.test(R.INSPECT_PROMPT));

/* -------------------------------------------------------------- who asks */

eq('the model already in use is asked, when it can see',
  R.inspector({ active: 'gemma4:31b', activeSees: true, vision: 'llava', visionSees: true }), 'gemma4:31b');
eq('the vision model when it cannot',
  R.inspector({ active: 'qwen3:8b', activeSees: false, vision: 'llava', visionSees: true }), 'llava');
eq('and nobody when neither can see',
  R.inspector({ active: 'qwen3:8b', activeSees: false, vision: 'qwen3:8b', visionSees: false }), '');

/* ---------------------------------------------------------------- the mode */

eq('off until somebody turns it on', R.getRetouchMode(), 'off');
R.setRetouchMode('auto');
eq('and what was chosen reads back', R.getRetouchMode(), 'auto');
R.setRetouchMode('sometimes');
eq('a mode that does not exist changes nothing', R.getRetouchMode(), 'auto');
R.setRetouchMode('suggest');
eq('all three are real', [R.MODES.includes('off'), R.MODES.includes('suggest'), R.MODES.includes('auto')],
  [true, true, true]);

/* --------------------------------------------------------------- the wiring

   A judgement nobody acts on fixes nothing, and each half of this feature is
   invisible when it is missing: the check runs and the picture is unchanged,
   or the picture is changed and the reader cannot see what it was. */

{
  const app = read('src/App.jsx');
  const panel = read('src/StudioPanel.jsx');

  check('the chat checks a finished picture', /inspectPicture\s*[=(]/.test(app));
  check('and redraws the part it named', /retouchPicture\s*[=(]/.test(app));
  check('the redraw is a region edit at the strength a region needs',
    /region: plan\.region/.test(app) && /change: RETOUCH_DENOISE/.test(app));
  check('what it started from is kept beside it, so both can be looked at',
    /BeforeAfter/.test(app) && /picture\.retouch\b/.test(app));
  check('and the reader can keep either one', /const swapRetouch|swapRetouch\(/.test(app));
  check('an offer is a button rather than a redraw', /picture\.retouchOffer/.test(app));

  check('the Studio checks its finished pictures too', /inspectJob|checkFinished/.test(panel));
  check('and its redraw is a job of its own, beside the picture it came from',
    /retouchRequest|runRetouch/.test(panel));
  check('the mode is chosen in the Studio, beside the other picture settings',
    /setRetouchMode/.test(panel) && /MODES\.map/.test(panel));

  /* Every string the two of them show, in every language. A key that exists
     in English only is invisible in English -- which is where it is read. */
  const i18n = read('src/i18n.jsx');
  const named = [...new Set([...`${app}${panel}`.matchAll(/'((?:retouch|picture\.req)\.[A-Za-z.]+)'/g)]
    .map(m => m[1]).filter(key => key.startsWith('retouch.') || key === 'picture.req.retouch'))];
  // The two built from a list rather than written out.
  const keys = [...named, ...R.MODES.map(mode => `retouch.mode.${mode}`),
    ...R.REGIONS.map(region => `retouch.region.${region}`)];
  check('the retouch has strings to show', named.length >= 6, `${named.length}`);
  const dicts = (i18n.match(/^const [a-zA-Z]+ = \{$/gm) || []).length;
  check('every language is counted', dicts >= 12, `${dicts}`);
  const missing = keys.filter((key) => {
    const count = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    return count !== dicts;
  });
  check(`all ${keys.length} strings are translated into all ${dicts} languages`,
    missing.length === 0, missing.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
