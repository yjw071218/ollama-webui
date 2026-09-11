/**
 * The three workflows, and which knob is where inside them.
 *
 * ## Why a binding table rather than a builder
 *
 * The first version of this file wrote ComfyUI graphs by hand — seven nodes,
 * loader to encoder to sampler to save. That is fine for a demo and wrong for
 * real work: the workflows people actually use have prompt formatters, LoRA
 * stacks, upscalers, frame interpolation and half a dozen switches, and none of
 * that survives being re-typed as a literal in a JavaScript file.
 *
 * So the workflow is the artefact. It is exported from ComfyUI, kept in
 * `workflows/`, and this file says only where the interesting inputs live:
 * "the positive prompt is node 30:19's `value`", "width is node 30:5's
 * `width`". Everything else in the graph stays exactly as its author left it.
 *
 * ## Why the bindings are written out rather than guessed
 *
 * They were found by tracing each graph, and they have to be: there is no
 * reliable heuristic. Krea 2 puts its prompt in a `PrimitiveStringMultiline`
 * feeding a text refiner; Anima runs its prompt through a booru fetcher and a
 * formatter before it reaches the encoder, so the honest injection point is the
 * loader's `positive` socket rather than any text node; MiniMax reads its
 * resolution from two `PrimitiveInt`s that are only consulted when a `CustomRes`
 * boolean is on. A rule that got all three right by accident would get the
 * fourth one wrong silently.
 *
 * ## What "not present" means
 *
 * A binding may be absent, and that is information rather than an omission.
 * Krea 2 Turbo has no negative prompt at all — its negative conditioning is a
 * `ConditioningZeroOut`, because the model is guidance-distilled and runs at a
 * CFG of 1, where a negative prompt has no effect on the result.
 *
 * The first version of this simply left the control out, and that was wrong in
 * a way worth writing down: a missing control and an unbuilt feature look
 * exactly alike. Somebody opening the Studio on the default workflow saw no
 * negative box and reasonably concluded the negative prompt had not been
 * implemented. So absence is now *stated* — `missing` carries the reason, the
 * Studio shows the control greyed with that reason beside it, and "this
 * workflow cannot do that" stops being indistinguishable from "this app cannot
 * do that".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toApiPrompt } from './comfyGraph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_DIR = path.resolve(HERE, '..', 'workflows');

/* A binding is `{ node, input }` — where in the graph, and which of its
 * inputs. `also` carries the switches a control has to flip to take effect:
 * MiniMax ignores its width and height entirely unless `CustomRes` is on, so
 * setting the size without setting that boolean is a control that appears to do
 * nothing. */

