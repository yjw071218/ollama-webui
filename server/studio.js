/**
 * Making pictures and video, through ComfyUI.
 *
 * ## Why a sidecar and not "built in"
 *
 * Krea 2 is a 12.9-billion-parameter diffusion transformer; MiniMax H3 is a
 * video model that wants a data-centre card. Neither is a thing that can live
 * inside a Vite bundle, and the runtime they need — PyTorch, CUDA, a scheduler,
 * a VAE, a text encoder each — is not a dependency a Node server can acquire.
 *
 * This app already had the answer to that shape of problem twice over. Speech
 * synthesis runs as its own process on port 9880 and speech recognition on
 * 8000, and the server proxies `/tts-api` and `/stt-api` through to them so the
 * browser never has to cross an origin. Image and video generation is the third
 * instance of exactly that pattern, and ComfyUI is the process: all three models
 * have native support in it, so adding a fourth is a workflow file rather than
 * a code change.
 *
 * ## What a workflow is here
 *
 * ComfyUI's API takes a graph — nodes keyed by id, each with `class_type` and
 * `inputs`, where an input is either a literal or `[nodeId, outputIndex]`. It
 * does not take "a prompt and a model name". So each model gets a builder
 * below that returns the whole graph with the prompt and the numbers filled in.
 *
 * The graphs are deliberately written out in full rather than loaded from files
 * the user is expected to install. A workflow that lives in the repo is one that
 * can be read, diffed and tested; a workflow that lives in ComfyUI's directory
 * is one that silently differs from machine to machine.
 *
 * ## The queue
 *
 * `POST /prompt` queues and returns a `prompt_id`. Progress arrives on a
 * websocket, and the result has to be fetched from `/history/<id>` and then
 * `/view`. That is three round trips and a socket for what the UI wants to be
 * one call, so this module does the waiting and the browser polls one endpoint.
 * Polling rather than a second websocket because a generation is measured in
 * tens of seconds and a one-second poll is free at that scale.
 */

import {
  WORKFLOWS, buildPrompt, applyJob, applyLoras, applyImg2Img, stampOutputs, clearAuthorContent,
  applyRegionEdit, regionTerms, REGION_NODES, MASK_NODES, readSettings, readDenoise,
} from './workflows.js';
import { shapeAnimaPrompt } from './animaPrompt.js';
import { removeBackgroundGraph, upscaleGraph, tagGraph, textsOf } from './imageOps.js';
import { toEditorWorkflow } from './comfyGraph.js';
import { createComfyEvents, fractionOf } from './comfyEvents.js';
import { loadTags, searchTags, parseBooruUrl, apiUrlFor, tagsFromPost, firstPost } from './booruTags.js';
import { vramGuard } from './vram.js';

export const comfyBase = (env = {}) =>
  (env.COMFYUI_URL || `http://${env.COMFYUI_HOST || '127.0.0.1'}:${env.COMFYUI_PORT || 8188}`).replace(/\/$/, '');

/* ----------------------------------------------------------- the catalogue

   Three workflows, exported from ComfyUI and kept in `workflows/`. What this
   file knows about them is where their interesting inputs live; see
   server/workflows.js for the bindings and why they are written out rather
   than detected. */

export const MODELS = WORKFLOWS;

/** What ComfyUI has on disk, by kind: checkpoints, loras, vae, and so on. */
export const listInstalled = async (base, fetchJson) => {
  const info = await fetchJson(`${base}/object_info`);
  const optionsFor = (cls, input) => {
    const decl = info?.[cls]?.input?.required?.[input] || info?.[cls]?.input?.optional?.[input];
    const options = Array.isArray(decl) ? decl[0] : null;
    return Array.isArray(options) ? options : [];
  };
  return {
    objectInfo: info,
    checkpoints: optionsFor('CheckpointLoaderSimple', 'ckpt_name'),
    diffusion_models: optionsFor('UNETLoader', 'unet_name'),
    vae: optionsFor('VAELoader', 'vae_name'),
    loras: optionsFor('LoraLoaderModelOnly', 'lora_name'),
    text_encoders: optionsFor('CLIPLoader', 'clip_name'),
    // The sampler and scheduler lists come from KSampler rather than being
    // hardcoded, so a custom sampler pack shows up without a code change.
    samplers: optionsFor('KSampler', 'sampler_name'),
    schedulers: optionsFor('KSampler', 'scheduler'),
  };
};

/**
 * One workflow, described for the interface.
 *
 * The form is rendered from this, so it carries only what the workflow actually
 * has: a negative prompt box appears for Anima and not for Krea 2 Turbo,
 * because Krea 2 Turbo genuinely has no negative conditioning to write into.
 */
export const describe = (definition, installed = null) => {
  const controls = definition.controls || {};
  const kindOf = (name) => controls[name]?.kind || null;
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    note: definition.note || '',
    licence: definition.licence || '',
    has: {
      ...Object.fromEntries(Object.keys(controls).map(name => [name, true])),
      // LoRAs are not an ordinary control — they are a list, and how long a
      // list depends on what the workflow loads them through.
      ...(definition.loras ? { lora: true } : {}),
      /* Editing a picture rather than starting from noise. Not an ordinary
         control either: for one workflow it is a mode to flip and for the
         other it is two nodes to add. `denoise` rides with it, because a
         reference image with no way to say how much to change is a control
         that either ignores the picture or returns it untouched. */
      ...(definition.img2img ? { referenceImage: true, denoise: true } : {}),
    },
    /* How many LoRAs this workflow can stack. Anima's stacker takes nine
       without changing anything; Krea 2's single loader is cloned and chained,
       which is why it has a ceiling at all. */
    loraSlots: definition.loras?.max || 0,
    /* Why the ones it does not have are absent.
     *
     * The Studio greys those controls and puts the reason beside them instead
     * of leaving them out. A control that is simply missing reads as a feature
     * nobody built — which is exactly what happened with Krea 2 Turbo's
     * negative prompt, and the honest answer there is "this model is
     * guidance-distilled and a negative prompt would do nothing", not silence. */
    missing: definition.missing || {},
    defaults: definition.defaults || {},
    ranges: definition.ranges || {},
    // Which list each picker should offer, and what is currently in it.
    choices: installed ? {
      model: installed[kindOf('model')] || [],
      vae: installed[kindOf('vae')] || [],
      clip: installed[kindOf('clip')] || [],
      lora: installed[definition.loras?.kind || 'loras'] || [],
      sampler: installed.samplers || [],
      scheduler: installed.schedulers || [],
    } : null,
  };
};

