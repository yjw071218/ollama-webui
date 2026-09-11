// Making pictures and video, through ComfyUI.
//
// ComfyUI does not take "a prompt and a model name" — it takes a graph, keyed by
// node id, where an input is either a literal or `[nodeId, outputIndex]`. Every
// mistake in building one is the same mistake: it queues fine, runs for forty
// seconds, and fails on a tensor shape or produces a picture of nothing. There
// is no fast feedback loop, and on a machine with no ComfyUI installed there is
// no loop at all.
//
// So the graph builders are pure and this checks the wiring, the clamping, and
// the two arithmetic rules that are silent when broken: latent dimensions must
// be multiples of eight, and video frame counts must be 4n+1.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const S = await import(pathToFileURL(path.join(ROOT, 'server/studio.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ where it is */

eq('ComfyUI is on its own port, like the other sidecars',
  S.comfyBase({}), 'http://127.0.0.1:8188');
eq('and can be pointed elsewhere', S.comfyBase({ COMFYUI_URL: 'http://box:9000/' }), 'http://box:9000');
eq('host and port work separately too',
  S.comfyBase({ COMFYUI_HOST: '10.0.0.4', COMFYUI_PORT: '7860' }), 'http://10.0.0.4:7860');

/* ------------------------------------------------------------ the catalogue

   Three workflows, exported from ComfyUI and kept in `workflows/`. The Studio's
   form is rendered from what each one actually contains, so the catalogue's job
   is to report capabilities honestly rather than to describe a model. */

const W = await import(pathToFileURL(path.join(ROOT, 'server/workflows.js')).href);

const models = S.modelList();
eq('three workflows are offered', models.length, 3);
eq('two of them make pictures', models.filter(m => m.kind === 'image').length, 2);
eq('and one makes video', models.filter(m => m.kind === 'video').length, 1);
check('krea2_base is gone', !models.some(m => /raw|base/i.test(m.id) && m.id.startsWith('krea')));

for (const id of ['krea2-turbo', 'anima-base', 'minimax-h3']) {
  check(`${id} is in the catalogue`, models.some(m => m.id === id));
}

// Each workflow file has to exist, or the whole thing is a catalogue of
// nothing that fails one generation at a time.
for (const definition of Object.values(W.WORKFLOWS)) {
  check(`${definition.id} names a workflow that is present`,
    fs.existsSync(path.join(ROOT, 'workflows', definition.file)));
}

/* What a workflow *has* is the whole design of the form.
 *
 * Krea 2 Turbo genuinely has no negative conditioning — its negative is a
 * `ConditioningZeroOut` with no text input — so offering a negative box for it
 * would be offering a field that goes nowhere, which is worse than not offering
 * one because it looks like it works. */
const byId = Object.fromEntries(models.map(m => [m.id, m]));
check('Anima has a negative prompt', byId['anima-base'].has.negative === true);
check('and Krea 2 Turbo does not', byId['krea2-turbo'].has.negative === undefined);
check('every workflow takes a prompt', models.every(m => m.has.positive));
check('and a seed', models.every(m => m.has.seed));

/* All three take a reference picture now, and they do three different things
   with it: the video one animates it, and the two image ones edit it — which
   is what "make her hair blue" means and what redrawing from a new prompt
   cannot do. Only the image ones have a `denoise`, because "how much should it
   change" is a question only editing asks. */
check('every workflow takes a reference picture', models.every(m => m.has.referenceImage === true));
check('the image ones can say how much to change it',
  byId['krea2-turbo'].has.denoise === true && byId['anima-base'].has.denoise === true);
check('and the video one cannot, because it is not editing',
  byId['minimax-h3'].has.denoise === undefined);
check('and only it has a duration', byId['minimax-h3'].has.duration === true);

// The pickers the user asked for.
for (const control of ['sampler', 'scheduler', 'model', 'vae', 'lora']) {
  check(`Anima exposes its ${control}`, byId['anima-base'].has[control] === true);
}
check('and Krea 2 Turbo exposes its text encoder too', byId['krea2-turbo'].has.clip === true);

/* A control a workflow does not have must say *why* it does not have it.
 *
 * Leaving it out was the mistake, and it is the one piece of feedback this
 * whole panel earned: opening the Studio on the default workflow and finding no
 * negative-prompt box reads as "negative prompts were never built". They were.
 * Krea 2 Turbo is guidance-distilled and runs at guidance 1, where a negative
 * prompt has no effect — which is a sentence, not an absence. */
eq('Krea 2 Turbo says why it has no negative prompt',
  byId['krea2-turbo'].missing?.negative, 'guidanceDistilled');
check('every workflow explains each control it lacks',
  models.every(m => ['negative', 'referenceImage', 'duration', 'lora', 'cfg', 'clip']
    .every(control => m.has[control] || m.missing?.[control])),
  JSON.stringify(models.map(m => [m.id, m.missing])));