export const WORKFLOWS = {
  'krea2-turbo': {
    id: 'krea2-turbo',
    label: 'Krea 2 Turbo',
    kind: 'image',
    file: 'krea2_turbo.json',
    note: 'Distilled: 8 steps, guidance 1. Has a built-in prompt refiner.',
    controls: {
      // The user prompt box of the refiner subgraph. The system prompt beside
      // it (30:18) is the refiner's instructions and is deliberately left alone.
      positive: { node: '30:19', input: 'value' },
      // No negative: this graph zeroes its negative conditioning.
      width: { node: '30:5', input: 'width' },
      height: { node: '30:5', input: 'height' },
      batch: { node: '30:5', input: 'batch_size' },
      seed: { node: '75', input: 'seed' },
      steps: { node: '30:3', input: 'steps' },
      cfg: { node: '30:3', input: 'cfg' },
      sampler: { node: '30:3', input: 'sampler_name' },
      scheduler: { node: '30:3', input: 'scheduler' },
      model: { node: '30:10', input: 'unet_name', kind: 'diffusion_models' },
      vae: { node: '30:12', input: 'vae_name', kind: 'vae' },
      clip: { node: '30:11', input: 'clip_name', kind: 'text_encoders' },
      refinePrompt: { node: '30:24', input: 'value' },
    },
    /* One `LoraLoaderModelOnly`, which holds exactly one LoRA — so more than
       one means *more nodes*. See `applyLoras`: the loader is cloned and the
       clones are chained through their `model` input, which is what stacking
       LoRAs is at the graph level. Six is a self-imposed ceiling rather than a
       limit of the node; past that the weights fight each other and the load
       time is real. */
    loras: {
      style: 'chain',
      node: '30:15',
      name: 'lora_name',
      weight: 'strength_model',
      through: 'model',
      max: 6,
      kind: 'loras',
      // Naming a LoRA is not enough; this graph gates the whole loader behind
      // a boolean, so choosing one has to switch it on.
      also: [{ node: '30:23', input: 'value', value: true }],
    },
    /* One boolean switches two things in this graph: the LoRA loader *and* a
       concatenation that appends the author's own "muted minimalist sketch
       style, no text" to every prompt. Choosing a LoRA flips it, so a person
       who picks a LoRA silently gets a style they never asked for. Blanking the
       text is what decouples them. */
    blank: [{ node: '30:27', input: 'string_b' }],
    defaults: { steps: 8, cfg: 1, width: 1024, height: 1360, sampler: 'euler', scheduler: 'simple' },
    ranges: { steps: [1, 30], cfg: [0.5, 4] },
    /* Why a control this workflow does not have is missing. Shown beside the
       greyed-out field, because "this workflow cannot" and "this app cannot"
       look identical when a control is simply absent. */
    /* Editing a picture rather than starting from noise.
     *
     * This graph samples from an `EmptyLatentImage`, so there is nowhere to put
     * a picture — the two nodes that would encode one are not in it. They are
     * installed in ComfyUI, though, and the workflow already loads a VAE for
     * the decode at the other end, so the pair is added at request time and the
     * sampler's latent is repointed at them. See `applyImg2Img`.
     *
     * Which is the same shape of decision as the LoRA chain: a workflow either
     * has the wiring or gets it, and the difference is written down here rather
     * than discovered in the middle of a generation. */
    img2img: {
      style: 'encode',
      latent: { node: '30:3', input: 'latent_image' },
      vae: { node: '30:12' },
      denoise: { node: '30:3', input: 'denoise' },
      // Nothing here can resize, so the scale node is added with the rest.
      resize: { style: 'node' },
      /* Redrawing one part. The latent the encode made is masked before the
         sampler sees it, so the sampler only moves what is inside. See
         `applyRegionEdit`. */
      inpaint: { style: 'noiseMask' },
    },
    missing: {
      negative: 'guidanceDistilled',
      duration: 'stillsOnly',
    },
  },

  'anima-base': {
    id: 'anima-base',
    label: 'Anima Base',
    kind: 'image',
    file: 'anima.json',
    note: 'Anime and illustration. Takes booru tags or a sentence.',
    controls: {
      /* The loader's own sockets, not the text nodes upstream of them.
       *
       * Anima's positive prompt arrives through a booru fetcher and a prompt
       * formatter carrying the workflow author's own artist tags. Writing into
       * the first text node in that chain would blend the user's prompt with
       * somebody else's style; writing into the socket replaces the chain, which
       * is what someone typing a prompt into a box means. The orphaned branch
       * costs nothing — ComfyUI only runs what an output depends on. */
      /* And the same text into the artist pack's `base_prompt`, which is not
       * optional in any sense that matters. The pack encodes every artist as
       *
       *     text = f"{name}
{base}" if base else name
       *
       * and the cross-attention node then blends those encodings into the
       * model at full strength. `base_prompt` was wired to the author's text
       * nodes, which are blanked, so each artist arrived as a bare name with no
       * subject — and nine subject-less "(@artist)" encodings averaged into the
       * attention wash the actual prompt out. That is why pictures stopped
       * following the prompt the moment the artist box existed: before it, the
       * chain was empty and the pack did nothing. In the author's own graph the
       * base is the whole prompt; this puts it back. */
      positive: { node: '1291', input: 'positive', also: [{ node: '1386', input: 'base_prompt' }] },
      negative: { node: '1285', input: 'text' },
      /* This workflow has a real place to put artist tags, so they do not get
         concatenated into the prompt: `AnimaArtistPack` encodes each artist
         separately and `AnimaArtistCrossAttn` patches the model with them,
         which is a different mechanism from naming an artist in the prompt and
         the reason the pack exists. Empty means no artists, and the pack then
         passes the model through untouched. */
      artist: { node: '1390', input: 'text' },
      width: { node: '1291', input: 'image_width' },
      height: { node: '1291', input: 'image_height' },
      batch: { node: '1291', input: 'batch_size' },
      /* The sampler's own seed, cfg, sampler and scheduler widgets are not
       * what it runs with.
       *
       * `KSampler (Efficient) ED` has a `set_seed_cfg_sampler` mode, and this
       * workflow leaves it on its default, "from context":
       *
       *     if mode == "from context":
       *         _, c_seed, c_cfg, c_sampler, c_scheduler =
       *             context_2_tuple_ed(context, ["seed", "cfg", "sampler", "scheduler"])
       *         seed, cfg, sampler_name, scheduler = c_seed, c_cfg, c_sampler, c_scheduler
       *
       * — it overwrites all four from the context and ignores its own. The
       * context is built by `Efficient Loader ED`, which is therefore where
       * these actually live.
       *
       * Written to that node was a seed of `-1`, unchanged on every run. Three
       * things followed from it and all three were reported as separate bugs:
       * the seed control did nothing, a second run "started from AnimaPiD"
       * because every input to the sampler was identical and ComfyUI served
       * the cached latent, and the picture that came back did not match the
       * prompt in its own metadata — the metadata was the new graph and the
       * picture was the old latent.
       *
       * `-1` was not even a legal value: the loader declares `seed` as
       * `{"min": 0}`.
       *
       * Both nodes are set. "from context" reads the loader; "from node only"
       * reads the sampler; and a workflow re-exported with either mode then
       * behaves the same way. */
      seed: { node: '1291', input: 'seed', also: [{ node: '1298', input: 'seed' }] },
      cfg: { node: '1291', input: 'cfg', also: [{ node: '1298', input: 'cfg' }] },
      sampler: { node: '1291', input: 'sampler_name', also: [{ node: '1298', input: 'sampler_name' }] },
      scheduler: { node: '1291', input: 'scheduler', also: [{ node: '1298', input: 'scheduler' }] },
      // Steps is not one of the four the context overrides, so it stays where
      // the sampler reads it.
      steps: { node: '1298', input: 'steps' },
      model: { node: '1291', input: 'ckpt_name', kind: 'checkpoints' },
      vae: { node: '1291', input: 'vae_name', kind: 'vae' },
    },
    /* A `LoRA Stacker` with nine slots, which is the whole point of a stacker:
       it takes nine already and needs no new nodes. Each slot is a name, a
       weight and a toggle, and `lora_count` is how many of them it reads. */
    loras: {
      style: 'slots',
      node: '1380',
      slots: 9,
      name: 'lora_name_%',
      weight: 'lora_wt_%',
      toggle: 'lora_name_%_toggle',
      count: 'lora_count',
      max: 9,
      kind: 'loras',
    },
    /* The author's own picture, which the graph draws when nobody stops it.
     *
     * Replacing the `positive` socket is not enough here, and finding that out
     * took tracing the graph forwards: the user's prompt conditions the
     * sampler, but a *second* path carries the author's text into
     * `AnimaArtistPack`, which patches the model itself through cross
     * attention. A prompt asking for a lighthouse came back as a twin-tailed
     * girl with tomato hair ornaments -- every one of those is a tag below,
     * from the Safebooru post this workflow was built around.
     *
     * So the four places the author's own words *originate* are emptied, and
     * everything downstream concatenates nothing. With no artists in the chain
     * the pack returns no conditionings and the cross-attention passes the
     * model through untouched, which is what an empty prompt box should mean.
     * `url` is not fetched during execution -- the editor does that -- but it
     * names a specific post and is the author's, so it goes back to its
     * declared default. */
    blank: [
      { node: '1295', input: 'text_b' },              // the post's tags
      { node: '1295', input: 'url', value: 'None' },  // and the post
      { node: '1296', input: 'text' },                // a block of style words
      { node: '1389', input: 'text' },                // quality and year tags
      // 1390, the artist chain, is a control now and is emptied by role.
    ],
    defaults: { steps: 40, cfg: 7, width: 1296, height: 1728, sampler: 'euler_ancestral', scheduler: 'simple' },
    ranges: { steps: [8, 60], cfg: [1, 12] },
    /* Already wired for it: the loader takes `pixels` from a `Load Image ED`
       and has a `paint_mode` that switches between starting from noise and
       starting from that picture. Nothing is added — the mode is flipped and
       the file named. */
    img2img: {
      style: 'native',
      image: { node: '1176', input: 'image' },
      mode: { node: '1291', input: 'paint_mode', value: '🦱 Img2Img' },
      denoise: { node: '1298', input: 'denoise' },
      /* And brought down to the size being worked at. See `applyImg2Img`: a
         picture from this app is the *finished* one, four times the resolution
         it was sampled at, and encoding that is nine times the work. */
      resize: {
        node: '1176',
        width: 'width',
        height: 'height',
        method: { input: 'upscale_method', value: 'lanczos' },
        fit: { input: 'keep_proportions', value: 'based on width' },
      },
      /* Redrawing one part. The loader has an inpaint mode of its own that
         takes a mask beside the picture -- `InpaintModelConditioning`, which
         leaves the latent masked -- so the mode is flipped and the mask
         plugged in where the Load Image node's alpha used to go. The pixels
         the mask is found in are that node's output: the reference, already
         brought down to the size being sampled. */
      inpaint: {
        style: 'native',
        mode: { node: '1291', input: 'paint_mode', value: '🎨 Inpaint(Ksampler)' },
        mask: { node: '1291', input: 'mask' },
        pixels: { node: '1176', output: 0 },
      },
    },
    missing: { duration: 'stillsOnly', clip: 'builtIn' },
  },

  'minimax-h3': {
    id: 'minimax-h3',
    label: 'MiniMax H3',
    kind: 'video',
    file: 'minimax.json',
    note: 'Video with sound. Takes a reference image, which is what makes '
      + '"turn this picture into a video" work.',
    /* The MiniMax H3 Community Licence names an Applicable Territory that
     * excludes the European Union, the United Kingdom, South Korea and the
     * United States from *local* deployment; the hosted API is worldwide and is
     * the licensed route in those places. Raised with the owner of this install,
     * who chose to run it locally. Recorded here so the next reader is not
     * surprised by it. */
    licence: 'MiniMax H3 Community License: local deployment is not licensed in the '
      + 'European Union, the United Kingdom, South Korea or the United States.',
    controls: {
      positive: { node: '17', input: 'value' },
      // The size nodes are only consulted when the graph's own CustomRes switch
      // is on, so setting one without the other is a control that does nothing.
      width: { node: '15:99', input: 'value', also: [{ node: '15:98', input: 'value', value: true }] },
      height: { node: '15:100', input: 'value', also: [{ node: '15:98', input: 'value', value: true }] },
      seed: { node: '131', input: 'seed' },
      steps: { node: '34:32', input: 'steps' },
      scheduler: { node: '34:32', input: 'scheduler' },
      sampler: { node: '34:31', input: 'sampler_name' },
      model: { node: '5:6', input: 'unet_name', kind: 'diffusion_models' },
      vae: { node: '5:2', input: 'vae_name', kind: 'vae' },
      clip: { node: '5:1', input: 'clip_name', kind: 'text_encoders' },
      duration: { node: '15:7', input: 'value' },
      fps: { node: '15:8', input: 'value' },
      // What makes image-to-video possible at all.
      referenceImage: { node: '20', input: 'image' },
    },
    defaults: { steps: 20, width: 1088, height: 1088, duration: 5, fps: 24, scheduler: 'simple', sampler: 'res_multistep' },
    ranges: { steps: [8, 50], duration: [1, 20] },
    missing: { negative: 'noNegativeNode', cfg: 'fixedGuidance', lora: 'noLoraNode' },
  },
};

