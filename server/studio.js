import { localStudioFile } from './studioFiles.js';
import { assertMemoryAvailable, commitAvailable, commitShortfall, forgetCommit, isLocalAddress } from './resourceSafety.js';
import { readRequestBody } from './requestBody.js';
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
  applyRegionEdit, regionTerms, REGION_NODES, MASK_NODES, readSettings, readDenoise, dropReference,
  applyPoseGuide, pickPoseLLLite,
} from './workflows.js';
import { shapeAnimaPrompt, framedAnimaPrompt } from './animaPrompt.js';
import {
  removeBackgroundGraph, removeShadowGraph, upscaleGraph, tagGraph, videoTagGraph, textsOf,
} from './imageOps.js';
import { videoFile, pictureFile, createVideoTagCache } from './videoTags.js';
import { applyH3Motion, applyH3Segment, applyH3Upscale, bypassUnloads, segmentPlan, HYBRID_NODE, SEGMENT_SECONDS } from './h3Motion.js';
import { longVideosFor, isLongId, parseCaptionLines } from './longVideo.js';
import { MUSIC_DIR } from './music.js';
import { enginesFor } from './engines.js';
import { comfySpec } from './hwSpec.js';
import { segmentPrompts, frameMemory } from '../src/videoPrompt.js';
import {
  trainGraph, daemonBase, daemonState, datasetFolder, slugify, findLora,
  TRAIN_NODES, TRAIN_PACK, TRAIN_BASE, PRESETS, DIALS, GPU_TIERS, MIN_IMAGES, MAX_IMAGES,
} from './training.js';
import { toEditorWorkflow } from './comfyGraph.js';
import { createComfyEvents, fractionOf } from './comfyEvents.js';
import path from 'node:path';
import fs from 'node:fs';
import { createTimings } from './studioTimings.js';
import { DATA_DIR } from './db.js';
import {
  loadTags, searchTags, tagsAboveCount, parseBooruUrl, apiUrlsFor, tagsFromPost, firstPost,
  fixTagPromptReport,
} from './booruTags.js';
// One route here serves a published picture; see `/api/share/image` below.
import { readShare } from './shares.js';
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
      /* And whether only one part of it can be redrawn. Not the same question
         as `referenceImage`: a workflow can take a picture to edit without the
         graph having anywhere to put a mask, and offering "redraw only the
         hair" there is offering something that silently becomes a whole-
         picture edit. See `applyRegionEdit`. */
      ...(definition.img2img?.inpaint ? { region: true } : {}),
      /* Following the pose of another picture: only where the workflow has a
         model link for the guide *and* the guide is installed, since without
         the patch file the switch would do nothing. See applyPoseGuide. */
      ...(definition.pose && installed?.objectInfo?.AnimaLLLiteApply
        && pickPoseLLLite(installed.objectInfo?.ModelPatchLoader?.input?.required?.name?.[0] || [])
        ? { pose: true, poseDetect: !!installed.objectInfo?.DWPreprocessor } : {}),
      /* Long clips and looping ones. Offered only where the node pack that can
         pin a keyframe *and* keep the reference picture is actually installed:
         without it the ceiling really is one pass, and a "loop" switch that
         quietly makes an ordinary clip is worse than no switch. */
      ...(definition.motion?.long && installed?.objectInfo?.[HYBRID_NODE] ? { longVideo: true } : {}),
      ...(definition.motion?.loop && installed?.objectInfo?.[HYBRID_NODE] ? { loop: true } : {}),
      /* Shots rather than one take, which needs no pin and so no node pack; and
         the workflow's own upscaler, where its node is installed. */
      ...(definition.motion?.long ? { cut: true } : {}),
      ...(definition.id === 'minimax-h3' && installed?.objectInfo?.RTXVideoSuperResolution ? { upscale: true } : {}),
    },
    /* How many LoRAs this workflow can stack. Anima's stacker takes nine
       without changing anything; Krea 2's single loader is cloned and chained,
       which is why it has a ceiling at all. */
    loraSlots: definition.loras?.max || 0,
    loraUnlimited: !!definition.loras,
    /* Why the ones it does not have are absent.
     *
     * The Studio greys those controls and puts the reason beside them instead
     * of leaving them out. A control that is simply missing reads as a feature
     * nobody built — which is exactly what happened with Krea 2 Turbo's
     * negative prompt, and the honest answer there is "this model is
     * guidance-distilled and a negative prompt would do nothing", not silence. */
    missing: {
      ...(definition.missing || {}),
      /* Said rather than left blank: "this needs a node you do not have" is a
         thing somebody can act on, and an absent switch is not. */
      ...(definition.motion && !installed?.objectInfo?.[HYBRID_NODE]
        ? { loop: 'needsHybridNode', longVideo: 'needsHybridNode' } : {}),
    },
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
  const unique = found.filter(item => {
    const key = `${item.subfolder}/${item.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  /* And a preview beside a save is not a result at all.
   *
   * Anima's graph previews twice on the way to its one saved file: a
   * PreviewBridge of the picture before SeedVR2 enlarges it, and a
   * PreviewImage of the finished one. Both land in ComfyUI's temp folder under
   * names of their own, so one picture came back as three -- three cards in
   * the gallery, the first of them the smaller unfinished one the Studio
   * opened when the picture was pressed, and all but the saved one gone the
   * next time ComfyUI started, because it empties temp when it does. Kept only
   * where nothing of that kind was saved, so a graph that only previews still
   * shows what it made. */
  const saved = new Set(unique.filter(item => item.type !== 'temp').map(item => item.media));
  return unique.filter(item => item.type !== 'temp' || !saved.has(item.media));
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

/* What is being drawn right now, and which conversation it belongs to. It is
   its own module because the songs go in the same register -- see
   server/liveJobs.js. Re-exported here because this is where it was, and where
   the tests and every other caller reach for it. */
export {
  rememberLiveJob, forgetLiveJob, forgetLiveJobs, liveJobsFor, describeQueued,
  reconcileLiveJobs,
} from './liveJobs.js';

import { expandWildcards, hasWildcards, parseWildcardLists } from '../src/wildcards.js';
import {
  rememberLiveJob, forgetLiveJob, forgetLiveJobs, liveJobsFor, describeQueued,
  reconcileLiveJobs,
} from './liveJobs.js';
import { noteFinished, sendPush } from './push.js';

const sendJson = (res, payload, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

/**
 * A file on this machine, with byte ranges.
 *
 * A `<video>` asks for `Range: bytes=N-` to seek and to read a poster frame,
 * and a server that only ever sends the whole file makes it download hundreds
 * of megabytes before the first picture -- or refuse to seek at all in Safari.
 */
export const serveFile = (req, res, file, type) => {
  let size;
  try { size = fs.statSync(file).size; } catch { return sendJson(res, { success: false, error: 'Not found' }, 404); }
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.statusCode = 200;
  }
  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
};

/**
 * Carry on with the long clips a restart interrupted. Called once by each
 * server at startup (server/index.js, vite.config.js) -- not by the routes,
 * which tests create dozens of times against fake ComfyUIs.
 */
export const resumeLongVideos = (env = {}) => {
  if (String(env.LONG_VIDEO_RESUME ?? 'true').toLowerCase() === 'false') return [];
  return longVideosFor({
    base: comfyBase(env),
    dir: path.join(DATA_DIR, 'long-videos'),
    withTimeout,
    ffmpeg: env.FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || process.env.FFPROBE_PATH || 'ffprobe',
  }).resume();
};

/**
 * A long clip's progress, as the card reads one job's.
 *
 * The card listens for its own id and stops listening at `done` -- and each
 * segment is a ComfyUI prompt with an id of its own that is `done` minutes
 * before the clip is. So a segment's snapshot is re-labelled with the clip's
 * id, kept `running` until the last segment, and its fraction and time left
 * are spread over the whole clip: segment 3 of 12 at half way is 21%, not 50%.
 */
export const asLong = (id, snap, status = null, longs = null) => {
  const long = status || longs?.status(id) || null;
  const segments = Number(long?.segments) || 1;
  const segment = Number(long?.segment) || 1;
  const finished = snap.state === 'done' || snap.state === 'cached';
  const within = finished ? 1 : (typeof snap.fraction === 'number' ? snap.fraction : 0);
  const perSegment = Number.isFinite(snap.expectedMs) && snap.expectedMs > 0 ? snap.expectedMs : null;
  const later = segments - segment;
  return {
    ...snap,
    id,
    // Only the clip ends the card. A failed segment fails the clip, and says so.
    state: finished && long?.state !== 'done' ? 'running' : snap.state,
    fraction: Math.min(1, (segment - 1 + within) / segments),
    remainingMs: Number.isFinite(snap.remainingMs) && perSegment ? snap.remainingMs + later * perSegment : null,
    expectedMs: perSegment ? perSegment * segments : null,
    segment,
    segments,
  };
};

/** The clip's own state, when no segment is running to report one. */
export const longSnapshot = (id, long) => {
  if (!long) return null;
  if (long.state === 'done') return { id, state: 'done', fraction: 1 };
  if (long.state === 'failed') return { id, state: 'failed', error: long.error };
  const segments = Number(long.segments) || 1;
  const joining = long.phase === 'joining';
  return {
    id,
    state: 'running',
    phase: joining ? 'saving' : 'loading',
    fraction: joining ? 0.99 : Math.min(1, ((Number(long.segment) || 1) - 1) / segments),
    segment: long.segment,
    segments,
  };
};

const readBody = async (req, limit = 4 * 1024 * 1024) => {
  const raw = await readRequestBody(req, limit);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw new Error('Invalid JSON'); }
};

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

/**
 * ComfyUI's complaint about the nodes it would not run, as one line; '' when there is none.
 *
 * A graph with one broken branch is not refused outright: ComfyUI queues
 * whatever still validates and lists the rest in `node_errors`. For a picture
 * whose model file is missing that leaves only the prompt refiner, and the job
 * comes back "done" with a line of text and no picture.
 */
export const nodeErrorsText = (queued) => Object.entries(queued?.node_errors || {})
  .map(([id, err]) => {
    const first = err?.errors?.[0] || {};
    const details = String(first.details || '').slice(0, 160);
    return `${id}: ${first.message || 'invalid'}${details ? ` (${details})` : ''}`;
  })
  .join('; ');

/* Take back a prompt ComfyUI accepted only in part: out of the queue while it
   waits, interrupted once it has started -- and only then, so nobody else's
   job is stopped in its place. */
const withdraw = async (base, id) => {
  try {
    const queue = await withTimeout(`${base}/queue`, { timeout: 10000 });
    const running = (queue?.queue_running || []).some(item => item?.[1] === id);
    await withTimeout(`${base}/${running ? 'interrupt' : 'queue'}`, {
      method: 'POST', body: running ? { prompt_id: id } : { delete: [id] }, timeout: 10000, raw: true,
    });
  } catch { /* ComfyUI gone in the meantime: nothing left to take back */ }
};

/* Half a gigabyte: below it ComfyUI is holding its own bookkeeping, not a model. */
const HOLDS_A_MODEL = 512 * 1024 * 1024;

/**
 * What ComfyUI has in memory, as rows shaped like Ollama's `/api/ps`.
 *
 * `report` is from comfyui/ollama_webui_memory, the extension that reads
 * ComfyUI's own list of loaded models: one row each, with the whole model as
 * `size` and the part on the card as `size_vram`, so the list and the monitor
 * read it exactly as they read a language model. Without the extension there
 * is only `/system_stats`, which says how much torch holds on the card and not
 * what it is: one row named ComfyUI, marked `approximate`, and only when it is
 * holding something.
 */
export const comfyResident = (report, stats) => {
  if (Array.isArray(report?.models)) {
    return report.models
      .filter(m => m && m.name && Number(m.size) > 0)
      .map(m => ({
        // ComfyUI's class names: `MiniMaxH3TEModel_` is the text encoder.
        name: String(m.name).replace(/_+$/, ''),
        size: Number(m.size),
        size_vram: Math.min(Math.max(Number(m.size_vram) || 0, 0), Number(m.size)),
        source: 'comfyui',
      }))
      .sort((a, b) => b.size - a.size);
  }
  const held = stats?.devices?.[0]?.torch_vram_total;
  return Number.isFinite(held) && held > HOLDS_A_MODEL
    ? [{ name: 'ComfyUI', size: held, size_vram: held, source: 'comfyui', approximate: true }]
    : [];
};

/* This PC against ComfyUI's minimum (server/hwSpec.js). Measuring runs
   nvidia-smi once per process; a failure is no warning rather than an error. */
const comfySpecSafe = () => { try { return comfySpec(); } catch { return null; } };
const slowText = (s) => `이 PC는 최소 사양 근처예요 (VRAM ${s.vram} GB · RAM ${s.ram} GB · 가상 메모리 포함 ${s.commit} GB). `
  + '그림, 특히 영상 생성이 느리거나 가끔 메모리 부족으로 실패할 수 있어요.';

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
/* Which ComfyUI client this process is, for the prompts it queues and the
 * socket it hears them on.
 *
 * It used to be 'ollama-webui' for every process, and ComfyUI keeps one socket
 * per client id: a second process connecting under the same id -- the dev
 * server beside this one -- took the messages over, and when either socket
 * closed ComfyUI dropped the id altogether, so neither heard anything more.
 * The Studio then said "queued" for a picture ComfyUI was plainly drawing.
 *
 * So each kind of server has its own: the script it runs and the port, hashed.
 * The same server restarted keeps its id, which is what lets it pick up the
 * progress of a job it queued before the restart. */
/* A dial's value inside its range, or the fallback for anything that is not a
   number. `Number(null)` is 0 and `Number('')` is 0, and both would read as a
   deliberate zero -- which for a learning rate is a run that learns nothing
   and for a rank is a graph ComfyUI refuses. */
const clampDial = (value, range, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
};

export const clientIdFor = (script = '', port = '') => {
  let h = 2166136261;
  for (const ch of `${script}|${port}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `ollama-webui-${h.toString(36)}`;
};

/**
 * `identify` says which account a request is acting as, or '' for the guest.
 *
 * Passed in rather than imported: the session cookie is read by one closure in
 * server/api.js, and a second reader of it here would be a second thing to keep
 * in step with how sessions work. It is only used to scope `/studio/live`.
 */
export const createStudioRoutes = (env = {}, { identify = () => '' } = {}) => {
  const base = comfyBase(env);
  // This server's ComfyUI client -- see clientIdFor. The port is .env's, which is not in process.env.
  const CLIENT_ID = clientIdFor(process.argv[1] || '', env.PORT || process.env.PORT || '');
  const routes = [];
  const route = (path, handler) => routes.push({ path, handler });

  /* Opened on the first job, not now: an app whose owner never opens the
     Studio should not hold a socket open to a ComfyUI that may not be
     running. */
  const events = createComfyEvents({
    base,
    clientId: CLIENT_ID,
    // How long each workflow took before, so the next run's bar means something.
    timings: createTimings({ file: path.join(DATA_DIR, 'studio-timings.json') }),
  });

  /* What survived a restart, and what only looks as though it did.
   *
   * The register outlives this process now (server/liveJobs.js), which is the
   * point of it -- ComfyUI goes on drawing across an `npm start`. The cost is
   * that a job which *finished* while this app was down is still written down
   * as live, and would be offered to a phone as a progress bar for a picture
   * already in the conversation. ComfyUI's own queue is the authority, so it is
   * asked, once, as soon as these routes exist.
   *
   * Failure is silence on purpose: a ComfyUI that is not running has no queue
   * to compare against, and the half-hour expiry clears the table either way. */
  (async () => {
    try {
      const queue = await withTimeout(`${base}/queue`, { timeout: 8000 });
      const ids = [...(queue?.queue_running || []), ...(queue?.queue_pending || [])]
        .map(item => item?.[1]).filter(Boolean);
      const dropped = reconcileLiveJobs(ids);
      if (dropped > 0) console.log(`[studio] ${dropped} job(s) finished while this server was down`);
    } catch (e) { /* nothing to reconcile against */ }
  })();

  // Who has the graphics card. See server/vram.js.
  const vram = vramGuard(env);
  // Long clips, rendered a segment at a time and joined on disk. See server/longVideo.js.
  const longVideos = longVideosFor({
    base,
    dir: path.join(DATA_DIR, 'long-videos'),
    withTimeout,
    ffmpeg: env.FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || process.env.FFPROBE_PATH || 'ffprobe',
  });
  /* And who else may be holding it: an engine that finished a song five minutes
     ago still has its models on the card. */
  const engines = enginesFor(env);

  /* `auto`, `latent2rgb`, `taesd`, or `none` to turn previews off — for a
     machine where every megabyte of VRAM is spoken for and a preview decoder
     is one too many. */
  const previewMethod = String(env.COMFYUI_PREVIEW || 'auto').trim() || 'auto';

  /* What only these routes can do for a long clip: build a segment's graph from
     the job's saved template, queue it with this server's client id and
     progress stream, and hold the card. Bound here and not passed per job, so a
     clip resumed after a restart is built exactly as a new one is. */
  longVideos.bind({
    build: (spec, i, firstFrame) => {
      const graph = JSON.parse(spec.template);
      // A name per build, not per segment: a redone segment with the same prompt
      // is otherwise served from ComfyUI's cache, with no file to show for it.
      stampOutputs(graph, `${spec.stamp}-${i + 1}-${Date.now().toString(36)}`);
      applyH3Segment(graph, {
        segment: i, count: spec.count, prompt: spec.prompts?.[i] || '', firstFrame, loop: !!spec.loop,
        available: new Set(spec.available || []),
      });
      if (spec.keepModels) bypassUnloads(graph);
      return graph;
    },
    submit: async (graph, spec) => {
      events.open();
      const queued = await withTimeout(`${base}/prompt`, {
        method: 'POST',
        body: {
          prompt: graph,
          client_id: CLIENT_ID,
          extra_data: { extra_pnginfo: { workflow: toEditorWorkflow(graph, spec.properties || {}) }, preview_method: previewMethod },
        },
        timeout: 30000,
      });
      const refused = nodeErrorsText(queued);
      if (!queued?.prompt_id || refused) {
        if (queued?.prompt_id) await withdraw(base, queued.prompt_id);
        const detail = queued?.error?.message || queued?.error
          || (queued?.prompt_id ? 'ComfyUI refused part of the workflow' : 'ComfyUI refused the workflow');
        throw new Error(refused ? `${detail} (${refused})` : String(detail));
      }
      events.register(queued.prompt_id, {
        total: Object.keys(graph).length,
        nodes: Object.fromEntries(Object.entries(graph)
          .map(([nodeId, node]) => [nodeId, { class: node.class_type, title: node._meta?.title || '' }])),
        profile: [spec.profile, spec.modelId].filter(Boolean),
      });
      vram.comfyUsed();
      return queued.prompt_id;
    },
    outputsOf,
    /* The card stays ComfyUI's for the whole clip, not just while a segment is
       queued: between two segments the queue is empty for a few seconds, and a
       chat model loaded into that gap is on the card when the next segment's
       forty gigabytes arrive. */
    hold: () => vram.beginComfySubmission(),
    onDone: (job) => {
      forgetLiveJob(job.id);
      noteFinished(job.owner || '', 'video');
      sendPush(job.owner || '').catch(() => {});
    },
    onFail: (job) => forgetLiveJob(job.id),
  });

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
      /* The bundled ComfyUI (engines.js "comfyui") is started when the Studio
         first asks and it is not up; the Studio polls this route, so the next
         ask finds it. `starting` lets the page say so instead of "offline". */
      const comfy = engines.resolve('comfyui');
      const starting = !!comfy?.installed;
      if (starting) engines.ensure('comfyui', { wait: false }).catch(() => {});
      const spec = comfySpecSafe();
      return sendJson(res, {
        ...offline(base, e), models: modelList(), starting,
        ...(starting ? { error: 'ComfyUI를 켜는 중이에요. 1~3분 걸릴 수 있어요.' } : {}),
        slowWarning: spec?.slow ? slowText(spec) : '',
      });
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
      // Near the minimum spec (server/hwSpec.js): the Studio shows it as a notice.
      slowWarning: (() => { const s = comfySpecSafe(); return s?.slow ? slowText(s) : ''; })(),
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

    /* `{red|blue} hair` and `__poses__`, chosen before anything reads the prompt.
     *
     * Here rather than in either browser because there are two senders -- the
     * Studio and the conversation -- and the choice has to be made once, per
     * picture, with what is drawn and what is recorded beside it agreeing. One
     * memo across the three fields, because a conversation's prompt carries its
     * subject twice and choosing twice would record a different picture from
     * the one drawn. See src/wildcards.js. */
    const typedPrompt = job.prompt;
    if (hasWildcards(job.prompt) || hasWildcards(job.negative)) {
      const lists = parseWildcardLists(job.wildcards);
      const memo = new Map();
      job.prompt = expandWildcards(job.prompt, { lists, memo });
      if (typeof job.subject === 'string') job.subject = expandWildcards(job.subject, { lists, memo });
      if (typeof job.negative === 'string') job.negative = expandWildcards(job.negative, { lists, memo });
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
    const stamp = Date.now().toString(36);
    stampOutputs(graph, stamp);

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
        /* Only the subject.
         *
         * A prompt from a conversation is prose and this turns it into the
         * tags and sentence Anima reads. What travels around that subject --
         * the quality tags the Studio puts in front of everything and the
         * modifiers it puts behind -- is not prose and must not be rearranged:
         * it was typed once, on purpose, with autocomplete, which is the same
         * reason the Studio's own prompt is never shaped at all.
         *
         * Reshaping the joined string instead moved `masterpiece, best quality`
         * to the end and turned it into a sentence, and these models read a
         * prompt positionally -- so the Studio's boxes reached the graph and
         * did nothing anybody could see. */
        const subject = typeof job.subject === 'string' ? job.subject : job.prompt;
        shaped = shapeAnimaPrompt(subject, index);
        /* The artists go into the prompt as well as to Anima's own encoder.
           They were only ever sent to the encoder, so the prompt recorded
           beside a picture never said who it was drawn like. */
        job.prompt = framedAnimaPrompt({
          lead: job.lead, artist: job.artist, tail: job.tail, shaped,
        });
        // What is reported back as "what was actually sent" is the whole of it,
        // not the middle.
        shaped = { ...shaped, prompt: job.prompt, changed: job.prompt !== subject };
      }
    }

    /* Tags as the tag list has them, not as a model remembered them.
     *
     * Two things go wrong when a model writes a character tag, and both are
     * silent. `iseri nina (blue archive)` puts the series in brackets, and to
     * every one of these encoders brackets are *emphasis* -- so the picture is
     * drawn from "iseri nina" with two unrelated words weighted up behind it.
     * And the series itself is often simply wrong, which is a tag that exists
     * nowhere contributing noise to the prompt.
     *
     * The list that the Studio's autocomplete already reads is the authority
     * for both. Nothing it does not recognise is touched -- see `fixTagPrompt`.
     *
     * Not for video: a clip's prompt is a timeline of sentences rather than
     * tags, and while nothing in it would match a tag, it is not a prompt this
     * has any business reading.
     */
    let tagged = null;
    // What the tag list changed, for the picture's settings to say. See fixTagPromptReport.
    let corrections = [];
    if (definition.kind !== 'video') {
      const index = loadTags();
      if (index.size) {
        /* Whose words these are. A prompt from a conversation was written by a
           model, and a model is confidently wrong about which series a
           character is from -- so an invented bracket is dropped. A prompt from
           the Studio's own box was typed by somebody with autocomplete beside
           them, and the only thing done to it is escaping brackets that belong
           to tags which really exist. `chat` is what tells the two apart: only
           the conversation sends one. */
        const fromModel = !!job.chat;
        const before = job.prompt;
        const fixedPrompt = fixTagPromptReport(index, job.prompt, { fromModel });
        const fixedNegative = fixTagPromptReport(index, job.negative, { fromModel });
        job.prompt = fixedPrompt.text;
        job.negative = fixedNegative.text;
        corrections = [...fixedPrompt.changes, ...fixedNegative.changes];
        if (job.prompt !== before) {
          tagged = job.prompt;
          console.log('[studio] tags corrected against the danbooru list');
        }
      }
    }

    const seed = resolveSeed(job.seed);

    /* A long clip is several clips.
     *
     * MiniMax H3 was trained on five to fifteen seconds -- its own tooltip says
     * so -- and a minute asked for in one pass is a minute of drift. So the
     * length written into the graph is one segment's, and the segments are
     * chained together after the values go in. See server/h3Motion.js.
     *
     * Worked out here because `duration` is about to be written into the graph,
     * and the graph must never be given the total. */
    const wantsMotion = definition.id === 'minimax-h3'
      && (!!job.loop || Number(job.duration) > SEGMENT_SECONDS.max);
    /* Set to a song, segments are whole bars of it (see segmentSecondsForTempo)
       rather than the total shared out evenly -- a cut between two beats reads
       as a mistake. As many as cover the song; the finish trims the rest. */
    const beat = Number(job.beatSeconds);
    const plan = !wantsMotion ? null
      : Number.isFinite(beat) && beat >= SEGMENT_SECONDS.min && beat <= SEGMENT_SECONDS.max
        ? (() => {
          const total = Number(job.duration) || definition.defaults?.duration || beat;
          const count = Math.max(1, Math.ceil(total / beat - 1e-6));
          return { count, seconds: beat, total: Math.round(count * beat * 1000) / 1000 };
        })()
        : segmentPlan(job.duration ?? definition.defaults?.duration, job.segmentSeconds);
    // The node pack that can pin a keyframe and keep the reference picture at
    // the same time. Without it there is no chaining and no loop -- but a cut,
    // whose segments are pinned to nothing, still works.
    const canChain = (installed.objectInfo || {})[HYBRID_NODE] !== undefined;
    const cut = !!job.cut && !job.loop;

    const values = prepareJob(definition, {
      ...job, seed, duration: plan && (canChain || cut) ? plan.seconds : job.duration,
    });
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
    /* No picture given: the workflow's own is not a default, it is somebody
       else's character. See dropReference. */
    if (!job.referenceImage && definition.controls?.referenceImage) {
      const dropped = dropReference(graph, definition);
      if (!dropped.dropped && dropped.reason === 'required') {
        warnings.push(`${definition.label} needs a reference picture; the one saved in the workflow was used.`);
      }
    }
    if (job.referenceImage && !definition.img2img && !definition.controls?.referenceImage) {
      warnings.push(`${definition.label} cannot work from an existing picture; it was ignored.`);
    }
    if (job.referenceImage && definition.img2img && !edited.applied) {
      warnings.push(`${definition.label} could not take the reference picture.`);
    }
    let guide = '';
    let guideStrength;
    if (regionWanted && edited.applied) {
      const region = applyRegionEdit(graph, definition, {
        image: job.referenceImage,
        region: job.region,
        maskImage,
        maskGrow: Number(job.maskGrow) || 0,
        // What is in `model_patches`, for the inpainting guide. See pickInpaintLLLite.
        patches: installed.objectInfo?.ModelPatchLoader?.input?.required?.name?.[0] || [],
        /* The two dials, as the reader left them. Held to their ranges there
           rather than here, so a value that arrives from anywhere -- this
           route, a test, a future caller -- is held to the same ones. See
           `tuned` in server/workflows.js. */
        guideStrength: job.guideStrength,
        growScale: job.maskGrowScale,
        available,
      });
      if (!region.applied) {
        const what = maskImage ? 'the marked area' : `the ${regionTerms(job.region).join(', ')}`;
        warnings.push(region.reason === 'missing'
          ? `Redrawing only ${what} needs ${region.missing.join(', ')} in ComfyUI `
            + `${maskImage ? '' : '(ComfyUI-RMBG for SAM3Segment)'}; the whole picture was edited instead.`
          : `${definition.label} cannot redraw one part of a picture; the whole picture was edited instead.`);
      }
      /* Which inpainting guide drew it, for the settings beside the result.
         An edit that came back unnatural is the reported symptom, and whether
         the guide was in the graph is the first thing to know about it. */
      guide = region.guided || '';
      guideStrength = region.strength;
    }

    /* The pose of another picture, where the workflow and ComfyUI can. See
       applyPoseGuide in server/workflows.js. Independent of the reference
       picture: a new drawing in someone's pose needs no picture to edit. */
    const poseImage = typeof job.poseImage === 'string' ? job.poseImage.trim() : '';
    let posed = null;
    if (poseImage) {
      posed = applyPoseGuide(graph, definition, {
        image: poseImage,
        strength: job.poseStrength ?? 1,
        end: job.poseEnd,
        detect: job.poseDetect !== false,
        multi: job.poseMulti === true,
        size: parseSize(job.size, `${definition.defaults?.width || 1024}x${definition.defaults?.height || 1024}`),
        available,
        patches: installed.objectInfo?.ModelPatchLoader?.input?.required?.name?.[0] || [],
      });
      if (!posed.applied && posed.reason === 'missing') {
        warnings.push(`Following a pose needs ${posed.missing.join(', ')} in ComfyUI; it was drawn without one.`);
      } else if (!posed.applied && posed.reason === 'unsupported') {
        warnings.push(`${definition.label} cannot follow a pose picture; it was ignored.`);
      }
    }

    /* The segments, and the pins that join them. After the picture goes in:
       a loop is pinned to the reference picture itself, at both ends. */
    let motion = null;
    /* Several segments, each its own prompt, joined on disk -- see
       server/longVideo.js. Nothing is chained inside this graph: it is the
       template every segment is copied from. */
    let longPlan = null;
    if (plan && (canChain || cut) && plan.count > 1) {
      const probe = applyH3Segment(JSON.parse(JSON.stringify(graph)), {
        segment: cut ? 0 : 1, count: plan.count, loop: !!job.loop, firstFrame: cut ? '' : 'probe.png', available,
      });
      if (probe.applied) longPlan = plan;
      else {
        warnings.push(probe.reason === 'noReference'
          ? 'A looping clip is pinned to a picture at both ends, so it needs a reference picture; '
            + 'this was rendered as an ordinary clip.'
          : `The clip could not be chained (${probe.reason}); it was rendered as an ordinary one.`);
      }
    } else if (plan && !(cut && plan.count > 1)) {
      if (!canChain) {
        warnings.push(`A ${plan.total}s or looping clip needs the ${HYBRID_NODE} node in ComfyUI `
          + '(custom_nodes/minimax-h3-hybrid-cond). This was rendered as one ordinary clip.');
      } else {
        motion = applyH3Motion(graph, {
          seconds: plan.total,
          segmentSeconds: job.segmentSeconds,
          loop: !!job.loop,
          // One part of the timeline per segment, each starting at 0s.
          prompts: segmentPrompts(values.positive ?? job.prompt, plan.count, plan.seconds),
          available: new Set(Object.keys(installed.objectInfo || {})),
        });
        /* And what it will hold while it does. The Studio picks width and
           height by hand, so this is the one path where a minute can be asked
           for at full size -- forty gigabytes of decoded frames, on a machine
           with sixty-two. Said before it runs rather than discovered as a
           computer that stops responding. */
        const holds = frameMemory(Number(values.width) * Number(values.height), plan.total);
        if (motion.applied && holds > 12e9) {
          warnings.push(`A ${plan.total}s clip at ${values.width}x${values.height} holds about `
            + `${Math.round(holds / 1e9)}GB of frames in system memory while it is joined. `
            + 'Render it smaller, or shorter.');
        }
        if (!motion.applied) {
          warnings.push(motion.reason === 'noReference'
            ? 'A looping clip is pinned to a picture at both ends, so it needs a reference picture; '
              + 'this was rendered as an ordinary clip.'
            : `The clip could not be ${job.loop ? 'looped' : 'chained'} (${motion.reason}); `
              + 'it was rendered as an ordinary one.');
        }
      }
    }

    const stacked = applyLoras(graph, definition, job.loras);
    if (stacked.capacity !== null && (job.loras || []).filter(l => l.enabled !== false).length > stacked.capacity) {
      warnings.push(`${definition.label} stacks ${stacked.capacity} LoRAs; the rest were left out.`);
    }
    /* The workflow's own upscaler, when asked. See applyH3Upscale. */
    let upscaled = false;
    if (job.upscale && definition.id === 'minimax-h3') {
      const up = applyH3Upscale(graph, { available });
      upscaled = up.applied;
      if (!up.applied) warnings.push(up.reason === 'missing'
        ? 'Upscaling needs the RTXVideoSuperResolution node in ComfyUI; the clip was written at its drawn size.'
        : 'This workflow has no upscaler to switch on; the clip was written at its drawn size.');
    }
    // Every segment starts from this, finished except for its own pins.
    const segmentBase = longPlan ? JSON.stringify(graph) : null;
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
      ...(posed?.applied ? { pose: posed.patch.replace(/\.safetensors$/i, ''), poseStrength: posed.strength } : {}),
      /* What was actually rendered. "Six segments of ten seconds" is not the
         same fact as "60s", and it is the first thing worth knowing about a
         clip that drifts at one particular join. */
      ...(longPlan ? {
        duration: longPlan.total,
        segments: longPlan.count,
        segmentSeconds: longPlan.seconds,
        ...(job.loop ? { loop: true } : {}),
        ...(cut ? { cut: true, transition: job.transition === 'none' ? 'none' : 'fade' } : {}),
      } : {}),
      ...(upscaled ? { upscale: 'RTX VSR 2x' } : {}),
      ...(!longPlan && motion?.applied ? {
        duration: plan.total,
        segments: motion.segments || 1,
        segmentSeconds: plan.seconds,
        ...(job.loop ? { loop: true } : {}),
      } : {}),
      ...(regionWanted && edited.applied ? { region: maskImage ? 'mask' : regionTerms(job.region).join(', ') } : {}),
      ...(guide ? { guide, guideStrength } : {}),
    };

    /* The language model off the card first, and waited for. Here, after
       everything that could refuse the job, so a request that was never going
       to run does not cost the chat a reload. */
    const endSubmission = vram.beginComfySubmission();
    let unloaded;
    try { assertMemoryAvailable(); unloaded = await vram.releaseLlm(); }
    catch (e) { endSubmission(); return sendJson(res, { success: false, error: e.message }, e.statusCode || 503); }
    /* The music engine too, when it has been sitting on the card doing nothing.
       A minute's grace, so a song still being polled is never pulled out from
       under itself -- see `touch` in server/engines.js. Eight gigabytes of VRAM
       this job would otherwise have to do without. */
    await engines.stopIfIdle('ace-step', 60000).catch(() => {});

    /* A model too big for what is left of commit is refused here, not found out
       by ComfyUI exiting half way through loading it.

       Reported: "make a two-minute MV of this character" -- MiniMax H3 after an
       Anima picture -- and ComfyUI died in torch_cpu.dll with 0xc0000005 while
       mapping the 19.5GB diffusion model. ComfyUI was still holding the Anima
       models from the picture in its RAM cache; with an idle queue those are
       let go first, which is often enough on its own. Only for a ComfyUI on
       this machine: commit here says nothing about one somewhere else. */
    if (definition.loadGB && isLocalAddress(base)) {
      try {
        const queue = await withTimeout(`${base}/queue`, { timeout: 5000 }).catch(() => null);
        const busy = !!queue && ((queue.queue_running || []).length > 0 || (queue.queue_pending || []).length > 0);
        const idle = !!queue && !busy;
        if (idle) {
          await withTimeout(`${base}/free`, { method: 'POST', body: { unload_models: true, free_memory: true }, timeout: 5000 }).catch(() => null);
          // `/free` sets a flag the worker acts on between prompts.
          await new Promise(resolve => setTimeout(resolve, 1500));
          forgetCommit();
        }
        /* Not while something is running: what it holds is charged now, and the
           same model a queued job shares would be counted twice. That job is
           waited for; this one is judged when ComfyUI is idle. */
        const short = busy ? null : commitShortfall(await commitAvailable(), definition.loadGB * 1024 ** 3);
        if (short) {
          endSubmission();
          console.warn(`[studio] ${definition.label} refused: ${Math.round(short.available / 1024 ** 3)}GB commit left, ${definition.loadGB}GB needed`);
          return sendJson(res, { success: false, error: short.message, code: 'commit' }, 503);
        }
      } catch (e) { /* unmeasurable is not a reason to refuse */ }
    }
    // Listening before it is queued -- see `open` in server/comfyEvents.js.
    events.open();


    if (longPlan) {
      const owner = identify(req);
      /* A song to set it to: a file server/music.js wrote, by name, with the
         lyrics it saved beside it. A name from the browser is a name, never a
         path. */
      let soundtrack = '';
      let lyrics = '';
      const trackName = String(job.soundtrack || '');
      if (trackName) {
        if (/^[a-zA-Z0-9_-]+\.(mp3|wav|flac)$/.test(trackName) && fs.existsSync(path.join(MUSIC_DIR, trackName))) {
          soundtrack = path.join(MUSIC_DIR, trackName);
          try { lyrics = JSON.parse(fs.readFileSync(`${soundtrack}.json`, 'utf8')).lyrics || ''; } catch { lyrics = ''; }
        } else {
          warnings.push('The song to set this clip to was not found; it kept its own sound.');
        }
      }
      const captions = Array.isArray(job.captions)
        ? job.captions.filter(c => Number(c?.end) > Number(c?.start) && String(c?.text || '').trim())
          .map(c => ({ start: Number(c.start), end: Number(c.end), text: String(c.text).slice(0, 200) }))
        : parseCaptionLines(job.captions);

      /* Keep the weights loaded between segments when there is room to: see
         bypassUnloads. Measured, because without the room this is how ComfyUI
         died in the first place. */
      let keepModels = false;
      if (job.keepModels !== false && definition.loadGB && isLocalAddress(base)) {
        const left = await commitAvailable().catch(() => null);
        keepModels = Number.isFinite(left) && left >= (definition.loadGB + 24) * 1024 ** 3;
      }

      const long = longVideos.start({
        count: longPlan.count,
        total: longPlan.total,
        segmentSeconds: longPlan.seconds,
        fps: Number(values.fps) || definition.defaults?.fps || 24,
        width: settings.width,
        height: settings.height,
        loop: !!job.loop,
        cut,
        transition: cut ? (job.transition === 'none' ? 'none' : 'fade') : 'none',
        prompts: segmentPrompts(values.positive ?? job.prompt, longPlan.count, longPlan.seconds),
        template: segmentBase,
        stamp,
        properties,
        profile: `${definition.id}${job.referenceImage ? '+ref' : ''}@${settings.width}x${settings.height}x${longPlan.seconds}s`,
        modelId: definition.id,
        available: [...available].filter(name => name === HYBRID_NODE),
        keepModels,
        soundtrack,
        songSeconds: Number(job.songSeconds) || 0,
        lyrics,
        lyricsCaptions: !!job.lyricsCaptions && !captions.length,
        captions,
      }, { owner, chat: job.chat || '' });
      /* The first segment is waited for, so a graph ComfyUI refuses is refused
         to this request rather than discovered by polling. */
      const until = Date.now() + 60000;
      while (!long.current && long.state === 'running' && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      endSubmission();
      if (long.state === 'failed') {
        return sendJson(res, { success: false, error: long.error }, 400);
      }
      const accepted = {
        success: true,
        id: long.id,
        seed,
        model: definition.id,
        kind: definition.kind,
        settings: { ...settings, ...(keepModels ? { modelsKept: true } : {}), ...(soundtrack ? { soundtrack: trackName } : {}) },
        ...(unloaded.length ? { unloaded } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
      rememberSubmit(job.requestId, accepted);
      rememberLiveJob({
        id: long.id, owner, chat: job.chat, kind: definition.kind,
        prompt: job.subject || job.prompt, model: definition.id,
        aspect: settings.height > 0 ? settings.width / settings.height : null,
      });
      return sendJson(res, accepted);
    }

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
      // ComfyUI reports a bad graph as `error` plus `node_errors`, and the node
      // errors are the half that says which input it disliked. See
      // `nodeErrorsText` for the graph it half accepts.
      const refused = nodeErrorsText(queued);
      if (!queued?.prompt_id || refused) {
        if (queued?.prompt_id) await withdraw(base, queued.prompt_id);
        const detail = queued?.error?.message || queued?.error
          || (queued?.prompt_id ? 'ComfyUI refused part of the workflow' : 'ComfyUI refused the workflow');
        return sendJson(res, { success: false, error: refused ? `${detail} (${refused})` : String(detail) }, 400);
      }
      /* What the websocket will need to make sense of what it hears.
         `executing` names a node by id and nothing else; the class name that
         turns `28` into "upscaling" is only knowable here, where the graph
         is. */
      events.register(queued.prompt_id, {
        total: Object.keys(graph).length,
        nodes: Object.fromEntries(Object.entries(graph)
          .map(([id, node]) => [id, { class: node.class_type, title: node._meta?.title || '' }])),
        /* Timed against runs of this workflow at this size -- and, for a
           video, this length, which is most of what it costs -- then of the
           workflow at any size. */
        profile: [
          `${definition.id}${job.referenceImage ? '+ref' : ''}@${settings.width}x${settings.height}${settings.duration ? `x${settings.duration}s` : ''}`,
          definition.id,
        ],
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
        /* What was actually sent, when the tag list corrected it. The chat
           records this beside the picture, so "what was this drawn from" is
           the prompt ComfyUI saw rather than the one the model typed. */
        /* What was actually sent, when the tag list corrected it or a wildcard
           was chosen. The chat and the Studio record this beside the picture,
           so "what was this drawn from" is the prompt ComfyUI saw. */
        ...(!shaped?.changed && (tagged || job.prompt !== typedPrompt) ? { prompt: job.prompt } : {}),
        ...(corrections.length ? { corrections } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
      rememberSubmit(job.requestId, accepted);
      /* And, when the picture is for a conversation, which conversation -- so
         the reader's other devices can watch it being made instead of sitting
         in front of an empty answer. See LIVE_JOBS. The Studio's own panel
         sends no `chat` and is recorded nowhere: its work is already on the
         screen it was started from. */
      rememberLiveJob({
        id: queued.prompt_id,
        owner: identify(req),
        chat: job.chat,
        kind: definition.kind,
        /* The prompt as it was asked for, not the framed one with this
           install's quality tags on both ends of it: this is a card heading. */
        prompt: job.subject || job.prompt,
        model: definition.id,
        aspect: settings.height > 0 ? settings.width / settings.height : null,
      });
      sendJson(res, accepted);
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    } finally { endSubmission(); }
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
    // The shadows lifted out of it. See `removeShadowGraph` for what that can
    // and cannot mean -- there is no node here that removes one outright.
    else if (job.op === 'deshadow') built = removeShadowGraph({ image, objectInfo, strength: job.strength });
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
    const endSubmission = vram.beginComfySubmission();
    let unloaded;
    try { assertMemoryAvailable(); unloaded = await vram.releaseLlm(); }
    catch (e) { endSubmission(); return sendJson(res, { success: false, error: e.message }, e.statusCode || 503); }
    /* The music engine too, when it has been sitting on the card doing nothing.
       A minute's grace, so a song still being polled is never pulled out from
       under itself -- see `touch` in server/engines.js. Eight gigabytes of VRAM
       this job would otherwise have to do without. */
    await engines.stopIfIdle('ace-step', 60000).catch(() => {});
    // Listening before it is queued -- see `open` in server/comfyEvents.js.
    events.open();
    try {
      const queued = await withTimeout(`${base}/prompt`, {
        method: 'POST',
        body: { prompt: built.prompt, client_id: CLIENT_ID },
        timeout: 30000,
      });
      const refused = nodeErrorsText(queued);
      if (!queued?.prompt_id || refused) {
        if (queued?.prompt_id) await withdraw(base, queued.prompt_id);
        const detail = queued?.error?.message || queued?.error
          || (queued?.prompt_id ? 'ComfyUI refused part of the job' : 'ComfyUI refused the job');
        return sendJson(res, { success: false, error: refused ? `${detail} (${refused})` : String(detail) }, 400);
      }
      vram.comfyUsed();
      // So the progress card can name what it is doing, as for a generation.
      events.register(queued.prompt_id, {
        total: Object.keys(built.prompt).length,
        nodes: Object.fromEntries(Object.entries(built.prompt)
          .map(([id, node]) => [id, { class: node.class_type, title: node._meta?.title || '' }])),
        profile: [`op:${job.op}${job.factor ? `x${job.factor}` : ''}`, `op:${job.op}`],
      });
      const accepted = {
        success: true,
        id: queued.prompt_id,
        op: job.op,
        ...(built.factor ? { factor: built.factor } : {}),
        ...(unloaded.length ? { unloaded } : {}),
      };
      rememberSubmit(job.requestId, accepted);
      // Watchable from another device on the same terms as a generation: in a
      // conversation this blocks the answer exactly as drawing one does.
      rememberLiveJob({
        id: queued.prompt_id,
        owner: identify(req),
        chat: job.chat,
        kind: 'edit',
        prompt: job.prompt || job.op || '',
        model: job.op || '',
      });
      sendJson(res, accepted);
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    } finally { endSubmission(); }
  });

  /* ---------------------------------------------------- teaching it a face

     Two routes, because two different things can be wrong before a run and
     they have different fixes: `/studio/train/state` is asked first and says
     whether the pack is installed and whether the daemon is up, and
     `/studio/train` queues the run. See server/training.js for why this is a
     LoRA and not a reference image, and for the daemon.

     The pictures do not come through here. The browser uploads them, and the
     caption beside each one, through `/studio/upload` into a subfolder of
     ComfyUI's `input/` -- the same road every reference picture already
     takes, and the only one that does not assume this server and ComfyUI
     share a disk. */

  route('/studio/train/state', async (req, res) => {
    let installed = null;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return sendJson(res, { ...offline(base, e), can: false });
    }
    const objectInfo = installed.objectInfo || {};
    const missing = TRAIN_NODES.filter(cls => !objectInfo[cls]);

    /* The daemon is a separate process from ComfyUI and can be down while
       ComfyUI is fine, which is the usual case: it is started by hand from the
       anima_lora checkout and does not come back with the machine. Asked here
       rather than discovered by the node minutes into a run, where the message
       goes to ComfyUI's console and nowhere a reader will see it. */
    const daemon = await daemonState(daemonBase(env), (url) => withTimeout(url, { timeout: 4000 }));

    sendJson(res, {
      success: true,
      can: missing.length === 0 && daemon.running,
      missing,
      pack: TRAIN_PACK,
      daemon,
      /* What the form offers. The bases are the DiT checkpoints this ComfyUI
         has, with the one the Anima workflow actually draws with first --
         a LoRA belongs to the base it was trained on, and training against a
         different one is a slow way to make every picture slightly worse. */
      bases: installed.diffusion_models || [],
      base: (installed.diffusion_models || []).includes(TRAIN_BASE) ? TRAIN_BASE : '',
      tiers: GPU_TIERS,
      presets: PRESETS,
      dials: DIALS,
      images: { min: MIN_IMAGES, max: MAX_IMAGES },
    });
  });

  /* What this run will be called, before anything is uploaded.

     The browser has to put the pictures into the folder the graph will name,
     and the rule that turns a typed name into a folder is not trivial -- a
     name typed in Korean slugs to nothing, and a file called `.safetensors`
     is not a file. Written once, here, and handed out, rather than
     implemented again in the browser where the two can drift apart and the
     symptom is "the pictures did not reach ComfyUI". */
  route('/studio/train/prepare', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, { success: false, error: 'A name is required' }, 400);
    const id = slugify(name) || `set-${Date.now().toString(36)}`;
    sendJson(res, { success: true, id, dataset: datasetFolder(id), saveAs: `webui-${id}` });
  });

  route('/studio/train', async (req, res) => {
    let job;
    try { job = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    const name = String(job.name || '').trim();
    if (!name) return sendJson(res, { success: false, error: 'A name is required' }, 400);

    const count = Number(job.images) || 0;
    if (count < MIN_IMAGES) return sendJson(res, { success: false, error: 'There are no pictures to learn from' }, 400);
    if (count > MAX_IMAGES) {
      return sendJson(res, { success: false, error: `At most ${MAX_IMAGES} pictures` }, 400);
    }

    const already = recallSubmit(job.requestId);
    if (already) return sendJson(res, { ...already, repeated: true });

    /* The folder the browser has just filled, and the name the LoRA will be
       saved under. Both derived from the same id rather than from the typed
       name, because a name typed in Korean slugs to nothing at all -- and a
       file called `.safetensors` is not a file. */
    const slug = slugify(job.id || name) || `set-${Date.now().toString(36)}`;
    const dataset = datasetFolder(slug);
    const saveAs = `webui-${slug}`;

    const daemon = await daemonState(daemonBase(env), (url) => withTimeout(url, { timeout: 4000 }));
    if (!daemon.running) {
      return sendJson(res, {
        success: false,
        daemon,
        error: 'The Anima training daemon is not running, so there is nothing to train on. '
          + 'Start it from the anima_lora checkout (`python tasks.py daemon`), then try again.',
      }, 503);
    }

    let installed;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return sendJson(res, offline(base, e), 502);
    }

    const built = trainGraph({
      dataset,
      saveAs,
      objectInfo: installed.objectInfo || {},
      base: job.base || TRAIN_BASE,
      rank: clampDial(job.rank, DIALS.rank, PRESETS.character.rank),
      epochs: clampDial(job.epochs, DIALS.epochs, PRESETS.character.epochs),
      lr: clampDial(job.lr, DIALS.lr, PRESETS.character.lr),
      gpu: job.gpu,
    });

    if (built.missing) {
      return sendJson(res, {
        success: false,
        missing: built.missing,
        error: `This ComfyUI is missing ${built.missing.join(', ')} (${TRAIN_PACK}).`,
      }, 400);
    }
    if (built.noDataset) {
      /* The node picks its dataset from a list of the folders under ComfyUI's
         `input/`, and ComfyUI refuses a graph naming one that is not in it. So
         an absent folder means the uploads did not land, which is worth saying
         as that rather than as a dropdown validation error. */
      return sendJson(res, {
        success: false,
        error: `The pictures did not reach ComfyUI: it has no input folder called ${built.noDataset}.`,
      }, 400);
    }

    /* Everything else off the card. Training holds a DiT plus its optimiser
       state, which is the largest thing this app ever asks the machine for --
       larger than a generation, because a generation does not need gradients. */
    const endSubmission = vram.beginComfySubmission();
    let unloaded;
    try { assertMemoryAvailable(); unloaded = await vram.releaseLlm(); }
    catch (e) { endSubmission(); return sendJson(res, { success: false, error: e.message }, e.statusCode || 503); }
    /* The music engine too, when it has been sitting on the card doing nothing.
       A minute's grace, so a song still being polled is never pulled out from
       under itself -- see `touch` in server/engines.js. Eight gigabytes of VRAM
       this job would otherwise have to do without. */
    await engines.stopIfIdle('ace-step', 60000).catch(() => {});
    events.open();
    try {
      const queued = await withTimeout(`${base}/prompt`, {
        method: 'POST',
        body: { prompt: built.prompt, client_id: CLIENT_ID },
        timeout: 30000,
      });
      const refused = nodeErrorsText(queued);
      if (!queued?.prompt_id || refused) {
        if (queued?.prompt_id) await withdraw(base, queued.prompt_id);
        const detail = queued?.error?.message || queued?.error || 'ComfyUI refused the training job';
        return sendJson(res, { success: false, error: refused ? `${detail} (${refused})` : String(detail) }, 400);
      }
      vram.comfyUsed();
      events.register(queued.prompt_id, {
        total: Object.keys(built.prompt).length,
        nodes: Object.fromEntries(Object.entries(built.prompt)
          .map(([id, node]) => [id, { class: node.class_type, title: node._meta?.title || '' }])),
        /* Timed against runs of the same shape. Epochs times pictures is what
           a run costs, near enough, and it is the only pair of numbers that
           makes one run's duration predict another's. */
        profile: [`train:${job.epochs || '?'}e x${count}`, 'train'],
      });
      const accepted = {
        success: true,
        id: queued.prompt_id,
        dataset,
        saveAs,
        lora: `${saveAs}.safetensors`,
        ...(unloaded.length ? { unloaded } : {}),
      };
      rememberSubmit(job.requestId, accepted);
      sendJson(res, accepted);
    } catch (e) {
      sendJson(res, offline(base, e), 502);
    } finally { endSubmission(); }
  });

  /* What a finished run left behind.

     The LoRA is written by the trainer straight into ComfyUI's own
     `models/loras`, so there is no file to fetch and nothing to move -- but
     the Studio's slots offer whatever that folder holds *as ComfyUI lists it*,
     and only ComfyUI can say what that is. Asked here so the browser can put
     the new character into its library under the name the pickers will use,
     rather than guessing at the separator and the casing. */
  route('/studio/train/result', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const saveAs = url.searchParams.get('saveAs') || '';
    if (!saveAs) return sendJson(res, { success: false, error: 'A name is required' }, 400);
    try {
      const installed = await listInstalled(base, (url2) => withTimeout(url2, { timeout: 20000 }));
      const lora = findLora(installed.loras || [], saveAs);
      sendJson(res, { success: true, lora, ready: !!lora });
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

    /* A long clip is several ComfyUI prompts under one id of this app's. */
    if (isLongId(id)) {
      const long = longVideos.status(id);
      if (!long) return sendJson(res, { success: true, state: 'unknown' });
      if (long.state === 'failed') return sendJson(res, { success: true, state: 'failed', error: long.error });
      if (long.state === 'done') {
        return sendJson(res, {
          success: true,
          state: 'done',
          outputs: [{ ...long.output, url: `/studio/view?${viewQuery(long.output)}` }],
        });
      }
      if (long.current) events.nudge(long.current);
      return sendJson(res, {
        success: true, state: 'running', segment: long.segment, segments: long.segments, phase: long.phase,
      });
    }

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
          forgetLiveJob(id);
          return sendJson(res, { success: true, state: 'failed', error: message || 'The workflow failed in ComfyUI' });
        }
        const outputs = outputsOf(entry);
        // A tagger's answer is text, not a file, and is just as much a result.
        const texts = textsOf(entry);
        if (outputs.length > 0 || texts.length > 0) {
          /* Finished, so it is no longer something another device should be
             offered a progress bar for -- what happens to it now is the
             conversation's, and that travels by sync. And the reader is told,
             if they asked to be: this is where a finished picture is first
             known about, and the device doing the polling need not be the
             device the notification is for. See server/push.js. */
          const finished = describeQueued(identify(req), id);
          forgetLiveJob(id);
          if (finished) {
            noteFinished(identify(req), finished.kind || 'image');
            sendPush(identify(req)).catch(() => {});
          }
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
      // The queue is the word on whether it has started; the progress stream
      // is told, and replaces its socket if it has missed it. See `nudge`.
      if (where.state === 'running') events.nudge(id);
      if (where.state === 'gone') {
        forgetLiveJob(id);
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

  /* A long clip's storyboard: each segment's prompt and how far it has got.
     Only for the account that made it -- the prompts are what was asked for. */
  const ownLong = (req, id) => {
    const info = longVideos.info(id);
    const owner = longVideos.ownerOf(id);
    return info && owner === identify(req) ? info : null;
  };
  route('/studio/long-info', (req, res) => {
    const id = new URL(req.url, 'http://placeholder').searchParams.get('id') || '';
    const info = isLongId(id) ? ownLong(req, id) : null;
    if (!info) return sendJson(res, { success: false, error: 'Not found' }, 404);
    const status = longVideos.status(id) || {};
    sendJson(res, {
      success: true,
      ...info,
      segment: status.segment || null,
      ...(status.output ? { output: { ...status.output, url: `/studio/view?${viewQuery(status.output)}` } } : {}),
      ...(status.redoError ? { redoError: status.redoError } : {}),
    });
  });

  /* A segment not yet started, rewritten while the ones before it render. */
  route('/studio/long-prompt', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }
    const id = String(body.id || '');
    if (!isLongId(id) || !ownLong(req, id)) return sendJson(res, { success: false, error: 'Not found' }, 404);
    const ok = longVideos.setPrompt(id, Number(body.segment), body.prompt);
    sendJson(res, ok ? { success: true } : { success: false, error: 'That segment has already started.' }, ok ? 200 : 409);
  });

  /* One segment drawn again, and the clip joined again. */
  route('/studio/long-redo', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }
    const id = String(body.id || '');
    if (!isLongId(id) || !ownLong(req, id)) return sendJson(res, { success: false, error: 'Not found' }, 404);
    const done = longVideos.redo(id, Number(body.segment), {
      prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
      following: !!body.following,
    });
    sendJson(res, done.ok ? { success: true, ...done } : { success: false, error: done.error }, done.ok ? 200 : 409);
  });

  /* What is being made for one conversation, whoever started it.
   *
   * The device that queued a job knows its id and watches it. Every *other*
   * device the reader owns knew only that an answer was being written, and
   * showed the three dots that mean "thinking" for the whole of a two-minute
   * picture. This is the one fact they were missing, and with it they can open
   * `/studio/events` like any other watcher. See LIVE_JOBS.
   *
   * Answered for the account that asks and for a chat id it already has, and
   * with nothing when there is nothing running -- a phone polls this while a
   * conversation is open, so "no" is the common answer and it is a small one. */
  route('/studio/live', (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const chat = url.searchParams.get('chat') || '';
    if (!chat) return sendJson(res, { success: false, error: 'A chat is required' }, 400);
    sendJson(res, { success: true, jobs: liveJobsFor(identify(req), chat) });
  });

  /* Everything ComfyUI has been asked to do, in the order it will do it.
   *
   * The panel has always known about the jobs *this browser* started. It knew
   * nothing about the picture the chat is drawing, nothing about what another
   * device queued, and nothing about the order -- only a count of how many were
   * in front, on the card of the one job it was watching. So "what is the
   * machine doing and what is it going to do next" had no answer anywhere, and
   * the only cancel that could be trusted was the one that stopped everything.
   *
   * ComfyUI's queue is the list; `describeQueued` is what turns an id into a
   * line worth reading, and it answers only for the account that queued it.
   * Somebody else's job still appears -- it is in front of yours, which is the
   * fact that matters -- with nothing said about what it is. */
  route('/studio/queue', async (req, res) => {
    const owner = identify(req);
    try {
      const queue = await withTimeout(`${base}/queue`, { timeout: 15000 });
      const idsOf = (key) => (queue?.[key] || []).map(item => item?.[1]).filter(Boolean);
      const running = idsOf('queue_running');
      const describe = (id, state, ahead) => {
        const known = describeQueued(owner, id);
        return { id, state, ahead, mine: !!known, ...(known || {}) };
      };
      sendJson(res, {
        success: true,
        jobs: [
          ...running.map(id => describe(id, 'running', 0)),
          ...idsOf('queue_pending').map((id, index) => describe(id, 'queued', index + running.length)),
        ],
      });
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
    const snapshot = (job) => {
      /* Against earlier runs of the same workflow where there are any -- see
         server/studioTimings.js -- and by counting nodes where there are not. */
      const learned = events.estimate(job);
      const placed = typeof learned?.fraction === 'number';
      return {
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
        // How long a step is taking, for the card's speed. See `reduce`.
        stepMs: job.stepMs || null,
        nodesDone: job.done.length,
        nodesTotal: job.total,
        cached: job.cached,
        fraction: placed ? learned.fraction : fractionOf(job),
        // How long it has left, as of this message, and how long it usually takes.
        remainingMs: placed ? learned.remainingMs : null,
        expectedMs: learned?.expectedMs ?? null,
        learned: placed,
        previewSeq: job.previewSeq,
        // A clip is drawn with <video>, a frame with <img>; the URL cannot say which.
        previewMime: job.previewMime,
        startedAt: job.startedAt,
        error: job.error,
        errorNode: job.errorNode,
        errorPhase: job.errorPhase,
      };
    };
    const send = (job) => write(`data: ${JSON.stringify(isLongId(id) ? asLong(id, snapshot(job), null, longVideos) : snapshot(job))}\n\n`);

    write(': connected\n\nretry: 3000\n\n');
    // Whatever is already known, before waiting for the next change -- a job
    // half done when the page was opened should not look like one that has not
    // started.
    /* A long clip's progress is its current segment's. The prompt changes
       every few minutes, so it is looked up on every message rather than once. */
    const target = () => (isLongId(id) ? longVideos.currentOf(id) : id);
    const known = target() && events.get(target());
    if (known) send(known);

    const stop = events.subscribe((job) => {
      if (job.id !== target()) return;
      if (!send(job)) close();
    });

    // ComfyUI goes quiet during a model load, which on a cold 20GB checkpoint
    // is a minute of nothing. Without this the browser gives up on a stream
    // that is working perfectly.
    const beat = setInterval(() => { if (!write(': ping\n\n')) close(); }, 15000);
    beat.unref?.();

    /* A long node with no steps -- a decoder, a text encoder writing out a
       prompt -- says nothing for a minute, but against earlier runs it is still
       getting somewhere, so where it has got to is sent again every so often. */
    const tick = setInterval(() => {
      /* A long clip between segments, joining, or finished: there is no
         ComfyUI prompt to hear from, so the clip's own state is sent. */
      if (isLongId(id) && !target()) {
        const long = longVideos.status(id);
        const payload = longSnapshot(id, long);
        if (payload && !write(`data: ${JSON.stringify(payload)}\n\n`)) return close();
        if (!long || long.state === 'done' || long.state === 'failed') close();
        return;
      }
      const job = target() && events.get(target());
      if (job?.state === 'running' && job.profile?.length && !send(job)) close();
    }, 2000);
    tick.unref?.();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      clearInterval(tick);
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
    const asked = url.searchParams.get('id');
    // A long clip's frame is its current segment's.
    const frame = events.preview(isLongId(asked) ? longVideos.currentOf(asked) : asked);
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

  /* The chat's Anima guide uses the same CSV, but only tags carried by more
     than a thousand posts. This is intentionally separate from autocomplete:
     it returns the full candidate vocabulary so the LLM, not this app, chooses
     the character design. */
  route('/studio/design-tags', async (req, res) => {
    const index = loadTags();
    if (!index.size) {
      return sendJson(res, {
        success: false,
        error: 'No tag list: assets/danbooru-tags.csv is missing or unreadable.',
        tags: [],
      });
    }
    sendJson(res, { success: true, minimum: 1000, total: index.size, tags: tagsAboveCount(index, 1000) });
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

    const apis = apiUrlsFor(post);
    if (!apis.length) return sendJson(res, { success: false, error: `Unsupported site: ${post.host}` }, 400);

    try {
      /* Every address this post has, in order, stopping at the first that
         answers. For danbooru that is the main host and then its own mirrors,
         which carry the same database under hostnames this network has not
         blocked -- see `DANBOORU_MIRRORS`. For everything else it is one
         address and this loop runs once.

         A refused connection moves to the next; an *answer* does not, however
         unwelcome. A 404 from the first host is the real answer about that
         post id, and asking a mirror the same question would only produce the
         same 404 more slowly. */
      let upstream = null;
      let reached = null;
      let refusal = null;
      for (const api of apis) {
        try {
          // eslint-disable-next-line no-await-in-loop
          upstream = await fetch(api, {
            headers: {
              /* Danbooru refuses the default `node` agent outright, and the
                 others rate-limit it harder. Naming the app is what their
                 terms ask for. */
              'User-Agent': 'ollama-webui/1.0 (personal, self-hosted)',
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(15000),
          });
          reached = new URL(api).hostname;
          break;
        } catch (e) {
          refusal = e;
        }
      }
      // Nothing answered at all. Reported by the outer catch, which knows how
      // to say "blocked" rather than "fetch failed".
      if (!upstream) throw refusal || new Error('no route to that site');

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
        // Which host actually answered. Worth reporting: on a network where
        // the main one is blocked, this is the difference between "it works
        // now" and "it works now and I do not know why".
        ...(reached && reached !== post.host ? { via: reached } : {}),
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
          : `Could not reach ${post.host}${apis.length > 1 ? ' or its mirrors' : ''} — `
            + `it may be blocked on this network. A safebooru.org link usually works. (${e.message})`,
      }, 502);
    }
  });

  route('/studio/view', async (req, res) => {
    const url = new URL(req.url, 'http://placeholder');
    const filename = url.searchParams.get('filename');
    if (!filename) return sendJson(res, { success: false, error: 'A filename is required' }, 400);

    /* A long clip joined here rather than written by ComfyUI. Served with
       ranges, because it can be hundreds of megabytes and a <video> seeks. */
    if (url.searchParams.get('type') === 'webui') {
      const file = longVideos.fileFor(filename);
      if (!file) return sendJson(res, { success: false, error: 'Not found' }, 404);
      return serveFile(req, res, file, 'video/mp4');
    }

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

    const local = () => {
      // A remote engine must never accidentally resolve a same-named local file.
      if (!isLocalAddress(base)) return false;
      const found = localStudioFile(query, env);
      if (!found) return false;
      serveFile(req, res, found.file, found.mime);
      return true;
    };
    try {
      const upstream = await withTimeout(`${base}/view?${query}`, { timeout: 60000, raw: true });
      if (!upstream.ok && local()) return;
      if (!upstream.ok) return sendJson(res, { success: false, error: `ComfyUI HTTP ${upstream.status}` }, upstream.status);

      res.statusCode = 200;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      // Saved files are immutable: the name carries a counter, so the same URL
      // is the same bytes for ever. Temp files are not -- ComfyUI empties that
      // folder when it starts -- so a browser keeping one for a year keeps a
      // picture the file no longer is.
      res.setHeader('Cache-Control', query.get('type') === 'temp'
        ? 'no-cache'
        : 'private, max-age=31536000, immutable');

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      if (!res.headersSent && local()) return;
      if (!res.headersSent) sendJson(res, offline(base, e), 502);
      else res.end();
    }
  });

  /* One shared picture, to anybody holding the link.
   *
   * Here rather than beside the other `/api/share` routes because this is the
   * only file in the app that knows how to fetch bytes out of ComfyUI, and a
   * second copy of that proxy would be a second place for the streaming, the
   * content type and the cache headers to drift.
   *
   * The share row names the file; the token is the only way to reach it. That
   * is what makes revoking a link mean something: the page and the picture
   * both stop answering, rather than the page going away while the image URL
   * it pointed at carries on working. A wrong, revoked or expired token gets
   * the same 404 as a made-up one.
   *
   * No session, deliberately. A person given a link has an account somewhere
   * else or none at all. */
  route('/api/share/image', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, { success: false, error: 'GET required.' }, 405);
    const asked = new URL(req.url, 'http://placeholder');
    const shared = readShare(asked.searchParams.get('token') || '');
    if (!shared || shared.kind !== 'picture' || !shared.file) {
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, { success: false, error: 'That link is not available.' }, 404);
    }

    const query = new URLSearchParams({
      filename: shared.file.filename,
      subfolder: shared.file.subfolder || '',
      type: shared.file.type || 'output',
    });
    // The same lighter copy the gallery asks for, so a phone opening a link
    // does not pull eleven megabytes to look at one picture.
    const preview = asked.searchParams.get('preview') || '';
    if (/^(webp|jpeg);\d{1,3}$/.test(preview)) query.set('preview', preview);

    try {
      const upstream = await withTimeout(`${base}/view?${query}`, { timeout: 60000, raw: true });
      if (!upstream.ok) return sendJson(res, { success: false, error: 'That picture is no longer here.' }, 404);
      res.statusCode = 200;
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      /* Not cached publicly and not for long: a link that has been revoked
         must stop working everywhere, and a copy sitting in a proxy for a year
         is exactly the thing revocation is supposed to reach. */
      res.setHeader('Cache-Control', 'private, max-age=300');
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
          /* And the parts, unjoined. `/studio/picture-tags` validates a
             filename and a subfolder separately -- because a `..` in either is
             a way out of ComfyUI's folders -- so a caller that wants the
             tagger pointed at what it just uploaded would otherwise have to
             take this string apart again and guess which slash was which. */
          filename: data.name,
          subfolder: data.subfolder || '',
          type: data.type || 'input',
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
  /* ------------------------------------------------ what is in a video

     The tags of a finished video, a list per frame, for the safeguard to judge
     it by -- see `videoTagGraph`. Kept per file (see server/videoTags.js), and
     one run per file however many cards ask at once. */
  const videoTags = createVideoTagCache({ file: path.join(DATA_DIR, 'video-tags.json') });
  const tagging = new Map();

  const tagVideo = async (file, duration) => {
    let installed;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return { status: 502, body: offline(base, e) };
    }
    const built = videoTagGraph({ video: file.annotated, objectInfo: installed.objectInfo || {}, duration });
    if (built.missing) {
      return { status: 400, body: { success: false, missing: built.missing, error: `This ComfyUI is missing ${built.missing.join(', ')}.` } };
    }
    const queued = await withTimeout(`${base}/prompt`, { method: 'POST', body: { prompt: built.prompt, client_id: CLIENT_ID }, timeout: 30000 });
    /* A graph ComfyUI accepts with a branch left out is worse here than one it
       refuses outright: the job runs, finishes, and reports no tags -- which is
       indistinguishable from a picture with nothing in it, and the safeguard
       treats the tagger as the authority once it has read the file. So a
       half-accepted graph is refused and taken back out of the queue. */
    const refused = nodeErrorsText(queued);
    if (!queued?.prompt_id || refused) {
      if (queued?.prompt_id) await withdraw(base, queued.prompt_id);
      const detail = queued?.error?.message || 'ComfyUI refused the tagging job';
      return { status: 400, body: { success: false, error: refused ? `${detail} (${refused})` : String(detail) } };
    }
    /* Waited for here. It is seconds of work, but it can be queued behind a
       video that is minutes of it, and the card asking is content to wait. */
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const history = await withTimeout(`${base}/history/${encodeURIComponent(queued.prompt_id)}`, { timeout: 15000 }).catch(() => null);
      const entry = history?.[queued.prompt_id];
      if (!entry) continue;
      if (entry.status?.status_str === 'error' || entry.status?.completed === false) {
        const message = (entry.status?.messages || []).find(m => m?.[0] === 'execution_error')?.[1]?.exception_message;
        return { status: 502, body: { success: false, error: message || 'Tagging failed in ComfyUI' } };
      }
      if (entry.status?.completed) {
        const frames = textsOf(entry);
        const kept = videoTags.set(file.key, frames);
        return { status: 200, body: { success: true, frames: kept.frames } };
      }
    }
    return { status: 504, body: { success: false, error: 'Tagging did not finish in time' } };
  };

  /* ------------------------------------------------ what is in a picture

     The same question about a still, and the same answer: the tagger.

     A picture had two witnesses -- the prompt, and a 224-pixel MobileNet in
     the browser -- and both can miss. The prompt knows only what was asked
     for; "1girl, beach, sitting" is an ordinary prompt and the picture it
     produced is whatever the model produced. The classifier is a general
     photographic model reading a drawing, and on illustration it is guessing.

     WD14 is not guessing. It was trained on this exact vocabulary and names
     what it sees in the same words a prompt is written in -- so `nude` from
     the tagger means what `nude` in a prompt means, and the lists in
     safeguard.js judge both. One picture, one frame, and `verdictFromFrames`
     cannot tell the difference. */
  const pictureTags = createVideoTagCache({ file: path.join(DATA_DIR, 'picture-tags.json') });

  const tagPicture = async (file) => {
    let installed;
    try {
      installed = await listInstalled(base, (url) => withTimeout(url, { timeout: 20000 }));
    } catch (e) {
      return { status: 502, body: offline(base, e) };
    }
    const built = tagGraph({ image: file.annotated, objectInfo: installed.objectInfo || {} });
    if (built.missing) {
      return { status: 400, body: { success: false, missing: built.missing, error: `This ComfyUI is missing ${built.missing.join(', ')}.` } };
    }
    const queued = await withTimeout(`${base}/prompt`, { method: 'POST', body: { prompt: built.prompt, client_id: CLIENT_ID }, timeout: 30000 });
    /* A graph ComfyUI accepts with a branch left out is worse here than one it
       refuses outright: the job runs, finishes, and reports no tags -- which is
       indistinguishable from a picture with nothing in it, and the safeguard
       treats the tagger as the authority once it has read the file. So a
       half-accepted graph is refused and taken back out of the queue. */
    const refused = nodeErrorsText(queued);
    if (!queued?.prompt_id || refused) {
      if (queued?.prompt_id) await withdraw(base, queued.prompt_id);
      const detail = queued?.error?.message || 'ComfyUI refused the tagging job';
      return { status: 400, body: { success: false, error: refused ? `${detail} (${refused})` : String(detail) } };
    }
    /* Waited for, as the video one is. Tagging a still is under a second of
       work, but it can be queued behind a generation that is minutes of it. */
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const history = await withTimeout(`${base}/history/${encodeURIComponent(queued.prompt_id)}`, { timeout: 15000 }).catch(() => null);
      const entry = history?.[queued.prompt_id];
      if (!entry) continue;
      if (entry.status?.status_str === 'error' || entry.status?.completed === false) {
        const message = (entry.status?.messages || []).find(m => m?.[0] === 'execution_error')?.[1]?.exception_message;
        return { status: 502, body: { success: false, error: message || 'Tagging failed in ComfyUI' } };
      }
      if (entry.status?.completed) {
        // A list of one: the same shape a video's frames come back in.
        const frames = textsOf(entry).slice(0, 1);
        const kept = pictureTags.set(file.key, frames);
        return { status: 200, body: { success: true, frames: kept.frames } };
      }
    }
    return { status: 504, body: { success: false, error: 'Tagging did not finish in time' } };
  };

  route('/studio/picture-tags', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }
    const file = pictureFile(body);
    if (!file) return sendJson(res, { success: false, error: 'Not a picture ComfyUI made' }, 400);

    const known = pictureTags.get(file.key);
    if (known) return sendJson(res, { success: true, frames: known.frames, cached: true });

    // One run per file however many cards ask at once -- a gallery scrolling
    // past twenty copies of the same picture is one tagging job, not twenty.
    if (!tagging.has(file.key)) {
      tagging.set(file.key, tagPicture(file)
        .catch(e => ({ status: 502, body: offline(base, e) }))
        .finally(() => tagging.delete(file.key)));
    }
    const answer = await tagging.get(file.key);
    sendJson(res, answer.body, answer.status);
  });

  route('/studio/video-tags', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    /* A long clip was joined here, and ComfyUI's tagger opens files by ComfyUI's
       own names -- so it reads the segments ComfyUI kept, which are the same
       frames. At most twenty of them, spread over the clip: a ten-minute clip
       is sixty segments and sixty tagging jobs is minutes of card time for a
       check that twenty answer. */
    if (body.type === 'webui') {
      const segments = longVideos.segmentsOf(body.filename);
      if (!segments.length) return sendJson(res, { success: false, error: 'Not a video this app joined' }, 400);
      const step = Math.max(1, segments.length / 20);
      const picked = [];
      for (let at = 0; at < segments.length && picked.length < 20; at += step) picked.push(segments[Math.floor(at)]);
      const each = (Number(body.duration) || 0) / segments.length;
      const frames = [];
      for (const segment of picked) {
        const file = videoFile(segment);
        if (!file) continue;
        const known = videoTags.get(file.key);
        const answer = known
          ? { status: 200, body: { success: true, frames: known.frames } }
          : await tagVideo(file, each).catch(e => ({ status: 502, body: offline(base, e) }));
        if (answer.status !== 200 || !answer.body?.success) return sendJson(res, answer.body, answer.status);
        frames.push(...(answer.body.frames || []));
      }
      return sendJson(res, { success: true, frames });
    }

    const file = videoFile(body);
    if (!file) return sendJson(res, { success: false, error: 'Not a video ComfyUI made' }, 400);

    const known = videoTags.get(file.key);
    if (known) return sendJson(res, { success: true, frames: known.frames, cached: true });

    if (!tagging.has(file.key)) {
      tagging.set(file.key, tagVideo(file, Number(body.duration) || 0)
        .catch(e => ({ status: 502, body: offline(base, e) }))
        .finally(() => tagging.delete(file.key)));
    }
    const { status, body: answer } = await tagging.get(file.key);
    sendJson(res, answer, status);
  });

  /* The picture and video models in memory, for the list of loaded models
     beside Ollama's. See `comfyResident`. A ComfyUI that is not running holds
     nothing, which is an empty list rather than an error. */
  route('/studio/loaded', async (req, res) => {
    const report = await withTimeout(`${base}/webui/loaded`, { timeout: 4000 }).catch(() => null);
    const stats = report ? null : await withTimeout(`${base}/system_stats`, { timeout: 4000 }).catch(() => null);
    sendJson(res, {
      models: comfyResident(report, stats),
      exact: !!report,
      // What ComfyUI keeps back for other programs; the progress card warns
      // when it is far past ComfyUI's own figure. See comfyui/ollama_webui_memory.
      ...(Number.isFinite(report?.reserved) ? { reserved: report.reserved } : {}),
    });
  });

  route('/studio/cancel', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    let id = body.id ? String(body.id) : '';
    const all = !!body.all;
    /* A long clip: stop queuing segments, and stop the one that is drawing. */
    if (isLongId(id)) {
      forgetLiveJob(id);
      id = longVideos.cancel(id) || id;
    }
    if (all) for (const running of longVideos.running()) longVideos.cancel(running);
    // Stopped is stopped on every device: a card still counting up on a phone
    // for a job somebody cancelled on the desktop is the worse kind of wrong.
    if (all) forgetLiveJobs(); else forgetLiveJob(id);
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