/** The catalogue with no ComfyUI to ask, so the panel can say what exists. */
export const modelList = () => Object.values(WORKFLOWS).map(d => describe(d));

/* ------------------------------------------------------------- the numbers */

export const parseSize = (size, fallback = '1024x1024') => {
  const match = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(String(size || '').trim());
  const [, w, h] = match || /^(\d{2,5})x(\d{2,5})$/.exec(fallback);
  // Rounded to a multiple of 8: every VAE here downsamples by that factor, and
  // a width of 1023 is not a smaller image, it is a tensor error.
  return { width: Math.round(Number(w) / 8) * 8, height: Math.round(Number(h) / 8) * 8 };
};

/** A seed that is a number, and a different one each time when none was given. */
export const resolveSeed = (seed) => {
  const n = Number(seed);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  // ComfyUI's seeds are 64-bit but JavaScript's integers are not, so this stays
  // inside the range where a round trip through JSON is lossless.
  return Math.floor(Math.random() * 2 ** 47);
};

const clampTo = (value, range) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !range) return Number.isFinite(n) ? n : undefined;
  return Math.min(Math.max(n, range[0]), range[1]);
};

/**
 * A job from the browser, as values the workflow can take.
 *
 * Resolution is free-form rather than a list of presets — any width and height,
 * rounded to the multiple of eight the latents need. The rest is clamped where
 * the workflow declares a range and passed through where it does not, because a
 * sampler this app has never heard of is a sampler ComfyUI may well have.
 */
export const prepareJob = (definition, job = {}) => {
  const controls = definition.controls || {};
  const defaults = definition.defaults || {};
  const ranges = definition.ranges || {};
  const size = parseSize(job.size, `${defaults.width || 1024}x${defaults.height || 1024}`);

  const out = {};
  const take = (name, value) => {
    if (!controls[name]) return;                 // this workflow has no such input
    if (value === undefined || value === null || value === '') return;
    out[name] = value;
  };

  take('positive', job.prompt);
  take('negative', job.negative);
  /* Only where the workflow has somewhere to put it. `take` already refuses a
     control this workflow does not declare, so a workflow without an artist
     input silently ignores this -- and the panel folds the artists into the
     prompt instead, which is what naming an artist means when there is no
     dedicated encoder for it. */
  take('artist', job.artist);
  take('width', size.width);
  take('height', size.height);
  take('batch', Math.min(Math.max(Number(job.batch) || 1, 1), 4));
  take('seed', resolveSeed(job.seed));
  take('steps', clampTo(job.steps ?? defaults.steps, ranges.steps));
  take('cfg', clampTo(job.cfg ?? defaults.cfg, ranges.cfg));
  take('sampler', job.sampler);
  take('scheduler', job.scheduler);
  // `job.model` is the *workflow* — "krea2-turbo". The checkpoint the picker
  // chose travels as `modelFile`, because writing "krea2-turbo" into a
  // `ckpt_name` would be a filename that does not exist and a failure forty
  // seconds later.
  take('model', job.modelFile);
  take('vae', job.vae);
  take('clip', job.clip);
  take('duration', clampTo(job.duration ?? defaults.duration, ranges.duration));
  take('fps', job.fps ?? defaults.fps);
  take('referenceImage', job.referenceImage);

  return out;
};

/* --------------------------------------------------------------- the results

   ComfyUI's history entry is `outputs[nodeId][kind][]`, where kind is `images`
   or `gifs` depending on which save node ran, and each entry is
   `{filename, subfolder, type}` — the three things `/view` needs. Every kind is
   gathered because a graph does not know which of them it ended up producing,
   and a video that came back under `images` would otherwise be invisible. */