const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
check('the panel draws the absent ones rather than dropping them', /const Absent = /.test(panel));
check('and looks the reason up per control', /reasonFor\(/.test(panel));
// Every reason the workflows name has to have words to show.
const i18nSource = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
const reasons = new Set(Object.values(W.WORKFLOWS).flatMap(d => Object.values(d.missing || {})));
for (const reason of reasons) {
  eq(`"${reason}" has words in every language`,
    i18nSource.split(`'studio.why.${reason}':`).length - 1, 12);
}
eq('and so does the fallback', i18nSource.split("'studio.why.notInWorkflow':").length - 1, 12);

// The licence restriction has to travel to the interface, not sit in a commit
// message.
check('the H3 licence restriction reaches the interface',
  /South Korea/i.test(byId['minimax-h3'].licence || ''));
check('and names local deployment as the restricted thing',
  /local/i.test(byId['minimax-h3'].licence || ''));

/* ------------------------------------------------------------- the numbers */

// Any size, rounded to what latents need. It was a dropdown of presets, which
// is the wrong control: the one you want is always the one missing.
eq('an arbitrary size is accepted', S.parseSize('904x1160').width, 904);
eq('and rounded to a multiple of 8', S.parseSize('903x1161').width % 8, 0);
eq('on both axes', S.parseSize('903x1161').height % 8, 0);
eq('a × is a valid separator too', S.parseSize('800×600').width, 800);
eq('and nonsense falls back rather than throwing', S.parseSize('banana', '1024x1024').width, 1024);

eq('a given seed is kept', S.resolveSeed(1234), 1234);
eq('a blank one becomes a number', typeof S.resolveSeed(''), 'number');
check('and stays inside what JSON can carry losslessly', S.resolveSeed('') <= Number.MAX_SAFE_INTEGER);

/* --------------------------------------------------- a job, as values */

const krea = W.WORKFLOWS['krea2-turbo'];
const anima = W.WORKFLOWS['anima-base'];

const job = S.prepareJob(anima, {
  prompt: 'a fox', negative: 'blurry', size: '904x1160',
  steps: 22, cfg: 6, sampler: 'euler', scheduler: 'karras', seed: 5,
  modelFile: 'x.safetensors', vae: 'v.safetensors',
});
eq('the prompt becomes the positive', job.positive, 'a fox');
eq('the negative survives where there is one', job.negative, 'blurry');
eq('the size becomes width and height', job.width, 904);
eq('the checkpoint travels as modelFile, not as the workflow id',
  job.model, 'x.safetensors');
// LoRAs are deliberately not here: they are a list, and one of the two
// mechanisms adds nodes rather than filling in an input, so they go through
// `applyLoras` against the graph instead of through the value map.
check('LoRAs are not a value in the job map', job.lora === undefined && job.loraStrength === undefined);

// A field the workflow does not have is dropped rather than sent, because
// sending it would be an override that silently does nothing.
const kreaJob = S.prepareJob(krea, { prompt: 'a fox', negative: 'blurry' });
eq('a negative for a workflow with none is dropped', kreaJob.negative, undefined);
check('while the prompt still lands', kreaJob.positive === 'a fox');

// Ranges are the workflow's own; a distilled model asked for 200 steps gets its
// own maximum rather than four minutes of no benefit.
check('steps are clamped to the workflow range',
  S.prepareJob(krea, { prompt: 'x', steps: 500 }).steps <= krea.ranges.steps[1]);
check('and a sampler this app has never heard of is passed through',
  S.prepareJob(krea, { prompt: 'x', sampler: 'brand_new_sampler' }).sampler === 'brand_new_sampler');

/* ------------------------------------------------------- stacking LoRAs

   One dropdown and one strength slider was one LoRA, and one LoRA is not how
   anyone uses them. The two workflows stack them by entirely different means,
   and the difference is not cosmetic: one fills in a form, the other edits the
   graph. */

const stackable = models.filter(m => m.has.lora);
eq('both image workflows take LoRAs', stackable.length, 2);
eq('Anima stacks nine, which is what its stacker holds', byId['anima-base'].loraSlots, 9);
eq('Krea 2 chains six cloned loaders', byId['krea2-turbo'].loraSlots, 6);
eq('and the video one has none', byId['minimax-h3'].loraSlots, 0);

/* A stacker: nine slots already in the graph, so choosing four is four
   assignments and no new nodes. */
const stackerPrompt = {
  '5': {
    class_type: 'LoRA Stacker',
    inputs: {
      lora_count: 9,
      lora_name_1: 'theirs.safetensors', lora_wt_1: 0.3, lora_name_1_toggle: true,
      lora_name_2: 'also-theirs.safetensors', lora_wt_2: 0.7, lora_name_2_toggle: true,
      lora_name_3: 'x', lora_wt_3: 1, lora_name_3_toggle: true,
    },
    _meta: { source: '1380' },
  },
};
const stackerSpec = { loras: { style: 'slots', node: '1380', slots: 3, max: 3,
  name: 'lora_name_%', weight: 'lora_wt_%', toggle: 'lora_name_%_toggle', count: 'lora_count' } };

const slotted = W.applyLoras(stackerPrompt, stackerSpec, [
  { name: 'mine-a', weight: 0.9 }, { name: 'mine-b', weight: 0.4 },
]);
eq('two LoRAs land in two slots', slotted.applied, 2);
eq('the first by name', stackerPrompt['5'].inputs.lora_name_1, 'mine-a');
eq('and by weight', stackerPrompt['5'].inputs.lora_wt_1, 0.9);
eq('the second too', stackerPrompt['5'].inputs.lora_name_2, 'mine-b');
eq('the count says how many to read', stackerPrompt['5'].inputs.lora_count, 2);
/* The unused slots must be switched *off*. They still hold the workflow
   author's own LoRAs, and a toggle left on is somebody else's style quietly
   mixed into your picture. */
eq('and the slot nobody chose is switched off', stackerPrompt['5'].inputs.lora_name_3_toggle, false);
eq('while the chosen ones are on', stackerPrompt['5'].inputs.lora_name_1_toggle, true);
/* And emptied, not merely switched off. A slot still naming somebody else's
   LoRA is one toggle away from applying it, and it is what the graph reports
   when anything asks what ran -- which is why "the workflow's own LoRAs are
   still in there" was a fair reading of a job that used none. */
eq('and the name is cleared too', stackerPrompt['5'].inputs.lora_name_3, 'None');
eq('while a chosen slot keeps its name', stackerPrompt['5'].inputs.lora_name_1, 'mine-a');
// Asking for more than there are slots is capped rather than dropped silently.
eq('more than fits is capped at the ceiling',
  W.applyLoras(stackerPrompt, stackerSpec,
    [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]).applied, 3);

/* A chain: one loader, so a second LoRA is a second *node*. */
const chainPrompt = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'm.safetensors' }, _meta: { source: '10' } },
  '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'theirs', strength_model: 0 }, _meta: { source: '30:15' } },
  '3': { class_type: 'KSampler', inputs: { model: ['2', 0], steps: 8 }, _meta: { source: '3' } },
  '4': { class_type: 'Boolean', inputs: { value: false }, _meta: { source: '30:23' } },
};
const chainSpec = { loras: { style: 'chain', node: '30:15', name: 'lora_name',
  weight: 'strength_model', through: 'model', max: 4,
  also: [{ node: '30:23', input: 'value', value: true }] } };