/* --------------------------------------------------------------- loading */

const cache = new Map();

/** One workflow, as ComfyUI's editor saved it. */
export const readWorkflow = (definition, dir = WORKFLOW_DIR) => {
  const file = path.join(dir, definition.file);
  const stat = fs.statSync(file);
  const key = `${file}:${stat.mtimeMs}`;
  // Keyed by modification time, so editing a workflow and saving it over the
  // top takes effect without a restart — which is how anyone actually works on
  // one of these.
  if (cache.has(key)) return cache.get(key);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(key, parsed);
  return parsed;
};

/* ------------------------------------------------------- the date in a name

   `filename_prefix: "%date:yyyy-MM-dd%/%date:MM-dd%"` is how ComfyUI's editor
   writes "a folder per day", and the editor is also the only thing that expands
   it: the token reaches the server verbatim, `SaveImage` treats it as a literal
   directory name, and Windows refuses it —

     [WinError 267] 디렉터리 이름이 올바르지 않습니다:
       …\output\%date:yyyy-MM-dd%

   The picture had already been generated by then. It was the *saving* that
   failed, which is a peculiarly annoying way to lose a minute of GPU time, and
   from the outside it looked exactly like a workflow that produced nothing. */

const DATE_PARTS = (at) => ({
  yyyy: String(at.getFullYear()),
  yy: String(at.getFullYear()).slice(-2),
  MM: String(at.getMonth() + 1).padStart(2, '0'),
  dd: String(at.getDate()).padStart(2, '0'),
  hh: String(at.getHours()).padStart(2, '0'),
  mm: String(at.getMinutes()).padStart(2, '0'),
  ss: String(at.getSeconds()).padStart(2, '0'),
});

export const expandDateTokens = (text, at = new Date()) => {
  const parts = DATE_PARTS(at);
  return String(text).replace(/%date:([^%]+)%/g, (_, format) =>
    // Longest first, so `yyyy` is not eaten as two `yy`s.
    format.replace(/yyyy|yy|MM|dd|hh|mm|ss/g, (token) => parts[token] ?? token));
};