export const outputsOf = (entry) => {
  const found = [];
  for (const [nodeId, output] of Object.entries(entry?.outputs || {})) {
    for (const kind of ['images', 'gifs', 'videos', 'audio']) {
      for (const item of output?.[kind] || []) {
        const filename = item?.filename || item?.value?.filename;
        if (!filename) continue;
        found.push({
          node: nodeId,
          filename,
          subfolder: item.subfolder || item?.value?.subfolder || '',
          type: item.type || item?.value?.type || 'output',
          // What the browser should render it in. Decided by extension rather
          // than by which key it arrived under, because the keys lie: ComfyUI
          // files webm under `gifs`.
          media: /\.(webm|mp4|mov|gif)$/i.test(filename) ? 'video'
            : /\.(flac|wav|mp3|ogg)$/i.test(filename) ? 'audio' : 'image',
        });
      }
    }
  }
  // A preview and a save of the same picture are one result, not two.
  const seen = new Set();
  return found.filter(item => {
    const key = `${item.subfolder}/${item.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The `/view` query for one output, so the browser can ask for the bytes. */
export const viewQuery = (item) => new URLSearchParams({
  filename: item.filename,
  subfolder: item.subfolder || '',
  type: item.type || 'output',
}).toString();

/**
 * How far along a queued job is.
 *
 * ComfyUI reports the queue as two lists — running and pending — and says
 * nothing at all about a job that has finished, which is indistinguishable from
 * a job it never heard of. So "not in the queue" is only reported as done once
 * the history has the id, and as lost otherwise.
 */
export const queuePosition = (queue, promptId) => {
  const running = (queue?.queue_running || []).findIndex(item => item?.[1] === promptId);
  if (running !== -1) return { state: 'running', ahead: 0 };
  const pending = (queue?.queue_pending || []).findIndex(item => item?.[1] === promptId);
  if (pending !== -1) return { state: 'queued', ahead: pending + (queue?.queue_running?.length || 0) };
  return { state: 'gone', ahead: 0 };
};

/* ============================================================== the routes

   Four of them, and the shape is chosen around what a generation actually is:
   a job that takes tens of seconds, that the browser must be able to watch, and
   whose result is a file rather than JSON.

     POST /studio/models     what can be generated with, and within what limits
     POST /studio/generate   queue one job, get an id back straight away
     GET  /studio/job        where that id has got to, and its outputs when done
     GET  /studio/view       the bytes of one output, proxied

   `/studio/view` is a proxy rather than a redirect on purpose. ComfyUI is on
   another port, so a redirect would send the browser across an origin — which
   means CORS on an image tag, and mixed content the moment this app is served
   over HTTPS to a phone. Every other sidecar in this server is proxied for the
   same reason. */

/* What has already been queued, by the request that queued it.
 *
 * A generation is not something to do twice by accident: it is two minutes of
 * a GPU and a second picture nobody asked for, sitting in the queue behind the
 * one they did. And a request can arrive twice without anyone pressing
 * anything twice — a browser retries a POST by itself when the connection it
 * reused turns out to have been closed, and it retries it *after* the server
 * has read it.
 *
 * So each submission carries an id of its own making, and a repeat of an id
 * already seen is answered with what the first one was told rather than queued
 * again. Kept for five minutes, which is longer than any retry and shorter
 * than any deliberate second press.
 */
const RECENT_SUBMITS = new Map();
const SUBMIT_MEMORY_MS = 5 * 60 * 1000;

const rememberSubmit = (key, payload) => {
  if (!key) return;
  const now = Date.now();
  for (const [id, entry] of RECENT_SUBMITS) {
    if (now - entry.at > SUBMIT_MEMORY_MS) RECENT_SUBMITS.delete(id);
  }
  RECENT_SUBMITS.set(key, { at: now, payload });
};

export const recallSubmit = (key) => {
  const entry = key ? RECENT_SUBMITS.get(key) : null;
  if (!entry) return null;
  if (Date.now() - entry.at > SUBMIT_MEMORY_MS) { RECENT_SUBMITS.delete(key); return null; }
  return entry.payload;
};

/** For the tests, and for a server that has been running for a week. */
export const forgetSubmits = () => RECENT_SUBMITS.clear();

const sendJson = (res, payload, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readBody = (req, limit = 4 * 1024 * 1024) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > limit) reject(new Error('Request too large'));
  });
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
  });
  req.on('error', reject);
});

const withTimeout = async (url, { method = 'GET', body, timeout = 30000, raw = false } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return res;
    if (!res.ok) throw new Error(`ComfyUI HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
};

/** What to say when ComfyUI is simply not there, which is the common case. */
const offline = (base, error) => ({
  success: false,
  offline: true,
  error: `No ComfyUI at ${base}. Start it with \`python main.py --listen 127.0.0.1 --port 8188\`, `
    + `or point COMFYUI_URL at where it is running. (${String(error?.message || error)})`,
});

/**
 * One `Range: bytes=…` header, against a body of `size` bytes.
 *
 * `null` for no range (or one this does not handle, like several at once --
 * the whole body is a correct answer to those), `false` for one that cannot be
 * satisfied, and `{ start, end }` inclusive otherwise. Covers the three forms
 * a browser sends: `a-b`, `a-` and the suffix `-n`.
 */
export const rangeOf = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!suffix) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || end < start) return false;
  return { start, end };
};

/* The name this app queues under.
 *
 * ComfyUI broadcasts a job's progress to the client id that submitted it, so
 * this string is what connects `POST /prompt` to the websocket that reports on
 * it. Two constants that had to match would eventually stop matching. */
const CLIENT_ID = 'ollama-webui';