const chained = W.applyLoras(chainPrompt, chainSpec, [
  { name: 'one', weight: 0.8 }, { name: 'two', weight: 0.5 }, { name: 'three', weight: 0.3 },
]);
eq('three LoRAs are applied', chained.applied, 3);
const loaders = Object.entries(chainPrompt).filter(([, n]) => n.class_type === 'LoraLoaderModelOnly');
eq('by cloning the loader into three', loaders.length, 3);
eq('the original keeps the first', chainPrompt['2'].inputs.lora_name, 'one');
// Chained model-to-model, which is what stacking is at the graph level.
const second = loaders.find(([, n]) => n.inputs.lora_name === 'two');
const third = loaders.find(([, n]) => n.inputs.lora_name === 'three');
eq('the second reads the first', second[1].inputs.model[0], '2');
eq('and the third reads the second', third[1].inputs.model[0], second[0]);
/* The consumer has to move to the *end* of the chain, and the collection of
   consumers has to happen before any clone exists — otherwise the first clone,
   which reads the original, gets repointed at itself and the graph is a loop
   ComfyUI refuses without ever saying why. */
eq('and whoever read the loader now reads the end of the chain',
  chainPrompt['3'].inputs.model[0], third[0]);
check('no node feeds itself',
  Object.entries(chainPrompt).every(([id, n]) =>
    Object.values(n.inputs).every(v => !(Array.isArray(v) && v[0] === id))));
eq('and the switch the graph gates the loader behind is flipped',
  chainPrompt['4'].inputs.value, true);

// Choosing none leaves the graph as its author drew it, at zero strength.
const untouched = {
  '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: 'theirs', strength_model: 1 }, _meta: { source: '30:15' } },
  '4': { class_type: 'Boolean', inputs: { value: false }, _meta: { source: '30:23' } },
};
eq('no LoRAs adds no nodes', W.applyLoras(untouched, chainSpec, []).applied, 0);
eq('and leaves the loader in place, silenced', untouched['2'].inputs.strength_model, 0);
eq('without flipping the switch on', untouched['4'].inputs.value, false);

// An empty row is a row somebody has not filled in, not a LoRA called "".
eq('rows with no name are ignored',
  W.applyLoras(stackerPrompt, stackerSpec, [{ name: '', weight: 1 }, { name: 'real' }]).applied, 1);

const panelSource = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
check('the panel offers a list rather than one picker', /LoraStack/.test(panelSource));
/* Every change is a function of the current list. Two clicks of Add inside one
   frame otherwise both read the list this render closed over, and the second
   overwrites the first — which is exactly what happened: three clicks added
   one row. */