/** Every string input in a prompt, with its editor tokens expanded. */
export const expandPromptTokens = (prompt, at = new Date()) => {
  for (const node of Object.values(prompt)) {
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (typeof value === 'string' && value.includes('%date:')) {
        node.inputs[name] = expandDateTokens(value, at);
      }
    }
  }
  return prompt;
};

/** One workflow, as ComfyUI's API wants it. */
export const buildPrompt = (definition, objectInfo, dir = WORKFLOW_DIR) => {
  const built = toApiPrompt(readWorkflow(definition, dir), objectInfo);
  return { ...built, prompt: expandPromptTokens(built.prompt) };
};

/* --------------------------------------------------------------- patching */

/**
 * Put one value into the graph.
 *
 * Setting an input that is currently a link *replaces* the link, which is the
 * point: a resolution that comes out of a selector node is exactly the thing an
 * arbitrary width and height is meant to override. Returns whether it landed,
 * so a control bound to a node that a workflow edit has removed reports itself
 * rather than silently doing nothing.
 */
/**
 * The node a binding names.
 *
 * Bindings are written in the editor's numbering — `30:19` is node 19 inside
 * the subgraph instantiated at node 30 — because that is what you can read off
 * the workflow while tracing it. The prompt is renumbered before it is sent, so
 * the lookup goes through `_meta.source`, which is the editor id the renumbering
 * kept for exactly this.
 */
export const findNode = (prompt, sourceId) => {
  if (prompt[sourceId]?._meta?.source === sourceId) return prompt[sourceId];
  for (const node of Object.values(prompt)) {
    if (node?._meta?.source === sourceId) return node;
  }
  return prompt[sourceId] || null;
};

export const applyBinding = (prompt, binding, value) => {
  if (!binding || value === undefined || value === null || value === '') return false;
  const node = findNode(prompt, binding.node);
  if (!node) return false;
  node.inputs[binding.input] = value;
  /* `also` writes somewhere else as well, and it does one of two things.
   *
   * With a `value`, it is a gate: Krea 2 hides its LoRA loader behind a boolean
   * that choosing a LoRA has to switch on, and the boolean is `true` whatever
   * the LoRA is.
   *
   * Without one, it is the *same* value in a second place — which is what a
   * node that can read a setting from either of two places needs. Anima's
   * sampler takes its seed from its own widget or from the context depending
   * on a mode, so the seed is written to both and the mode stops mattering. */
  for (const extra of binding.also || []) {
    const switched = findNode(prompt, extra.node);
    if (!switched) continue;
    switched.inputs[extra.input] = 'value' in extra ? extra.value : value;
  }
  return true;
};

/** Every control a workflow actually offers, for the UI to render. */
export const controlsOf = (definition) => Object.keys(definition.controls || {});

/**
 * Take the workflow author's own picture out of the workflow.
 *
 * These files were exported from someone's ComfyUI mid-session, so they carry
 * whatever was in the boxes at the time: a Safebooru post's tags, a chain of
 * artist handles, a block of quality words, a style appended to every prompt.
 * Every one of those is a *default that draws something*, and none of it is
 * visible from the Studio -- the person typing a prompt sees an empty box and
 * gets the author's subject blended into their own.
 *
 * Emptying rather than deleting: the nodes stay wired, the graph stays exactly
 * as its author drew it, and re-exporting the workflow with different text is
 * still the way to change any of it. What changes is that an empty prompt box
 * now means an empty prompt.
 *
 * Runs before the user's values, so a control bound to one of these wins.
 * Returns the ones it could not find, which is how a binding left pointing at
 * a node an edited workflow no longer has says so instead of going quiet.
 */
export const clearAuthorContent = (prompt, definition) => {
  const missing = [];

  /* The prompt boxes, always, whatever the workflow.
   *
   * A rule rather than a list, because the list was wrong: three of these were
   * missed on the first pass and every one of them was invisible in exactly the
   * same way. The value only shows itself when the box is left empty -- type
   * something and it is replaced, so testing by typing a prompt proves nothing.
   * Krea 2 came with a whole character sheet in its positive box, MiniMax with
   * a named character and a reference-picture description, and Anima with three
   * hundred words of negative including `twintails`, `detailed background` and
   * `colorful` -- terms that quietly argue with whatever was asked for.
   *
   * Bound by role, so a workflow added tomorrow gets it without anyone
   * remembering to. Only the text roles: every other control points at a
   * number, a filename or an enum value, and "" is not a legal value for any
   * of them -- a blanked `sampler_name` is a graph ComfyUI refuses. */
  for (const role of ['positive', 'negative', 'artist']) {
    const binding = definition.controls?.[role];
    if (!binding) continue;
    const node = findNode(prompt, binding.node);
    if (node) node.inputs[binding.input] = '';
  }

  for (const entry of definition.blank || []) {
    const node = findNode(prompt, entry.node);
    if (!node) { missing.push(`${entry.node}.${entry.input}`); continue; }
    // Not `applyBinding`, which refuses an empty value -- emptying is the point.
    node.inputs[entry.input] = entry.value === undefined ? '' : entry.value;
  }
  return { missing };
};

/* ============================================================ stacking LoRAs

   Two workflows, two entirely different mechanisms, and the difference is not
   cosmetic — it is the difference between filling in a form and editing a
   graph.

   Anima loads its LoRAs through a `LoRA Stacker`, which is a node built for
   exactly this: nine slots, each a name, a weight and a toggle, plus a count of
   how many to read. Selecting six LoRAs there is six assignments.

   Krea 2 loads its one through a `LoraLoaderModelOnly`, which holds precisely
   one. A second LoRA is not a second value, it is a second *node* — LoRAs stack
   by chaining loaders model-to-model. So the loader is cloned, the clones are
   wired in a line, and whatever was reading the original's output is repointed
   at the end of that line.

   The repointing is the part that has to be done carefully and in the right
   order: collect the original's consumers *before* adding the clones, or the
   first clone — which reads the original — gets repointed to itself and the
   graph becomes a loop that ComfyUI refuses without ever saying why. */

const slotName = (pattern, index) => String(pattern).replace('%', String(index));

/** The prompt key of a node, given the editor id a binding names. */
const keyOf = (prompt, sourceId) => {
  for (const [key, node] of Object.entries(prompt)) {
    if (node?._meta?.source === sourceId) return key;
  }
  return prompt[sourceId] ? sourceId : null;
};

