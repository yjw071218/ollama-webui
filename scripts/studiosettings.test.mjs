// What the Studio was set to last time, and finding a LoRA among two hundred.
//
// Two features that are one module because they share a subject: the names of
// files on somebody's disk. Saved settings *are* those names, and searching is
// how you find one — so both have to cope with the same reality, which is that
// the names carry folders, extensions and versions, and that the file a setting
// points at may not be there any more.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// The module reaches localStorage, so give it one before it loads.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const S = await import(pathToFileURL(path.join(ROOT, 'src/studioSettings.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* Real names, written as they actually arrive from ComfyUI on Windows: a
   backslash path, mixed case, underscores, a version suffix. Written with
   String.raw so the backslash in the test is the backslash in the data. */
const NAMES = [
  String.raw`anima\style\NyteTyde.safetensors`,
  String.raw`anima\BlueArchiveStyleB1.safetensors`,
  String.raw`anima\@saboten.safetensors`,
  String.raw`anima\anima_base_slider_step800.safetensors`,
  String.raw`ace\adapter_model.safetensors`,
  String.raw`krea2\krea2_darkbrush.safetensors`,
];

/* --------------------------------------------------------- reading a name */

eq('a name is its file, not its path', S.loraLabel(NAMES[0]), 'NyteTyde');
eq('and the folder is the rest of it', S.loraFolder(NAMES[0]), 'anima / style');
eq('a name at the top has no folder', S.loraFolder('plain.safetensors'), '');
eq('the extension comes off', S.loraLabel('plain.safetensors'), 'plain');

/* ------------------------------------------------------------- searching

   The native `<select>` matches from the start of the whole string, and these
   names start with a folder — so "nyte" matched nothing and the only route to
   the one you wanted was scrolling two hundred rows. */

deep('a word inside the name is found', S.searchNames(NAMES, 'nyte').map(S.loraLabel), ['NyteTyde']);
// The house style is run-together capitals, and nobody types them that way.
deep('two words match a run-together name',
  S.searchNames(NAMES, 'blue archive').map(S.loraLabel), ['BlueArchiveStyleB1']);
deep('and so does the whole thing with no spaces',
  S.searchNames(NAMES, 'bluearchive').map(S.loraLabel), ['BlueArchiveStyleB1']);
deep('underscores are punctuation the typist leaves out',
  S.searchNames(NAMES, 'darkbrush').map(S.loraLabel), ['krea2_darkbrush']);
deep('case is not a question', S.searchNames(NAMES, 'NYTETYDE').map(S.loraLabel), ['NyteTyde']);

// Every word has to appear. On a list this long, OR-ing the terms widens the
// result exactly when the person is trying to narrow it.
eq('two terms narrow rather than widen', S.searchNames(NAMES, 'anima slider').length, 1);
eq('a term that matches nothing gives nothing', S.searchNames(NAMES, 'zzzz').length, 0);
eq('an empty query is everything', S.searchNames(NAMES, '').length, NAMES.length);

/* The folder is searchable, but a match on the file's own name has to win:
   typing "anima" must not bury the LoRA called Anima under the two hundred that
   merely live in `anima\`. */
const animaHits = S.searchNames(NAMES, 'anima');
check('a folder match is included', animaHits.length >= 3, String(animaHits.length));
eq('but the name that starts with the term comes first',
  S.loraLabel(animaHits[0]), 'anima_base_slider_step800');

// The dropdown is a dropdown, not the whole library.
eq('the list is capped', S.searchNames(Array.from({ length: 500 }, (_, i) => `l${i}.safetensors`), '', 60).length, 60);

/* ------------------------------------------------------- saving and restoring */

const MODEL = {
  id: 'krea2-turbo',
  has: { negative: undefined },
  defaults: { steps: 8, cfg: 1, width: 1024, height: 1360, sampler: 'euler', scheduler: 'simple' },
  ranges: { steps: [1, 30], cfg: [0.5, 4] },
  loraSlots: 6,
  choices: {
    model: ['m1.safetensors', 'm2.safetensors'],
    vae: ['v1.safetensors'],
    clip: [],
    lora: NAMES,
    sampler: ['euler', 'dpmpp_2m'],
    scheduler: ['simple', 'karras'],
  },
};

store.clear();
eq('nothing saved is an empty store', Object.keys(S.readAll('me')).length, 0);

S.writeSettings('me', 'krea2-turbo', {
  prompt: 'a lighthouse', steps: 12, cfg: 2, width: 900, height: 1200,
  model: 'm2.safetensors', sampler: 'dpmpp_2m',
  loras: [{ name: NAMES[0], weight: 0.8 }],
  seed: '4242', lockSeed: true,
  referenceImage: 'upload-9912.png',
});