export const createStudioRoutes = (env = {}) => {
  const base = comfyBase(env);
  const routes = [];
  const route = (path, handler) => routes.push({ path, handler });

  /* Opened on the first job, not now: an app whose owner never opens the
     Studio should not hold a socket open to a ComfyUI that may not be
     running. */
  const events = createComfyEvents({ base, clientId: CLIENT_ID });

  // Who has the graphics card. See server/vram.js.
  const vram = vramGuard(env);

  /* `auto`, `latent2rgb`, `taesd`, or `none` to turn previews off — for a
     machine where every megabyte of VRAM is spoken for and a preview decoder
     is one too many. */
  const previewMethod = String(env.COMFYUI_PREVIEW || 'auto').trim() || 'auto';

  /* What can be generated with.

     Reports whether ComfyUI is reachable *and* which checkpoints it actually
     has, because "the model is missing" and "the server is down" are different
     problems with different fixes, and a form that offers a model which is not
     installed produces a failure forty seconds into a job instead of before
     it. */
  route('/studio/models', async (req, res) => {
    let installed = null;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return sendJson(res, { ...offline(base, e), models: modelList() });
    }

    /* Every workflow, with the lists its pickers should offer.
     *
     * The choices come from this ComfyUI rather than from a table here, so a
     * checkpoint added yesterday is selectable today and a sampler from a
     * custom pack appears without a code change. */
    sendJson(res, {
      success: true,
      base,
      models: Object.values(WORKFLOWS).map(definition => describe(definition, installed)),
    });
  });

  /* Queue one job.

     Returns as soon as ComfyUI has accepted it. A generation outlives any
     sensible request timeout, and holding the socket open for it would mean a
     phone that locks its screen loses the picture it is waiting for. */
  route('/studio/generate', async (req, res) => {
    let job;
    try { job = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    if (!String(job.prompt || '').trim()) {
      return sendJson(res, { success: false, error: 'A prompt is required' }, 400);
    }

    /* Already queued by this very request -- see RECENT_SUBMITS. Answered with
       the id it was given the first time, so the browser tracks the one job
       that exists rather than being told about a second one that does not. */
    const already = recallSubmit(job.requestId);
    if (already) return sendJson(res, { ...already, repeated: true });

    const definition = WORKFLOWS[job.model];
    if (!definition) return sendJson(res, { success: false, error: `Unknown model: ${job.model}` }, 400);

    /* The workflow, converted here rather than shipped pre-converted.
     *
     * `/object_info` is required for the conversion at all — widget order lives
     * there and nowhere else — so it has to be fetched anyway, and converting
     * against the ComfyUI that is about to run the graph is the only way the
     * two agree. It also means editing a workflow in ComfyUI and saving over
     * the file takes effect immediately. */
    let installed;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return sendJson(res, offline(base, e), 502);
    }

    let graph;
    let properties = {};
    let warnings = [];
    try {
      const built = buildPrompt(definition, installed.objectInfo);
      graph = built.prompt;
      properties = built.properties;
      warnings = built.warnings;
    } catch (e) {
      return sendJson(res, { success: false, error: `Could not read ${definition.file}: ${e.message}` }, 500);
    }

    /* One name per run. See stampOutputs: without it a repeated graph is
       served from ComfyUI's cache, and a cached save node does not report
       itself — so the second identical generation comes back with no outputs
       and reads as a failure while having quietly worked. */
    stampOutputs(graph, Date.now().toString(36));

    /* Before anything of the user's goes in. These workflows were exported
       with their author's own prompt, artists and LoRAs still in the boxes,
       and every one of them draws something. */
    const cleared = clearAuthorContent(graph, definition);
    if (cleared.missing.length) {
      warnings.push(`${definition.label} no longer has: ${cleared.missing.join(', ')}`);
    }

    /* A prompt from a conversation, for Anima, as tags and a sentence. Only when
       asked: the Studio's own prompt box is somebody writing tags on purpose,
       with autocomplete, and rearranging what they typed would be rude. See
       server/animaPrompt.js. */
    let shaped = null;
    if (job.shapeTags && definition.id === 'anima-base') {
      const index = loadTags();
      if (index.size) {
        shaped = shapeAnimaPrompt(job.prompt, index);
        job.prompt = shaped.prompt;
      }
    }

    const seed = resolveSeed(job.seed);
    const values = prepareJob(definition, { ...job, seed });
    const { applied, skipped } = applyJob(graph, definition, values);

    /* LoRAs are applied apart from the rest because they are a list rather than
       a value, and because one of the two mechanisms adds nodes to the graph
       rather than filling in an input. */
    /* A picture to work from, where the workflow can take one. Applied after
       the values so the denoise it sets is not overwritten by a default, and
       before the queue so a request that could not be honoured is reported
       rather than quietly becoming a fresh generation. */
    /* Whether an edit that names a part can redraw only that part here. Decided
       before the picture goes in, because it decides how hard to push: with a
       region the rest is protected and the part can be redrawn outright; without
       one, the same strength would redraw the whole picture into another one. */
    const available = new Set(Object.keys(installed.objectInfo || {}));
    const maskImage = typeof job.maskImage === 'string' && job.maskImage.trim() ? job.maskImage.trim() : '';
    const regionWanted = !!(job.referenceImage && (maskImage || regionTerms(job.region).length));
    const regionPossible = regionWanted && !!definition.img2img?.inpaint
      && (maskImage ? MASK_NODES : REGION_NODES).every(cls => available.has(cls));
    const denoise = regionWanted && !regionPossible && Number.isFinite(Number(job.denoise))
      ? Math.min(Number(job.denoise), 0.8)
      : job.denoise;

    const edited = applyImg2Img(graph, definition, {
      image: job.referenceImage,
      denoise,
      // The size the job is being made at, so the reference arrives at it too.
      size: parseSize(job.size, `${definition.defaults?.width || 1024}x${definition.defaults?.height || 1024}`),
    });
    if (job.referenceImage && !definition.img2img && !definition.controls?.referenceImage) {
      warnings.push(`${definition.label} cannot work from an existing picture; it was ignored.`);
    }
    if (job.referenceImage && definition.img2img && !edited.applied) {
      warnings.push(`${definition.label} could not take the reference picture.`);
    }
    if (regionWanted && edited.applied) {
      const region = applyRegionEdit(graph, definition, {
        image: job.referenceImage,
        region: job.region,
        maskImage,
        maskGrow: Number(job.maskGrow) || 0,
        available,
      });
      if (!region.applied) {
        const what = maskImage ? 'the marked area' : `the ${regionTerms(job.region).join(', ')}`;
        warnings.push(region.reason === 'missing'
          ? `Redrawing only ${what} needs ${region.missing.join(', ')} in ComfyUI `
            + `${maskImage ? '' : '(ComfyUI-RMBG for SAM3Segment)'}; the whole picture was edited instead.`
          : `${definition.label} cannot redraw one part of a picture; the whole picture was edited instead.`);
      }
    }

    const stacked = applyLoras(graph, definition, job.loras);
    if ((job.loras || []).length > stacked.capacity) {
      warnings.push(`${definition.label} stacks ${stacked.capacity} LoRAs; the rest were left out.`);
    }
    if (skipped.length) {
      // A binding that points at a node the workflow no longer has. Reported
      // rather than swallowed: the control was on screen and did nothing.
      warnings.push(`${definition.label} has no node for: ${skipped.join(', ')}`);
    }

    /* What this result is made with, for the settings beside it in a chat.
       Read off the finished graph, so it includes what nobody chose -- the
       workflow's own sampler, its own checkpoint -- and says the seed, size and
       strength it actually ran at rather than the ones that were asked for. */
    const denoiseUsed = edited.applied ? readDenoise(graph, definition) : undefined;
    const settings = {
      workflow: definition.label,
      ...readSettings(graph, definition, { applied }),
      ...(denoiseUsed !== undefined ? { denoise: denoiseUsed } : {}),
      ...(stacked.used?.length ? { loras: stacked.used } : {}),
      ...(job.referenceImage ? { reference: true } : {}),
      ...(regionWanted && edited.applied ? { region: maskImage ? 'mask' : regionTerms(job.region).join(', ') } : {}),
    };

    /* The language model off the card first, and waited for. Here, after
       everything that could refuse the job, so a request that was never going
       to run does not cost the chat a reload. */
    const unloaded = await vram.releaseLlm();

    try {
      const queued = await withTimeout(`${base}/prompt`, {
        method: 'POST',
        /* The workflow goes with it. Not for the record — for the nodes that
           read their own right-click settings back out of it while running, and
           in one case crash rather than fall back when it is not there. See
           `toEditorWorkflow`. Built here rather than in `buildPrompt` because
           stacking LoRAs adds nodes, and a node the workflow does not mention is
           exactly the case that breaks. */
        body: {
          prompt: graph,
          client_id: CLIENT_ID,
          extra_data: {
            extra_pnginfo: { workflow: toEditorWorkflow(graph, properties) },
            /* Turn the half-denoised previews on, for this prompt.
             *
             * ComfyUI ships with `--preview-method none`, so out of the box it
             * broadcasts progress numbers and no picture — and a launcher that
             * would have to be edited is a fix most people never apply.
             * `extra_data.preview_method` is read per prompt
             * (`execution.py`: `set_preview_method(extra_data.get(...))`), so
             * this asks for it on the request instead of asking the reader to
             * restart anything.
             *
             * `auto` resolves to latent2rgb: a matrix multiply on the latent
             * with no extra model to download, and it made no difference to the
             * generation times measured against this install. A value an older
             * ComfyUI does not recognise falls back to whatever it was started
             * with, so sending it is safe there too. */
            preview_method: previewMethod,
          },
        },
        timeout: 30000,
      });
      if (!queued?.prompt_id) {
        // ComfyUI reports a bad graph as `error` plus `node_errors`, and the
        // node errors are the half that says which input it disliked.
        const detail = queued?.error?.message || queued?.error || 'ComfyUI refused the workflow';
        const nodes = Object.entries(queued?.node_errors || {})
          .map(([id, err]) => `${id}: ${err?.errors?.[0]?.message || 'invalid'}`)
          .join('; ');
        return sendJson(res, { success: false, error: nodes ? `${detail} (${nodes})` : String(detail) }, 400);
      }
      /* What the websocket will need to make sense of what it hears.
         `executing` names a node by id and nothing else; the class name that
         turns `28` into "upscaling" is only knowable here, where the graph
         is. */
      events.register(queued.prompt_id, {
        total: Object.keys(graph).length,
        nodes: Object.fromEntries(Object.entries(graph)
          .map(([id, node]) => [id, { class: node.class_type, title: node._meta?.title || '' }])),
      });

      // Its models stay loaded after it finishes, until the next chat asks.
      vram.comfyUsed();

      const accepted = {
        success: true,
        id: queued.prompt_id,
        seed,
        model: definition.id,
        kind: definition.kind,
        settings,
        ...(unloaded.length ? { unloaded } : {}),
        // What was actually sent, when it is not what was asked -- see shapeAnimaPrompt.
        ...(shaped?.changed ? { prompt: shaped.prompt, tags: shaped.tags } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
      rememberSubmit(job.requestId, accepted);
      sendJson(res, accepted);
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    }
  });

  /* Something done to a picture rather than a picture drawn: `rmbg` takes the
     background out, `upscale` makes it bigger, `tag` reads its danbooru tags.
     Queued and watched exactly like a generation -- the same `/studio/job`
     answers when it is done, with the tags as `texts`. See server/imageOps.js. */
  route('/studio/op', async (req, res) => {
    let job;
    try { job = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    const image = typeof job.image === 'string' ? job.image.trim() : '';
    if (!image) return sendJson(res, { success: false, error: 'A picture is required' }, 400);
    const already = recallSubmit(job.requestId);
    if (already) return sendJson(res, { ...already, repeated: true });

    let installed;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return sendJson(res, offline(base, e), 502);
    }
    const objectInfo = installed.objectInfo || {};

    let built;
    if (job.op === 'rmbg') built = removeBackgroundGraph({ image, objectInfo });
    else if (job.op === 'upscale') {
      built = upscaleGraph({
        image, objectInfo, factor: job.factor, size: { width: job.width, height: job.height },
      });
    } else if (job.op === 'tag') built = tagGraph({ image, objectInfo });
    else return sendJson(res, { success: false, error: `Unknown operation: ${job.op}` }, 400);

    if (built.missing) {
      return sendJson(res, {
        success: false,
        missing: built.missing,
        error: `This ComfyUI is missing ${built.missing.join(', ')}.`,
      }, 400);
    }
    if (built.tooLarge) {
      return sendJson(res, {
        success: false,
        tooLarge: true,
        error: `The picture is already ${built.longest}px on its longer side; enlarging it further would not fit in a chat.`,
      }, 400);
    }

    stampOutputs(built.prompt, Date.now().toString(36));
    // One tenant on the card, as for a generation. See server/vram.js.
    const unloaded = await vram.releaseLlm();
    try {
      const queued = await withTimeout(`${base}/prompt`, {
        method: 'POST',
        body: { prompt: built.prompt, client_id: CLIENT_ID },
        timeout: 30000,
      });
      if (!queued?.prompt_id) {
        const detail = queued?.error?.message || queued?.error || 'ComfyUI refused the job';
        const nodes = Object.entries(queued?.node_errors || {})
          .map(([id, err]) => `${id}: ${err?.errors?.[0]?.message || 'invalid'}`)
          .join('; ');
        return sendJson(res, { success: false, error: nodes ? `${detail} (${nodes})` : String(detail) }, 400);
      }
      vram.comfyUsed();
      // So the progress card can name what it is doing, as for a generation.
      events.register(queued.prompt_id, {
        total: Object.keys(built.prompt).length,
        nodes: Object.fromEntries(Object.entries(built.prompt)
          .map(([id, node]) => [id, { class: node.class_type, title: node._meta?.title || '' }])),
      });
      const accepted = {
        success: true,
        id: queued.prompt_id,
        op: job.op,
        ...(built.factor ? { factor: built.factor } : {}),
        ...(unloaded.length ? { unloaded } : {}),
      };
      rememberSubmit(job.requestId, accepted);
      sendJson(res, accepted);
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    }
  });

  /* Where a job has got to.

     Three sources, in this order, because each answers something the others
     cannot: the history knows about finished jobs, the queue knows about
     unfinished ones, and only the absence of both means the id is not real. */
  route('/studio/job', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, { success: false, error: 'An id is required' }, 400);

    try {
      const history = await withTimeout(`${base}/history/${encodeURIComponent(id)}`, { timeout: 15000 });
      const entry = history?.[id];
      if (entry) {
        const status = entry.status || {};
        // `status.completed` is false on a job that stopped because a node
        // threw, and the message lives in the messages array rather than
        // anywhere obvious.
        if (status.completed === false || status.status_str === 'error') {
          const message = (status.messages || [])
            .filter(m => m?.[0] === 'execution_error')
            .map(m => m?.[1]?.exception_message)
            .filter(Boolean)[0];
          return sendJson(res, { success: true, state: 'failed', error: message || 'The workflow failed in ComfyUI' });
        }
        const outputs = outputsOf(entry);
        // A tagger's answer is text, not a file, and is just as much a result.
        const texts = textsOf(entry);
        if (outputs.length > 0 || texts.length > 0) {
          return sendJson(res, {
            success: true,
            state: 'done',
            outputs: outputs.map(item => ({ ...item, url: `/studio/view?${viewQuery(item)}` })),
            ...(texts.length ? { texts } : {}),
          });
        }
      }

      const queue = await withTimeout(`${base}/queue`, { timeout: 15000 });
      const where = queuePosition(queue, id);
      if (where.state === 'gone') {
        // In the history with no outputs and not in the queue: it ran and
        // produced nothing, which is a failure however cheerfully it ended.
        return sendJson(res, entry
          ? { success: true, state: 'failed', error: 'The workflow produced no output' }
          : { success: true, state: 'unknown' });
      }
      sendJson(res, { success: true, state: where.state, ahead: where.ahead });
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    }
  });

  /* The bytes.

     Streamed through rather than buffered: a fifteen-second video at 2K is tens
     of megabytes, and holding one in this process to hand it on is memory spent
     for nothing. */
  /* Progress, as it happens.
   *
   * `/studio/job` answers "is it finished", which is the wrong question for
   * the ninety seconds before it is. This answers "what is it doing" -- which
   * node, which step of how many, how far through the graph, and what the
   * half-denoised picture looks like right now.
   *
   * Server-sent events rather than a websocket because the traffic is one way
   * and EventSource reconnects on its own; and rather than polling because the
   * interesting thing about a progress bar is that it moves.
   *
   * The preview image is deliberately *not* in the payload. It is 25KB of
   * JPEG, it changes several times a second, and base64 in a text stream would
   * make it a third bigger for nothing. What goes out is a counter, and the
   * picture is an ordinary image URL the browser fetches and caches. */
  route('/studio/events', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, { success: false, error: 'An id is required' }, 400);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Anything that buffers defeats a response that is never going to end.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (payload) => {
      try { res.write(payload); return true; } catch (e) { return false; }
    };
    const snapshot = (job) => ({
      id: job.id,
      state: job.state,
      phase: job.phase,
      // The stages this workflow will actually go through, in order. See
      // `phasesOf`: it is what lets a percentage mean something.
      phases: job.phases,
      node: job.node,
      nodeClass: job.nodeClass,
      nodeTitle: job.nodeTitle,
      step: job.step,
      steps: job.steps,
      nodesDone: job.done.length,
      nodesTotal: job.total,
      cached: job.cached,
      fraction: fractionOf(job),
      previewSeq: job.previewSeq,
      // A clip is drawn with <video>, a frame with <img>; the URL cannot say which.
      previewMime: job.previewMime,
      startedAt: job.startedAt,
      error: job.error,
    });
    const send = (job) => write(`data: ${JSON.stringify(snapshot(job))}\n\n`);

    write(': connected\n\nretry: 3000\n\n');
    // Whatever is already known, before waiting for the next change -- a job
    // half done when the page was opened should not look like one that has not
    // started.
    const known = events.get(id);
    if (known) send(known);

    const stop = events.subscribe((job) => {
      if (job.id !== id) return;
      if (!send(job)) close();
    });

    // ComfyUI goes quiet during a model load, which on a cold 20GB checkpoint
    // is a minute of nothing. Without this the browser gives up on a stream
    // that is working perfectly.
    const beat = setInterval(() => { if (!write(': ping\n\n')) close(); }, 15000);
    beat.unref?.();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      stop();
      try { res.end(); } catch (e) { /* already gone */ }
    };
    req.on('close', close);
    req.on('error', close);
  });

  /* The latest half-denoised frame.
   *
   * `seq` is in the URL and unused by this handler, which is the point: it
   * makes each frame its own immutable URL, so the browser caches it and an
   * `<img>` that has not changed is not refetched. Without it the same URL
   * would return different bytes and every cache between here and the screen
   * would be wrong.
   */
  route('/studio/preview', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const frame = events.preview(url.searchParams.get('id'));
    if (!frame) return sendJson(res, { success: false, error: 'No preview yet' }, 404);
    res.setHeader('Content-Type', frame.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    /* Ranges, for the clip. A <video> asks for `bytes=0-` and then for pieces,
       and the progress card starts each new clip at the moment the last one
       had reached -- a seek, which a server that ignores ranges turns into
       playback from the start every step. */
    const range = rangeOf(req.headers.range, frame.body.length);
    if (range === false) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${frame.body.length}`);
      return res.end();
    }
    const body = range ? frame.body.subarray(range.start, range.end + 1) : frame.body;
    res.statusCode = range ? 206 : 200;
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${frame.body.length}`);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  });

  /* What to type next.
   *
   * Two hundred thousand danbooru tags with Korean descriptions, searched on
   * the server because the file they come from is 22MB and this app is opened
   * from a phone. See `server/booruTags.js` for why that is not negotiable.
   *
   * The index is built on the first request rather than at boot: someone who
   * never opens the Studio should not pay for it. That first request costs
   * about 200ms and every one after it is single-digit milliseconds. */
  route('/studio/tags', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const query = url.searchParams.get('q') || '';
    // A dropdown, not a page of results. Anything past a dozen is scrolling,
    // and scrolling is what this replaces.
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 12, 1), 40);

    const index = loadTags();
    if (!index.size) {
      /* Reported rather than answered with an empty list. "No suggestions" and
         "the tag file is missing" look identical from the browser, and only one
         of them is fixable by the person reading. */
      return sendJson(res, {
        success: false,
        error: 'No tag list: assets/danbooru-tags.csv is missing or unreadable.',
        tags: [],
      });
    }
    sendJson(res, { success: true, total: index.size, tags: searchTags(index, query, limit) });
  });

  /* A booru link, turned into a prompt.
   *
   * Pasting the picture you want to work from is the fastest way to describe
   * it, and the tags are already written — by the people who catalogued it,
   * in the vocabulary the model was trained on.
   *
   * Fetched here rather than in the browser because a page served from this
   * origin cannot read a cross-origin JSON response: no booru sends
   * `Access-Control-Allow-Origin`, so the fetch succeeds, returns an opaque
   * response, and the browser hands the page nothing. */
  route('/studio/booru', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const link = url.searchParams.get('url') || '';

    const post = parseBooruUrl(link);
    if (!post) {
      return sendJson(res, {
        success: false,
        error: 'That is not a booru post link. Paste the address of a single post — '
          + 'danbooru, safebooru, gelbooru, yande.re or konachan.',
      }, 400);
    }

    const api = apiUrlFor(post);
    if (!api) return sendJson(res, { success: false, error: `Unsupported site: ${post.host}` }, 400);

    try {
      const upstream = await fetch(api, {
        headers: {
          /* Danbooru refuses the default `node` agent outright, and the others
             rate-limit it harder. Naming the app is what their terms ask for. */
          'User-Agent': 'ollama-webui/1.0 (personal, self-hosted)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!upstream.ok) {
        return sendJson(res, {
          success: false,
          error: upstream.status === 404
            ? `${post.host} has no post ${post.id}.`
            : `${post.host} answered HTTP ${upstream.status}.`,
        }, 502);
      }

      const payload = await upstream.json().catch(() => null);
      const tags = tagsFromPost(firstPost(payload));
      if (!tags || !tags.general.length) {
        /* A post that exists and carries no usable tags. Most often this is a
           safebooru id that only exists on gelbooru, where the API answers 200
           with an empty list rather than a 404. */
        return sendJson(res, {
          success: false,
          error: `${post.host} returned no tags for post ${post.id}.`,
        }, 404);
      }

      sendJson(res, {
        success: true,
        site: post.site,
        id: post.id,
        rating: tags.rating,
        // Comma-separated, because that is what goes in the box. The artist
        // tags come back separately so they can land in the artist box.
        prompt: tags.general.join(', '),
        artists: tags.artist.join(', '),
        count: tags.general.length,
      });
    } catch (e) {
      /* `fetch failed` on its own is not something anyone can act on, and on
         this network it is the common case rather than the rare one: danbooru
         and gelbooru are blocked outright by several countries' ISPs — the
         connection is refused in under a tenth of a second, long before any
         timeout — while safebooru, which carries much the same catalogue, is
         not. Saying so is the difference between "the app is broken" and "use
         the other link". */
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      sendJson(res, {
        success: false,
        error: timedOut
          ? `${post.host} did not answer in time.`
          : `Could not reach ${post.host} — it may be blocked on this network. `
            + `A safebooru.org link usually works. (${e.message})`,
      }, 502);
    }
  });

  route('/studio/view', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const filename = url.searchParams.get('filename');
    if (!filename) return sendJson(res, { success: false, error: 'A filename is required' }, 400);

    const query = new URLSearchParams({
      filename,
      subfolder: url.searchParams.get('subfolder') || '',
      type: url.searchParams.get('type') || 'output',
    });
    /* A lighter copy, for the gallery. ComfyUI re-encodes a file on request
       (`/view?preview=webp;85`), and a 2520×3676 PNG that is 11MB comes back
       as a 500KB WebP of the same picture — so sixty cards stop being six
       hundred megabytes on a phone. Only the two formats ComfyUI accepts, and
       a quality it can parse, are passed on. */
    const preview = url.searchParams.get('preview') || '';
    if (/^(webp|jpeg);\d{1,3}$/.test(preview)) query.set('preview', preview);

    try {
      const upstream = await withTimeout(`${base}/view?${query}`, { timeout: 60000, raw: true });
      if (!upstream.ok) return sendJson(res, { success: false, error: `ComfyUI HTTP ${upstream.status}` }, upstream.status);

      res.statusCode = 200;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      // Generated files are immutable: the name carries a counter, so the same
      // URL is the same bytes for ever.
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) sendJson(res, offline(base, e), 502);
      else res.end();
    }
  });

  /* A reference image, handed to ComfyUI.
   *
   * A workflow that turns a picture into a video loads that picture by name
   * from ComfyUI's own input folder, so the bytes have to get there first.
   * ComfyUI has an upload endpoint; this forwards to it rather than reaching
   * into the directory, so it works when ComfyUI is on another machine and
   * stays inside whatever that endpoint is willing to accept.
   *
   * The body is passed through untouched — it is `multipart/form-data` with a
   * boundary the browser chose, and re-encoding it here would mean parsing
   * multipart for no reason. */
  route('/studio/upload', async (req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // A reference frame, not a film. Anything larger is a mistake.
      if (size <= 64 * 1024 * 1024) chunks.push(chunk);
    });
    req.on('end', async () => {
      if (size > 64 * 1024 * 1024) return sendJson(res, { success: false, error: 'That file is too large' }, 413);
      try {
        const upstream = await fetch(`${base}/upload/image`, {
          method: 'POST',
          headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
          body: Buffer.concat(chunks),
        });
        if (!upstream.ok) return sendJson(res, { success: false, error: `ComfyUI HTTP ${upstream.status}` }, 502);
        const data = await upstream.json();
        // ComfyUI answers with the name it filed it under, which is what a
        // LoadImage node needs and is not always the name it was given.
        sendJson(res, {
          success: true,
          name: data.subfolder ? `${data.subfolder}/${data.name}` : data.name,
        });
      } catch (e) {
        sendJson(res, offline(base, e), 502);
      }
    });
    req.on('error', () => sendJson(res, { success: false, error: 'The upload failed' }, 400));
  });

  /* Stopping.
   *
   * This used to delete the id from the queue and then interrupt, always and
   * in that order, which got two things wrong.
   *
   * `/interrupt` stops whatever is running -- not whatever you named. Pressing
   * stop on a job that was still waiting its turn killed the one in front of
   * it instead, and left the one you meant to stop to start straight
   * afterwards.
   *
   * And stopping the running job is not stopping the queue. ComfyUI takes the
   * next prompt the instant the current one ends, however it ended, so a stop
   * that reached the right job still looked like it had done nothing: the GPU
   * carried on, a picture kept being drawn, and the only honest description of
   * that from the outside is that the cancel did not work. `all` clears the
   * queue first and interrupts second, which is the order that leaves nothing
   * to take over.
   *
   * Then it waits and looks again, because `/interrupt` returns when the flag
   * is set rather than when the sampler has noticed it -- and reports what is
   * actually left rather than assuming.
   *
   * Finally the models come out of VRAM. A cancelled job has no use for four
   * gigabytes of checkpoint, eight LoRAs and an upscaler, and leaving them
   * resident is what makes a stopped generation still feel like it is running.
   * Only when nothing is left to run, so this never pulls the models out from
   * under a job someone else is waiting on.
   */
  route('/studio/cancel', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    const id = body.id ? String(body.id) : '';
    const all = !!body.all;
    const idsOf = (queue, key) => (queue?.[key] || []).map(item => item?.[1]).filter(Boolean);
    const readQueue = () => withTimeout(`${base}/queue`, { timeout: 10000 }).catch(() => null);
    const post = (path, payload) =>
      withTimeout(`${base}${path}`, { method: 'POST', body: payload, timeout: 10000, raw: true }).catch(() => null);

    try {
      const queue = await readQueue();
      if (!queue) return sendJson(res, offline(base, new Error('the queue could not be read')), 502);
      const running = idsOf(queue, 'queue_running');
      const pending = idsOf(queue, 'queue_pending');
      let interrupted = false;

      if (all) {
        // The waiting ones first: interrupting with the queue still full only
        // hands the GPU to the next prompt.
        await post('/queue', { clear: true });
        if (running.length) { await post('/interrupt', {}); interrupted = true; }
      } else {
        if (pending.includes(id)) await post('/queue', { delete: [id] });
        // Only when it is the one actually running. Interrupting otherwise
        // stops somebody else's job.
        if (running.includes(id)) { await post('/interrupt', {}); interrupted = true; }
      }

      // Wait for it to be true rather than for it to have been asked.
      let left = { running, pending };
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const now = await readQueue();
        if (!now) break;
        left = { running: idsOf(now, 'queue_running'), pending: idsOf(now, 'queue_pending') };
        const stillThere = all
          ? left.running.length > 0 || left.pending.length > 0
          : left.running.includes(id) || left.pending.includes(id);
        if (!stillThere) break;
      }

      const remaining = left.running.length + left.pending.length;
      let freed = false;
      if (remaining === 0 && body.unload !== false) {
        /* Asking once is not enough after an interrupt, and the difference is
           four gigabytes.
           
           The prompt leaves the running list as soon as it is interrupted, but
           the worker is still unwinding it -- and on the way out it re-registers
           the model it was using as the loaded one. A `/free` that lands in that
           window returns cheerfully and frees nothing: measured here, VRAM sat
           at 6.21GB through ten seconds and five checks, and dropped to 1.33GB
           the moment a second `/free` was sent.
           
           So when something was interrupted, the GPU is asked what it actually
           holds and told again until it lets go. Where nothing was interrupted
           there is no teardown to race, and once is enough. */
        const inUse = async () => {
          const stats = await withTimeout(`${base}/system_stats`, { timeout: 8000 }).catch(() => null);
          const card = stats?.devices?.[0];
          return Number.isFinite(card?.vram_total) && Number.isFinite(card?.vram_free)
            ? card.vram_total - card.vram_free
            : null;
        };
        const before = interrupted ? await inUse() : null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const done = await post('/free', { unload_models: true, free_memory: true });
          freed = freed || !!done?.ok;
          if (before === null) break;
          await new Promise(resolve => setTimeout(resolve, 400));
          const now = await inUse();
          // Half a gigabyte is past any measurement noise and under the
          // smallest thing worth unloading.
          if (now === null || before - now > 512 * 1024 * 1024) break;
        }
      }

      sendJson(res, {
        success: true,
        stopped: all
          ? remaining === 0
          : !(left.running.includes(id) || left.pending.includes(id)),
        freed,
        remaining,
      });
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    }
  });

  return routes;
};