const nextKey = (prompt) => {
  let highest = 0;
  for (const key of Object.keys(prompt)) {
    const n = Number(key);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return String(highest + 1);
};

/**
 * Put a list of LoRAs into whichever mechanism this workflow has.
 *
 * `loras` is `[{ name, weight }]`, already in the order they should apply —
 * order matters to the result, so the list is taken as given rather than
 * sorted. Returns how many landed, so a workflow that quietly supports fewer
 * than were asked for can say so instead of dropping them in silence.
 */
export const applyLoras = (prompt, definition, loras = []) => {
  const spec = definition.loras;
  if (!spec) return { applied: 0, capacity: 0 };

  const chosen = (loras || [])
    .filter(entry => entry && entry.name)
    .slice(0, spec.max || 1)
    .map(entry => ({
      name: entry.name,
      weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1,
    }));

  const node = findNode(prompt, spec.node);
  if (!node) return { applied: 0, capacity: spec.max || 0 };

  /* ---- a stacker: nine slots already there ---- */
  if (spec.style === 'slots') {
    for (let i = 1; i <= spec.slots; i += 1) {
      const picked = chosen[i - 1];
      if (picked) {
        node.inputs[slotName(spec.name, i)] = picked.name;
        node.inputs[slotName(spec.weight, i)] = picked.weight;
      }
      // The toggle is what decides whether a slot is read, so every unused one
      // is switched off — otherwise the workflow author's own LoRAs stay on
      // underneath whatever was chosen here.
      if (spec.toggle) node.inputs[slotName(spec.toggle, i)] = !!picked;
      /* And emptied, not just switched off. A slot still naming
         `BlueArchiveStyleB1` is one toggle away from applying it, it is what
         the graph reports when anything asks what ran, and it is the reason
         "the workflow's own LoRAs are still in there" is a fair reading of a
         job that used none. `None` is the stacker's own word for an empty
         slot, not an invented one. */
      if (!picked) node.inputs[slotName(spec.name, i)] = 'None';
    }
    if (spec.count) node.inputs[spec.count] = Math.max(chosen.length, 1);
    if (chosen.length) for (const extra of spec.also || []) applyBinding(prompt, extra, extra.value);
    return { applied: chosen.length, capacity: spec.max, used: chosen };
  }

  /* ---- a chain: one loader, cloned ---- */
  if (spec.style === 'chain') {
    // Nothing chosen: leave the loader in place at zero strength rather than
    // ripping it out, which keeps the graph exactly as its author drew it.
    if (chosen.length === 0) {
      node.inputs[spec.weight] = 0;
      return { applied: 0, capacity: spec.max };
    }

    const baseKey = keyOf(prompt, spec.node);
    if (!baseKey) return { applied: 0, capacity: spec.max };

    node.inputs[spec.name] = chosen[0].name;
    node.inputs[spec.weight] = chosen[0].weight;

    // Before any clone exists, or the first clone gets repointed at itself.
    const consumers = [];
    for (const [key, other] of Object.entries(prompt)) {
      for (const [input, value] of Object.entries(other.inputs || {})) {
        if (Array.isArray(value) && value[0] === baseKey && value[1] === 0) {
          consumers.push({ key, input });
        }
      }
    }

    let previous = baseKey;
    for (let i = 1; i < chosen.length; i += 1) {
      const key = nextKey(prompt);
      prompt[key] = {
        class_type: node.class_type,
        inputs: {
          ...node.inputs,
          [spec.through]: [previous, 0],
          [spec.name]: chosen[i].name,
          [spec.weight]: chosen[i].weight,
        },
        _meta: { title: `${node._meta?.title || node.class_type} ${i + 1}`, source: `${spec.node}#${i}` },
      };
      previous = key;
    }

    if (previous !== baseKey) {
      for (const { key, input } of consumers) prompt[key].inputs[input] = [previous, 0];
    }
    for (const extra of spec.also || []) applyBinding(prompt, extra, extra.value);
    return { applied: chosen.length, capacity: spec.max, used: chosen };
  }

  return { applied: 0, capacity: spec.max || 0 };
};

/* ======================================================= editing a picture

   Two workflows, two mechanisms, and the same shape of difference as the LoRA
   stacker versus the LoRA chain: one has the wiring and one has to be given it.

   Anima's loader already takes an image and has a mode to switch between
   starting from noise and starting from that image, so nothing is added.

   Krea 2 samples from an `EmptyLatentImage`. Turning that into image-to-image
   means the two nodes that encode a picture into a latent — `LoadImage` and
   `VAEEncode` — plus repointing the sampler at them. Both classes are core
   ComfyUI, and the workflow already loads a VAE for the decode at the other
   end, so the encode borrows it rather than loading a second copy of the same
   file into VRAM.

   `denoise` is what "how much should it change" means to a sampler: 1.0 ignores
   the picture entirely and 0.0 returns it untouched. It is the one number that
   has to reach the sampler for any of this to be image-to-image rather than a
   slower way of drawing from scratch. */

/**
 * Point a workflow at a picture to work from.
 *
 * `image` is a filename in ComfyUI's own input folder — what `/studio/upload`
 * returns. Returns whether it landed, so a request to edit a picture with a
 * workflow that cannot is reported rather than quietly generating a fresh one,
 * which is the failure that looks like the feature working.
 */
export const applyImg2Img = (prompt, definition, { image, denoise, size } = {}) => {
  const spec = definition.img2img;
  if (!spec || !image) return { applied: false };

  const strength = Number.isFinite(Number(denoise)) ? Number(denoise) : 0.6;

  /* The size the job is being generated at, which is the size the reference
     has to arrive at.
     *
     * A picture from this app is not the picture the sampler made: it has been
     * through an upscaler and comes back four times larger. Feeding that back
     * in as a reference means a latent nine times the area, which on a 16GB
     * card is the difference between seventy seconds and filling VRAM and
     * grinding — measured, on the first version of this. */
  const width = Number(size?.width) || 0;
  const height = Number(size?.height) || 0;

  if (spec.style === 'native') {
    const target = findNode(prompt, spec.image.node);
    if (!target) return { applied: false, missing: spec.image.node };
    target.inputs[spec.image.input] = image;

    if (spec.resize && width && height) {
      const resizer = findNode(prompt, spec.resize.node);
      if (resizer) {
        resizer.inputs[spec.resize.width] = width;
        resizer.inputs[spec.resize.height] = height;
        // The loader ships set to "do not upscale", which means the size above
        // would be read and ignored.
        resizer.inputs[spec.resize.method.input] = spec.resize.method.value;
        resizer.inputs[spec.resize.fit.input] = spec.resize.fit.value;
      }
    }
    // The mode is what decides whether that picture is used at all. Without it
    // the file is loaded, ignored, and a brand new picture comes back.
    const mode = findNode(prompt, spec.mode.node);
    if (mode) mode.inputs[spec.mode.input] = spec.mode.value;
    const sampler = findNode(prompt, spec.denoise.node);
    if (sampler) sampler.inputs[spec.denoise.input] = strength;
    return { applied: true, denoise: strength };
  }

  if (spec.style === 'encode') {
    const samplerKey = keyOf(prompt, spec.latent.node);
    const vaeKey = keyOf(prompt, spec.vae.node);
    if (!samplerKey || !vaeKey) return { applied: false, missing: spec.latent.node };

    const loadKey = nextKey(prompt);
    prompt[loadKey] = {
      class_type: 'LoadImage',
      inputs: { image },
      _meta: { title: 'Reference', source: `${spec.latent.node}#load` },
    };

    // `LoadImage` has no size of its own, so the scale is its own node.
    let pixels = [loadKey, 0];
    const added = [loadKey];
    if (spec.resize && width && height) {
      const scaleKey = nextKey(prompt);
      prompt[scaleKey] = {
        class_type: 'ImageScale',
        inputs: {
          image: [loadKey, 0],
          upscale_method: 'lanczos',
          width,
          height,
          // Cropping rather than stretching: an edit that changes the aspect
          // ratio of what it was given is not an edit of that picture.
          crop: 'center',
        },
        _meta: { title: 'Reference size', source: `${spec.latent.node}#scale` },
      };
      pixels = [scaleKey, 0];
      added.push(scaleKey);
    }

    const encodeKey = nextKey(prompt);
    prompt[encodeKey] = {
      class_type: 'VAEEncode',
      inputs: { pixels, vae: [vaeKey, 0] },
      _meta: { title: 'Reference latent', source: `${spec.latent.node}#encode` },
    };
    added.push(encodeKey);

    prompt[samplerKey].inputs[spec.latent.input] = [encodeKey, 0];
    prompt[samplerKey].inputs[spec.denoise.input] = strength;
    return { applied: true, denoise: strength, added };
  }

  return { applied: false };
};

/* ======================================================= editing one part

   Reported as: asked to make the hair short, the hair came back short -- and
   the collar had changed shape, the buttons had moved to the skirt, the
   thigh-highs were socks and the shoes had turned pink. Nothing was wrong with
   the request or the model. An edit handed the sampler the whole picture at a
   denoise high enough to reshape hair, and at that strength everything else
   is reshaped too; there is no number that is high enough for the hair and
   low enough for the socks.

   So an edit that names a part redraws only that part:

     1. SAM3 finds it, from the word the model gave ("hair"), in the picture
        being edited. Grown a little and softened, because a mask cut exactly
        at the hairline leaves the old hair's outline standing.
     2. The sampler is told to move only inside it -- the Anima loader's own
        inpaint mode, or a noise mask on Krea's latent.
     3. And the finished picture is laid back over the original through the
        same mask, so everything outside is the original pixel for pixel. The
        sampler preserving the rest is nearly true; the upscaler afterwards
        re-invents fine detail everywhere, and "nearly" is what was reported.

   Needs SAM3Segment (ComfyUI-RMBG) and its model. Without them the edit is
   reported as a whole-picture one rather than failing -- see the caller. */

/** The parts to find, from the model's `region`: up to three nouns. */
export const regionTerms = (region) => String(region || '')
  .split(',')
  .map(term => term.trim())
  .filter(Boolean)
  .slice(0, 3);

/** The nodes a region edit is built from, when the region is found by SAM3. */
export const REGION_NODES = [
  'SAM3Segment', 'MaskComposite', 'GrowMask', 'SetLatentNoiseMask', 'LoadImage', 'ImageCompositeMasked',
];

/** And when it is handed in as a mask -- painted by the reader, or the new margin of an extended picture. */
export const MASK_NODES = ['LoadImageMask', 'GrowMask', 'SetLatentNoiseMask', 'LoadImage', 'ImageCompositeMasked'];

/* Found at the size being sampled, then grown and softened there. 24 pixels at
   ~1300 wide is about a strand of hair at the edge of a head: enough to take the
   old outline with it, not enough to reach the collar.

   Grown with ComfyUI's own GrowMask, never with SAM3Segment's `mask_offset`.
   That option runs a (2n+1)-wide max filter n times -- a dilation of n², not n
   -- and in Merged mode runs the whole thing twice. An offset of 24 turned a
   hair mask into a solid white rectangle: the "edit only the hair" run came back
   as an entirely new picture, which is how this was found.

   Its blur is not used either. Blurred before it is grown, the thin ends of
   long hair come out grey, and grey means "half the old picture": the second
   run had short hair and translucent ghosts of the long hair beside the hands.
   So the mask stays hard until it has been grown past the old outline, and
   only then is the edge softened, where everything it blends is background. */
const REGION_GROW = 24;
const REGION_SOFTEN = 4;

/**
 * Lay the finished picture back over the original, through a mask.
 *
 * Every save node's picture is the thing that gets composited, and everything
 * else that read that picture -- previews, a before/after comparer -- is
 * pointed at the composite too, so no output of the job shows the version
 * that was not kept. `resize_source` because the original is whatever was
 * handed in and the output is whatever the workflow produced; ComfyUI resizes
 * the mask to match on its own.
 */
export const compositeOnto = (prompt, { image, mask }) => {
  const finished = new Map();
  for (const node of Object.values(prompt)) {
    if (typeof node?.inputs?.[SAVE_INPUT] !== 'string') continue;
    for (const name of ['images', 'image', 'image_opt']) {
      const link = node.inputs[name];
      if (Array.isArray(link)) finished.set(`${link[0]}:${link[1]}`, link);
    }
  }
  if (!finished.size) return 0;

  // The reference is often loaded already, at full size, by the img2img wiring.
  let originalKey = Object.keys(prompt)
    .find(key => prompt[key].class_type === 'LoadImage' && prompt[key].inputs?.image === image);
  if (!originalKey) {
    originalKey = nextKey(prompt);
    prompt[originalKey] = {
      class_type: 'LoadImage',
      inputs: { image },
      _meta: { title: 'Original', source: 'region#original' },
    };
  }

  for (const link of finished.values()) {
    const key = nextKey(prompt);
    prompt[key] = {
      class_type: 'ImageCompositeMasked',
      inputs: { destination: [originalKey, 0], source: [link[0], link[1]], x: 0, y: 0, resize_source: true, mask },
      _meta: { title: 'Original, with the edit', source: 'region#composite' },
    };
    for (const [other, node] of Object.entries(prompt)) {
      if (other === key) continue;
      for (const [input, value] of Object.entries(node.inputs || {})) {
        if (Array.isArray(value) && value[0] === link[0] && value[1] === link[1]) node.inputs[input] = [key, 0];
      }
    }
  }
  return finished.size;
};

/**
 * Redraw only the named part of the picture an edit starts from.
 *
 * Runs after `applyImg2Img`, which has already put the picture in. `available`
 * is the set of node classes this ComfyUI has; a missing one is reported, not
 * guessed around. Returns what happened so the caller can say so.
 *
 * The region is either named -- `region: 'hair'`, found by SAM3 -- or given:
 * `maskImage` is a white-on-black picture in ComfyUI's input folder, the same
 * size as the original, white where it may change. That is how a painted edit
 * and an extended canvas arrive. `maskGrow` widens a given mask; a painted one
 * wants it, an extension builds its own edge and does not.
 */
export const applyRegionEdit = (prompt, definition, { image, region, maskImage, maskGrow = 0, available } = {}) => {
  const terms = maskImage ? [] : regionTerms(region);
  if (!terms.length && !maskImage) return { applied: false, reason: 'none' };
  const spec = definition.img2img?.inpaint;
  if (!spec) return { applied: false, reason: 'unsupported' };
  const needs = maskImage ? MASK_NODES : REGION_NODES;
  if (available && !needs.every(cls => available.has(cls))) {
    return { applied: false, reason: 'missing', missing: needs.filter(cls => !available.has(cls)) };
  }

  /* The pixels the part is looked for in: the picture as the sampler will see
     it, so the mask lines up with the latent without being resized. */
  let pixels = null;
  let samplerKey = null;
  if (spec.style === 'native') {
    const key = keyOf(prompt, spec.pixels.node);
    if (key) pixels = [key, spec.pixels.output];
  } else if (spec.style === 'noiseMask') {
    samplerKey = keyOf(prompt, definition.img2img.latent.node);
    const encode = Object.values(prompt).find(n => n?._meta?.source === `${definition.img2img.latent.node}#encode`);
    pixels = encode?.inputs?.pixels || null;
    /* Stretched rather than cropped when the reference has to change size.
       The finished picture is laid back over the whole original, and a
       centre crop would put it back in the wrong place. */
    const scale = Object.values(prompt).find(n => n?._meta?.source === `${definition.img2img.latent.node}#scale`);
    if (scale) scale.inputs.crop = 'disabled';
  }
  if (!pixels) return { applied: false, reason: 'unsupported' };

  const mask = maskImage
    ? givenMask(prompt, { maskImage, grow: maskGrow, available })
    : foundMask(prompt, { terms, pixels, available });
  return finishRegionEdit(prompt, definition, { spec, samplerKey, image, mask, terms });
};

/** A mask somebody made, loaded, and widened if asked. */
const givenMask = (prompt, { maskImage, grow, available }) => {
  const loadKey = nextKey(prompt);
  prompt[loadKey] = {
    class_type: 'LoadImageMask',
    inputs: { image: maskImage, channel: 'red' },
    _meta: { title: 'Region, as given', source: 'region#given' },
  };
  let mask = [loadKey, 0];
  const expand = Math.max(0, Math.round(Number(grow) || 0));
  if (expand > 0) {
    const key = nextKey(prompt);
    prompt[key] = available?.has('GrowMaskWithBlur')
      ? {
        class_type: 'GrowMaskWithBlur',
        inputs: {
          mask, expand, incremental_expandrate: 0, tapered_corners: true, flip_input: false,
          blur_radius: Math.max(2, Math.round(expand / 2)), lerp_alpha: 1, decay_factor: 1, fill_holes: false,
        },
        _meta: { title: 'Region, with its edge', source: 'region#grow' },
      }
      : {
        class_type: 'GrowMask',
        inputs: { mask, expand, tapered_corners: true },
        _meta: { title: 'Region, with its edge', source: 'region#grow' },
      };
    mask = [key, 0];
  }
  return mask;
};

/** A mask SAM3 finds from the words, grown past the old outline and softened. */
const foundMask = (prompt, { terms, pixels, available }) => {
  const masks = terms.map(term => {
    const key = nextKey(prompt);
    prompt[key] = {
      class_type: 'SAM3Segment',
      inputs: {
        image: pixels,
        prompt: term,
        output_mode: 'Merged',
        confidence_threshold: 0.4,
        max_segments: 0,
        segment_pick: 0,
        mask_blur: 0,
        mask_offset: 0,
        device: 'Auto',
        invert_output: false,
        // Three and a half gigabytes that the sampler after it needs more.
        unload_model: true,
        background: 'Alpha',
        background_color: '#222222',
      },
      _meta: { title: `Region: ${term}`, source: `region#${term}` },
    };
    return [key, 1];
  });

  // `add` rather than `or`: `or` rounds the mask, which throws the softening away.
  let mask = masks[0];
  for (const next of masks.slice(1)) {
    const key = nextKey(prompt);
    prompt[key] = {
      class_type: 'MaskComposite',
      inputs: { destination: mask, source: next, x: 0, y: 0, operation: 'add' },
      _meta: { title: 'Region', source: 'region#union' },
    };
    mask = [key, 0];
  }
  {
    /* Grown, then softened at the new edge. KJNodes does both in one node; a
       ComfyUI without it gets the grow alone, which is a harder seam but no
       ghosts. */
    const key = nextKey(prompt);
    prompt[key] = available?.has('GrowMaskWithBlur')
      ? {
        class_type: 'GrowMaskWithBlur',
        inputs: {
          mask, expand: REGION_GROW, incremental_expandrate: 0, tapered_corners: true, flip_input: false,
          blur_radius: REGION_SOFTEN, lerp_alpha: 1, decay_factor: 1, fill_holes: false,
        },
        _meta: { title: 'Region, with its edge', source: 'region#grow' },
      }
      : {
        class_type: 'GrowMask',
        inputs: { mask, expand: REGION_GROW, tapered_corners: true },
        _meta: { title: 'Region, with its edge', source: 'region#grow' },
      };
    mask = [key, 0];
  }
  return mask;
};

/** Sample only inside the mask, and put the original back outside it. */
const finishRegionEdit = (prompt, definition, { spec, samplerKey, image, mask, terms }) => {
  if (spec.style === 'native') {
    const loader = findNode(prompt, spec.mode.node);
    const target = findNode(prompt, spec.mask.node);
    if (!loader || !target) return { applied: false, reason: 'unsupported' };
    loader.inputs[spec.mode.input] = spec.mode.value;
    target.inputs[spec.mask.input] = mask;
  } else {
    const sampler = samplerKey && prompt[samplerKey];
    const latentInput = definition.img2img.latent.input;
    if (!sampler || !Array.isArray(sampler.inputs[latentInput])) return { applied: false, reason: 'unsupported' };
    const key = nextKey(prompt);
    prompt[key] = {
      class_type: 'SetLatentNoiseMask',
      inputs: { samples: sampler.inputs[latentInput], mask },
      _meta: { title: 'Only the region', source: 'region#noise-mask' },
    };
    sampler.inputs[latentInput] = [key, 0];
  }

  const composited = compositeOnto(prompt, { image, mask });
  return { applied: true, terms, composited };
};

/* Nodes that write a file, whatever pack they came from. Matched by having a
 * `filename_prefix` rather than by class name, because every save node in every
 * pack has one and no two of them are called the same thing. */
const SAVE_INPUT = 'filename_prefix';

/**
 * Give one run its own name, and take back the results with it.
 *
 * Two problems, one fix. ComfyUI caches by node inputs, so running the same
 * graph twice re-uses the cached save node — and a cached output node does not
 * re-report itself, so the second run comes back with no outputs at all and
 * looks like a failure while quietly having worked. And a workflow's own prefix
 * scatters results into whatever folder its author liked, which is a poor place
 * to look for the picture this app just made.
 *
 * Stamping the prefix per job makes each run distinct — so it always executes
 * and always reports — and puts everything under one folder.
 */
export const stampOutputs = (prompt, stamp) => {
  const touched = [];
  for (const [id, node] of Object.entries(prompt)) {
    if (typeof node.inputs?.[SAVE_INPUT] !== 'string') continue;
    node.inputs[SAVE_INPUT] = `webui/${stamp}`;
    touched.push(id);
  }
  return touched;
};

/**
 * Apply a whole job to a prompt.
 *
 * Only what the caller set and only what the workflow has: a job that names a
 * negative prompt for a workflow with no negative conditioning is not an error,
 * it is a field that workflow does not have.
 */
export const applyJob = (prompt, definition, job = {}) => {
  const controls = definition.controls || {};
  const applied = [];
  const skipped = [];

  for (const [name, binding] of Object.entries(controls)) {
    if (!(name in job)) continue;
    if (applyBinding(prompt, binding, job[name])) applied.push(name);
    else skipped.push(name);
  }
  return { applied, skipped };
};

/* The settings worth showing beside a result, in the order they are read. The
   control is called `model` because that is the input it fills; beside a
   result it is reported as `checkpoint`, since the result's own `model` is the
   workflow that made it. */
const SETTINGS = [
  ['width', 'width'], ['height', 'height'], ['seed', 'seed'], ['steps', 'steps'], ['cfg', 'cfg'],
  ['sampler', 'sampler'], ['scheduler', 'scheduler'], ['model', 'checkpoint'], ['vae', 'vae'],
  ['clip', 'clip'], ['duration', 'duration'], ['fps', 'fps'],
];

/**
 * What a finished graph will actually run with, read back out of it.
 *
 * Read from the graph rather than from the request, because the request only
 * carries what somebody chose: a sampler nobody picked is still a sampler, it
 * is whatever the workflow's author left in the box, and "the settings of this
 * picture" that leave it out are not its settings. Values that are wires to
 * another node are not settings anyone can read, and are left out.
 *
 * A control behind a gate -- MiniMax's width and height, which the graph only
 * consults when its CustomRes switch is on -- is reported only when this job
 * set it, because otherwise the number in the box is not the one it used.
 */
export const readSettings = (prompt, definition, { applied = [] } = {}) => {
  const controls = definition.controls || {};
  const out = {};
  for (const [control, label] of SETTINGS) {
    const binding = controls[control];
    if (!binding) continue;
    const gated = (binding.also || []).some(extra => 'value' in extra);
    if (gated && !applied.includes(control)) continue;
    const value = findNode(prompt, binding.node)?.inputs?.[binding.input];
    if (value === undefined || value === null || value === '' || typeof value === 'object') continue;
    out[label] = value;
  }
  return out;
};

/** The strength an edit ran at, read from the graph; undefined when it has none. */
export const readDenoise = (prompt, definition) => {
  const binding = definition.img2img?.denoise;
  const value = binding ? findNode(prompt, binding.node)?.inputs?.[binding.input] : undefined;
  return typeof value === 'number' ? value : undefined;
};