const saved = S.readAll('me')['krea2-turbo'];
eq('what was set is written', saved.prompt, 'a lighthouse');
/* A reference image names a file uploaded to ComfyUI for one generation.
   Restoring it a week later points at something ComfyUI has tidied away, and a
   picture that fails on an invisible stale filename is worse than one you have
   to attach again. */
eq('but the reference image is not', saved.referenceImage, undefined);

const restored = S.restoreForm(MODEL, saved);
eq('the prompt comes back', restored.prompt, 'a lighthouse');
eq('and the numbers', restored.steps, 12);
eq('and the size', restored.width, 900);
eq('and the checkpoint', restored.model, 'm2.safetensors');
eq('and the seed, still locked', restored.lockSeed, true);
eq('the LoRA comes back with its weight', restored.loras[0].weight, 0.8);

/* Settings are per workflow. Krea 2 runs at 8 steps and Anima at 40; one shared
   set of numbers would be wrong for whichever one you did not set it from. */
S.writeSettings('me', 'anima-base', { steps: 40, prompt: 'a fox' });
eq('a second workflow saves separately', S.readAll('me')['anima-base'].steps, 40);
eq('without touching the first', S.readAll('me')['krea2-turbo'].steps, 12);
eq('and profiles do not share', Object.keys(S.readAll('someone-else')).length, 0);

/* ------------------------------------------- a saved name that has gone away

   The sharp case. Checkpoints get renamed and LoRAs get deleted, and a saved
   name that no longer exists is not a harmless leftover — it is a generation
   that fails a minute in, on a value sitting in a picker that renders it as
   selected. */

const stale = {
  prompt: 'still here',
  model: 'deleted.safetensors',
  sampler: 'a_sampler_that_was_uninstalled',
  loras: [{ name: NAMES[1], weight: 0.5 }, { name: String.raw`gone\missing.safetensors`, weight: 1 }],
};
const pruned = S.restoreForm(MODEL, stale);
eq('a checkpoint that is gone is not restored', pruned.model, '');
eq('nor a sampler that is gone', pruned.sampler, 'euler');
eq('the LoRA that is still there comes back', pruned.loras.length, 1);
eq('and it is the right one', pruned.loras[0].name, NAMES[1]);
eq('the prompt survives all of that', pruned.prompt, 'still here');
eq('and the panel can say how many were dropped', S.droppedFrom(MODEL, stale), 3);

/* Not being able to *ask* is different from the file being gone: throwing a
   setting away because ComfyUI happened to be down would lose real work. */
const offline = { ...MODEL, choices: { model: [], vae: [], clip: [], lora: [], sampler: [], scheduler: [] } };
eq('with no list to check against, the setting is kept',
  S.restoreForm(offline, { model: 'm2.safetensors' }).model, 'm2.safetensors');
eq('and nothing is reported as dropped', S.droppedFrom(offline, stale), 0);

/* The numbers are checked too: a workflow edited to cap its steps lower must
   not be handed the old higher value. */
eq('a saved number above the range is clamped', S.restoreForm(MODEL, { steps: 999 }).steps, 30);
eq('and below it', S.restoreForm(MODEL, { steps: -5 }).steps, 1);
eq('rubbish falls back to the default', S.restoreForm(MODEL, { steps: 'lots' }).steps, 8);

// A workflow with no negative prompt must not restore one into a box that is
// not there.
eq('a negative is not restored where there is nowhere to put it',
  S.restoreForm(MODEL, { negative: 'blurry' }).negative, '');
eq('but it is where there is',
  S.restoreForm({ ...MODEL, has: { negative: true } }, { negative: 'blurry' }).negative, 'blurry');

// More LoRAs than the workflow can stack are cut to what it can.
eq('saved LoRAs are capped at the workflow ceiling',
  S.restoreForm({ ...MODEL, loraSlots: 2 }, { loras: NAMES.map(n => ({ name: n })) }).loras.length, 2);

/* --------------------------------------------------------- surviving rubbish */

store.set('studioSettings:me', 'not json at all');
eq('unreadable storage is an empty store', Object.keys(S.readAll('me')).length, 0);
store.set('studioSettings:me', '["an","array"]');
eq('and so is the wrong shape', Object.keys(S.readAll('me')).length, 0);
eq('restoring from nothing gives the defaults', S.restoreForm(MODEL, null).steps, 8);
eq('and from rubbish too', S.restoreForm(MODEL, 'nonsense').steps, 8);
eq('a model with no defaults still yields a form', typeof S.restoreForm({}, {}).width, 'number');

/* ------------------------------------------------------------- the wiring */

const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
check('the panel restores rather than resetting to defaults', /restoreForm\(/.test(panel));
check('and writes on change', /writeSettings\(/.test(panel));
check('the LoRA rows are searched, not scrolled', /SearchPicker|searchNames/.test(panel));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