check('and its updates do not capture a stale list',
  /onChange\(current =>/.test(panelSource));
check('with the ceiling enforced where the row is added',
  /current\.length >= slots/.test(panelSource));

/* ------------------------------------------------------- patching a graph */

// A tiny stand-in prompt, so the binding machinery is tested without needing a
// ComfyUI to convert against.
const fakePrompt = {
  '7': { class_type: 'PrimitiveStringMultiline', inputs: { value: 'old' }, _meta: { source: '30:19' } },
  '8': { class_type: 'EmptyLatentImage', inputs: { width: ['9', 0], height: ['9', 1] }, _meta: { source: '30:5' } },
  '9': { class_type: 'ResolutionSelector', inputs: {}, _meta: { source: '49' } },
  '11': { class_type: 'SaveImage', inputs: { filename_prefix: '%date:yyyy-MM-dd%' }, _meta: { source: '29' } },
};

check('a binding finds its node through the renumbering',
  W.findNode(fakePrompt, '30:19') === fakePrompt['7']);
W.applyBinding(fakePrompt, krea.controls.positive, 'a new prompt');
eq('and writes to it', fakePrompt['7'].inputs.value, 'a new prompt');

// Setting a size *replaces* the link from the selector, which is the point of
// an arbitrary resolution.
W.applyBinding(fakePrompt, krea.controls.width, 904);
eq('a literal replaces the wire it overrides', fakePrompt['8'].inputs.width, 904);

/* `%date:…%` is expanded by ComfyUI's *editor* and by nothing else. Left alone
   it reaches SaveImage as a literal directory name and Windows refuses it —
   after the picture has already been generated, which is a peculiarly annoying
   way to lose a minute of GPU time. */
eq('a date token expands', W.expandDateTokens('%date:yyyy-MM-dd%', new Date(2026, 8, 2)), '2026-09-02');
eq('several parts in one token', W.expandDateTokens('%date:yyMMdd-hhmmss%', new Date(2026, 8, 2, 3, 4, 5)), '260902-030405');
eq('and text around it is kept', W.expandDateTokens('a/%date:yyyy%/b', new Date(2026, 0, 1)), 'a/2026/b');
W.expandPromptTokens(fakePrompt, new Date(2026, 8, 2));
check('no editor token survives into the prompt',
  !fakePrompt['11'].inputs.filename_prefix.includes('%date:'));

/* One name per run, or ComfyUI serves the cached save node — and a cached
   output node does not report itself, so the second identical generation comes
   back with no outputs and reads as a failure while having quietly worked. */
const stamped = W.stampOutputs(fakePrompt, 'abc123');
deep('every save node is stamped', stamped, ['11']);
eq('under one folder', fakePrompt['11'].inputs.filename_prefix, 'webui/abc123');

/* ------------------------------------------------------------- the results */

// ComfyUI files webm under `gifs`, so the key it arrives under cannot be
// trusted to say what it is. The extension can.
const outputs = S.outputsOf({
  outputs: {
    '7': { images: [{ filename: 'a.png', subfolder: 'webui', type: 'output' }] },
    '8': { gifs: [{ filename: 'b.webm', subfolder: 'webui', type: 'output' }] },
  },
});
eq('both kinds of output are found', outputs.length, 2);
eq('a png is an image', outputs.find(o => o.filename === 'a.png').media, 'image');
eq('and a webm filed under gifs is still a video',
  outputs.find(o => o.filename === 'b.webm').media, 'video');
eq('an entry with no filename is not an output', S.outputsOf({ outputs: { '7': { images: [{}] } } }).length, 0);
eq('and neither is nothing at all', S.outputsOf(null).length, 0);

const query = S.viewQuery({ filename: 'a b.png', subfolder: 'webui', type: 'output' });
check('the view query escapes the filename', query.includes('a+b.png') || query.includes('a%20b.png'), query);
check('and names the subfolder', query.includes('subfolder=webui'));

/* -------------------------------------------------------------- the queue

   ComfyUI says nothing about a finished job, which is indistinguishable from a
   job it never heard of. So "not in the queue" cannot mean done on its own — the
   route checks the history first, and this only has to tell the three states
   apart. */

const queue = {
  queue_running: [[0, 'running-id']],
  queue_pending: [[0, 'first-id'], [0, 'second-id']],
};
eq('a running job is running', S.queuePosition(queue, 'running-id').state, 'running');
eq('a pending job is queued', S.queuePosition(queue, 'second-id').state, 'queued');
// What is ahead of it, including the one on the GPU right now.
eq('and says how many are in front', S.queuePosition(queue, 'second-id').ahead, 2);
eq('the first pending job counts the running one', S.queuePosition(queue, 'first-id').ahead, 1);
eq('an unknown id is gone', S.queuePosition(queue, 'nope').state, 'gone');
eq('and an empty queue does not throw', S.queuePosition({}, 'x').state, 'gone');

/* --------------------------------------------------------------- the routes */

const routes = S.createStudioRoutes({});
const paths = routes.map(r => r.path).sort();
for (const wanted of ['/studio/models', '/studio/generate', '/studio/job', '/studio/view', '/studio/cancel']) {
  check(`${wanted} is handled`, paths.includes(wanted));
}

/* ------------------------------------------------------------- the wiring */

const api = fs.readFileSync(path.join(ROOT, 'server/api.js'), 'utf8');
// Mounted from inside createApiRoutes, which is the one thing both the dev
// middleware stack and the production server call — so `npm run dev` and
// `npm start` cannot end up with different features.
check('the studio routes are mounted with the rest of the API',
  /createStudioRoutes\(env\)/.test(api));
// Unlike the backend switch these are always on: the panel answers with a
// legible "ComfyUI is not running" rather than a 404, which is the difference
// between a feature that looks broken and one that says what to start. Checked
// by indentation, which is what says whether the call is inside the `if` — two
// spaces is the body of the function, four would be the body of the branch.
check('and are not conditional on the inference backend',
  /^ {2}for \(const studioRoute of createStudioRoutes\(env\)\)/m.test(api));

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
// The two places the sidebar offers. The studio used to be a tab inside the
// system monitor, which is a reasonable place to put a panel and a terrible
// place to find one.
check('the studio is one of the sidebar places', /sidebarPlace === 'studio'/.test(app));
check('chosen from the top of the panel', /sidebar-places/.test(app));
check('and it lays over the chat rather than replacing it', /studio-place/.test(app));
// Switching back has to be free, which it is only if the chat is still there.
check('so the conversation keeps its state', /className="studio-place"/.test(app));

// The multimodal half: the chat model can draw, and what it draws is attached
// to the message as bytes rather than as a link into ComfyUI's temp directory.
const tools = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
check('the model is offered a drawing tool', /name: 'generate_image'/.test(tools));
check('which renders to a tag like every other tool',
  /generate_image: 'TOOL_GENERATE_IMAGE'/.test(tools));
check('the executor runs it', /TOOL_GENERATE_IMAGE/.test(app));
check('and the picture is carried on the message',
  /generated: turnImages/.test(app));
// A `/studio/view` link in a saved chat points at one machine's ComfyUI, which
// the phone opening the same conversation cannot reach.
check('as data rather than as a link that will not travel',
  /readAsDataURL/.test(app) && /dataUrl/.test(app));

/* =================================== the workflow author's own picture

   These files were exported from somebody's ComfyUI mid-session, so they came
   with whatever was in the boxes at the time: a Safebooru post's tags, a chain
   of artist handles, a block of quality words, a style appended to every
   prompt. Every one of those *draws something*, and none of it is visible from
   the Studio -- so a prompt asking for a lighthouse came back as a twin-tailed
   girl with tomato hair ornaments, and the person who typed it had no way to
   see why.

   Replacing the positive prompt is not enough, which is the part that had to be
   traced rather than assumed: the user's text conditions the sampler, while a
   second path carries the author's into `AnimaArtistPack`, which patches the
   model itself through cross attention. So what is emptied is the places the
   author's words *originate*, and everything downstream concatenates nothing. */

const authored = {
  '1': { class_type: 'Get Booru Tag ED', inputs: { url: 'https://safebooru.org/post', text_b: '1girl, tomato' }, _meta: { source: '1295' } },
  '2': { class_type: 'Simple Text ED', inputs: { text: 'a block of style words' }, _meta: { source: '1296' } },
  '3': { class_type: 'Simple Text ED', inputs: { text: '(@an artist:1.3)' }, _meta: { source: '1390' } },
  '4': { class_type: 'KSampler', inputs: { steps: 8 }, _meta: { source: '9' } },
};
const blankSpec = { blank: [
  { node: '1295', input: 'text_b' },
  { node: '1295', input: 'url', value: 'None' },
  { node: '1296', input: 'text' },
  { node: '1390', input: 'text' },
  { node: '9999', input: 'text' },
] };

/* The prompt boxes come empty whatever the workflow, by role rather than by a
   list -- because the list was wrong. Three of these were missed on the first
   pass and every one was invisible the same way: the value only shows itself
   when the box is left blank, so testing by typing a prompt proves nothing.
   Krea 2 shipped a character sheet in its positive box, MiniMax a named
   character and a reference-picture description, and Anima three hundred words
   of negative including `twintails`, `detailed background` and `colorful` --
   terms that argue with whatever was actually asked for. */
const withPrompts = {
  '1': { class_type: 'PrimitiveStringMultiline', inputs: { value: "the author's own picture" }, _meta: { source: '17' } },
  '2': { class_type: 'Simple Text ED', inputs: { text: 'three hundred words of negative' }, _meta: { source: '18' } },
  '3': { class_type: 'KSampler', inputs: { sampler_name: 'euler', steps: 20 }, _meta: { source: '19' } },
};
W.clearAuthorContent(withPrompts, { controls: {
  positive: { node: '17', input: 'value' },
  negative: { node: '18', input: 'text' },
  sampler: { node: '19', input: 'sampler_name' },
  steps: { node: '19', input: 'steps' },
} });
eq('the positive box starts empty', withPrompts['1'].inputs.value, '');
eq('and so does the negative', withPrompts['2'].inputs.text, '');
/* Only the two text roles. Every other control points at a number, a filename
   or an enum, and "" is not a legal value for any of them -- a blanked
   `sampler_name` is a graph ComfyUI refuses. */
eq('a sampler is not a prompt', withPrompts['3'].inputs.sampler_name, 'euler');
eq('nor is a step count', withPrompts['3'].inputs.steps, 20);
// A workflow with no negative control must not grow one.
check('and a workflow without one is untouched',
  W.clearAuthorContent({}, { controls: { positive: { node: 'nope', input: 'x' } } }).missing.length === 0);

// The real ones, since that is where it matters.
for (const definition of Object.values(W.WORKFLOWS)) {
  for (const role of ['positive', 'negative', 'artist']) {
    if (!definition.controls?.[role]) continue;
    const built = { x: { class_type: 'T', inputs: { [definition.controls[role].input]: 'theirs' },
      _meta: { source: definition.controls[role].node } } };
    W.clearAuthorContent(built, definition);
    eq(`${definition.id}: the ${role} box is empty`, built.x.inputs[definition.controls[role].input], '');
  }
}

const cleared = W.clearAuthorContent(authored, blankSpec);
eq('the booru tags are gone', authored['1'].inputs.text_b, '');
eq('the style block too', authored['2'].inputs.text, '');
eq('and the artist chain', authored['3'].inputs.text, '');
/* `url` is not fetched during execution -- the editor does that -- but it names
   a specific post and is the author's, so it goes back to its declared default
   rather than to an empty string a combo would refuse. */
eq('a value can be something other than empty', authored['1'].inputs.url, 'None');
eq('nothing else is touched', authored['4'].inputs.steps, 8);
/* Reported rather than swallowed: a binding pointing at a node an edited
   workflow no longer has should say so, not go quiet. */
deep('a binding with no node says so', cleared.missing, ['9999.text']);

/* Emptying is the point, so it must not go through the guard that refuses empty
   values -- `applyBinding` returns false for '' and would leave the author's
   text exactly where it was. */
const workflowsSource = fs.readFileSync(path.join(ROOT, 'server/workflows.js'), 'utf8');
check('emptying does not run through applyBinding',
  /clearAuthorContent[\s\S]{0,3000}node\.inputs\[entry\.input\] =/.test(workflowsSource));
check('and neither does emptying the prompt boxes',
  /for \(const role of \['positive', 'negative', 'artist'\]\)[\s\S]{0,320}node\.inputs\[binding\.input\] = '';/.test(workflowsSource));

// And the real workflows declare it, since that is the only place it matters.
eq('anima says what to empty', (W.WORKFLOWS['anima-base'].blank || []).length, 4);

/* Anima has a real place to put artist tags, so they are not concatenated into
   the prompt: `AnimaArtistPack` encodes each artist separately and
   `AnimaArtistCrossAttn` patches the model with them, which is a different
   mechanism from naming an artist in the prompt and the whole reason that pack
   is in the graph. The other two workflows have no such node, and the panel
   folds the artists into the prompt for them instead. */
eq('anima routes artists to its artist encoder',
  W.WORKFLOWS['anima-base'].controls.artist?.node, '1390');
check('and the other workflows have no artist input',
  !W.WORKFLOWS['krea2-turbo'].controls.artist && !W.WORKFLOWS['minimax-h3'].controls.artist);
check('krea2 empties the style it appends to every prompt',
  (W.WORKFLOWS['krea2-turbo'].blank || []).some(b => b.node === '30:27' && b.input === 'string_b'));
// Queued jobs go through it before the user's values, or none of the above
// reaches a picture.
check('and the queue route clears before it fills in',
  /clearAuthorContent\(graph, definition\)[\s\S]{0,900}applyJob\(graph/.test(
    fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8')));

/* ============================== the seed has to reach the thing that samples

   Anima's `KSampler (Efficient) ED` has a `set_seed_cfg_sampler` mode, and the
   workflow leaves it on its default, "from context":

       if mode == "from context":
           _, c_seed, c_cfg, c_sampler, c_scheduler =
               context_2_tuple_ed(context, ["seed", "cfg", "sampler", "scheduler"])
           seed, cfg, sampler_name, scheduler = c_seed, c_cfg, c_sampler, c_scheduler

   — it overwrites all four from the context and ignores its own widgets. The
   context is built by `Efficient Loader ED`, so that is where they live.

   Writing the seed only to the sampler left the loader's `-1` in place on every
   run, and three separately-reported bugs followed from that one value: the
   seed control did nothing, a second run "started from AnimaPiD" because every
   input to the sampler was identical and ComfyUI served the cached latent, and
   the picture that came back did not match the prompt in its own metadata — the
   metadata was the new graph, the picture was the old latent. */

const anima2 = W.WORKFLOWS['anima-base'];
for (const [role, loaderInput] of [
  ['seed', 'seed'], ['cfg', 'cfg'], ['sampler', 'sampler_name'], ['scheduler', 'scheduler'],
]) {
  const binding = anima2.controls[role];
  eq(`anima's ${role} is written where the context reads it`, binding.node, '1291');
  eq(`  as ${loaderInput}`, binding.input, loaderInput);
  // And to the sampler as well, for a workflow re-exported on "from node only".
  check(`  and to the sampler too`,
    (binding.also || []).some(a => a.node === '1298'), JSON.stringify(binding.also));
}
/* Steps is not one of the four the context overrides, so it stays where the
   sampler reads it. */
eq('but steps stays on the sampler', anima2.controls.steps.node, '1298');

/* `also` does two different things and the difference is whether a `value` was
   given. With one it is a gate — Krea 2 hides its LoRA loader behind a boolean
   that choosing a LoRA has to switch on. Without one it is the same value in a
   second place, which is what a node readable from either of two inputs needs. */
const twoPlaces = {
  a: { class_type: 'Loader', inputs: { seed: -1 }, _meta: { source: 'A' } },
  b: { class_type: 'Sampler', inputs: { seed: 0 }, _meta: { source: 'B' } },
  c: { class_type: 'Boolean', inputs: { value: false }, _meta: { source: 'C' } },
};
W.applyBinding(twoPlaces, { node: 'A', input: 'seed', also: [{ node: 'B', input: 'seed' }] }, 4242);
eq('a value goes where it is bound', twoPlaces.a.inputs.seed, 4242);
eq('and to the second place too', twoPlaces.b.inputs.seed, 4242);
W.applyBinding(twoPlaces, { node: 'A', input: 'seed', also: [{ node: 'C', input: 'value', value: true }] }, 7);
eq('while a gate keeps its own value', twoPlaces.c.inputs.value, true);
eq('rather than taking the bound one', typeof twoPlaces.c.inputs.value, 'boolean');

/* ===================================== editing a picture rather than drawing

   Two workflows, two mechanisms, and the same shape of difference as the LoRA
   stacker versus the LoRA chain: Anima's loader already takes an image and has
   a mode to switch, and Krea 2 samples from an `EmptyLatentImage` and has to be
   given the two nodes that encode one. */

const animaEdit = {
  a: { class_type: 'Load Image ED', inputs: { image: 'example.png', width: 1664, height: 2432, upscale_method: '🚫 Do not upscale', keep_proportions: '2x' }, _meta: { source: '1176' } },
  b: { class_type: 'Efficient Loader ED', inputs: { paint_mode: '✍️ Txt2Img' }, _meta: { source: '1291' } },
  c: { class_type: 'KSampler ED', inputs: { denoise: 1 }, _meta: { source: '1298' } },
};
const nativeOut = W.applyImg2Img(animaEdit, W.WORKFLOWS['anima-base'],
  { image: 'ref.png', denoise: 0.4, size: { width: 832, height: 1216 } });
check('anima takes the picture', nativeOut.applied);
eq('  by name', animaEdit.a.inputs.image, 'ref.png');
/* The mode is what decides whether the picture is used at all. Without it the
   file is loaded, ignored, and a brand new picture comes back — which looks
   exactly like the feature working until you compare the two. */
eq('  and switches the loader to img2img', animaEdit.b.inputs.paint_mode, '🦱 Img2Img');
eq('  with how much to change it', animaEdit.c.inputs.denoise, 0.4);

/* A picture from this app is not the picture the sampler made: it has been
   through an upscaler and comes back four times larger. Feeding that back is a
   latent nine times the area — measured, it filled a 16GB card and ground to a
   halt where a generation takes seventy seconds. */
eq('  brought down to the size being worked at', animaEdit.a.inputs.width, 832);
eq('  and the other side', animaEdit.a.inputs.height, 1216);
/* The loader ships set to "do not upscale", so the size above would be read
   and ignored. */
eq('  with a method that actually resizes', animaEdit.a.inputs.upscale_method, 'lanczos');

const kreaEdit = {
  '1': { class_type: 'VAELoader', inputs: { vae_name: 'v.safetensors' }, _meta: { source: '30:12' } },
  '2': { class_type: 'EmptyLatentImage', inputs: { width: 8, height: 8 }, _meta: { source: '30:5' } },
  '3': { class_type: 'KSampler', inputs: { latent_image: ['2', 0], denoise: 1 }, _meta: { source: '30:3' } },
};
const encodeOut = W.applyImg2Img(kreaEdit, W.WORKFLOWS['krea2-turbo'],
  { image: 'ref.png', denoise: 0.6, size: { width: 832, height: 1216 } });
check('krea 2 is given the wiring it lacks', encodeOut.applied);
eq('  three nodes: load, scale, encode', encodeOut.added.length, 3);
const encode = Object.values(kreaEdit).find(n => n.class_type === 'VAEEncode');
const scale = Object.values(kreaEdit).find(n => n.class_type === 'ImageScale');
const load = Object.values(kreaEdit).find(n => n.class_type === 'LoadImage');
check('  the sampler now starts from the encoded picture',
  kreaEdit['3'].inputs.latent_image[0] === Object.keys(kreaEdit).find(k => kreaEdit[k] === encode));
check('  which came through the scale', encode.inputs.pixels[0] === Object.keys(kreaEdit).find(k => kreaEdit[k] === scale));
check('  which came from the load', scale.inputs.image[0] === Object.keys(kreaEdit).find(k => kreaEdit[k] === load));
eq('  at the size being worked at', scale.inputs.width, 832);
/* The encode borrows the VAE the workflow already loads for the decode at the
   other end, rather than loading a second copy of the same file into VRAM. */
eq('  and borrows the VAE already loaded', encode.inputs.vae[0], '1');
eq('  with how much to change it', kreaEdit['3'].inputs.denoise, 0.6);

// Nothing asked for is nothing done — and a workflow that cannot must say so
// rather than quietly making a fresh picture, which is the failure that looks
// like the feature working.
check('no picture is no edit', !W.applyImg2Img({}, W.WORKFLOWS['anima-base'], {}).applied);
check('and a workflow without the spec refuses',
  !W.applyImg2Img({}, { id: 'x' }, { image: 'ref.png' }).applied);

const studioSource = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8');
check('the queue route passes the size through', /size: parseSize\(job\.size/.test(studioSource));
check('and warns when a workflow cannot take a reference',
  /cannot work from an existing picture/.test(studioSource));

/* ===================== the artists are encoded with the prompt, not alone

   `AnimaArtistPack` encodes each artist as `f"{name}\n{base}" if base else
   name`, and the cross-attention node blends those encodings into the model at
   full strength. With `base_prompt` empty — it was wired to the author's text
   nodes, which are blanked — every artist was a bare name with no subject, and
   nine of those averaged into the attention washed the prompt out. Reported as
   "pictures stopped following the prompt when the prompt was split into four
   boxes": the split is what put artists into the chain. */

const animaArtists = W.WORKFLOWS['anima-base'];
check('the positive prompt also reaches the artist pack',
  (animaArtists.controls.positive.also || []).some(a => a.node === '1386' && a.input === 'base_prompt'));
// Same value, not a fixed one — `also` without `value` carries the prompt.
check('as the prompt itself, not a fixed value',
  !(animaArtists.controls.positive.also || []).some(a => 'value' in a));

const pack = {
  l: { class_type: 'Efficient Loader ED', inputs: { positive: ['x', 0] }, _meta: { source: '1291' } },
  p: { class_type: 'AnimaArtistPack', inputs: { base_prompt: ['y', 0], artist_chain: ['z', 0] }, _meta: { source: '1386' } },
};
W.applyBinding(pack, animaArtists.controls.positive, '1girl, lighthouse, dusk');
eq('the loader gets the prompt', pack.l.inputs.positive, '1girl, lighthouse, dusk');
// A literal replaces the link to the blanked author nodes.
eq('and the pack encodes each artist with it', pack.p.inputs.base_prompt, '1girl, lighthouse, dusk');

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['studio.title', 'studio.tab', 'studio.makeImage', 'studio.noBackend', 'studio.seedLocked']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
/* The Studio's own rules moved to studio.css, where all of them live now —
   they had accumulated as a dozen override layers in extras.css that had
   started cancelling each other out. The conversation's picture strip stays
   in extras.css. Either file counts. */
const studioCss = fs.readFileSync(path.join(ROOT, 'src/studio.css'), 'utf8');
check('the Studio imports its own stylesheet',
  /import '\.\/studio\.css';/.test(fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8')));
for (const rule of ['.studio-form', '.studio-gallery', '.studio-job', '.msg-generated']) {
  check(`${rule} is styled`, (css + studioCss).includes(rule));
}

/* ------------------------------------------------------------ preview ranges

   A preview clip is played by a <video>, which asks for byte ranges -- and the
   progress card seeks each new step's clip to where the last had got to. */

const same = (got, want) => JSON.stringify(got) === JSON.stringify(want);
check('no header is the whole body', S.rangeOf(undefined, 100) === null);
check('an open range runs to the end', same(S.rangeOf('bytes=10-', 100), { start: 10, end: 99 }));
check('a closed one is inclusive', same(S.rangeOf('bytes=0-9', 100), { start: 0, end: 9 }));
check('a suffix is the last n bytes', same(S.rangeOf('bytes=-10', 100), { start: 90, end: 99 }));
check('an end past the body is clipped to it', same(S.rangeOf('bytes=50-500', 100), { start: 50, end: 99 }));
check('a start past the body cannot be satisfied', S.rangeOf('bytes=100-', 100) === false);
check('several ranges get the whole body', S.rangeOf('bytes=0-1,5-6', 100) === null);

/* ------------------------------------------------------- a result's settings

   Read back out of the graph, so a sampler nobody chose is still reported --
   it is what the picture was drawn with. */

const DEF = {
  controls: {
    width: { node: '5', input: 'width' },
    height: { node: '5', input: 'height' },
    seed: { node: '3', input: 'seed' },
    steps: { node: '3', input: 'steps' },
    cfg: { node: '3', input: 'cfg' },
    sampler: { node: '3', input: 'sampler_name' },
    scheduler: { node: '3', input: 'scheduler' },
    model: { node: '4', input: 'ckpt_name' },
    vae: { node: '6', input: 'vae_name' },
    duration: { node: '7', input: 'value', also: [{ node: '8', input: 'value', value: true }] },
  },
  img2img: { denoise: { node: '3', input: 'denoise' } },
};
const graph = () => ({
  3: { class_type: 'KSampler', inputs: { seed: 7, steps: 28, cfg: 5.5, sampler_name: 'euler', scheduler: 'karras', denoise: 0.6, model: ['4', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'anime\\anima.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216 } },
  6: { class_type: 'VAELoader', inputs: { vae_name: ['9', 0] } },
  7: { class_type: 'PrimitiveInt', inputs: { value: 5 } },
  8: { class_type: 'PrimitiveBoolean', inputs: { value: false } },
});
const read = W.readSettings(graph(), DEF);
eq('a result reports the sampler it ran with', read.sampler, 'euler');
eq('and the scheduler nobody picked', read.scheduler, 'karras');
eq('and its size', `${read.width}x${read.height}`, '832x1216');
eq('the checkpoint is reported as such', read.checkpoint, 'anime\\anima.safetensors');
check('a value that is a wire is not a setting', !('vae' in read));
check('a control behind a gate is left out when this job did not set it', !('duration' in read));
eq('and reported when it did', W.readSettings(graph(), DEF, { applied: ['duration'] }).duration, 5);
eq('an edit reports the strength it ran at', W.readDenoise(graph(), DEF), 0.6);
check('and a workflow without edits reports none', W.readDenoise(graph(), { controls: {} }) === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
