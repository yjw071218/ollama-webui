/**
 * The Studio's smaller decisions, apart from the component so they can be
 * tested without a DOM: which shape a ratio button makes, what a
 * post-processing job looks like, which results the viewer walks through, how
 * big the cards are, and which jobs have just finished.
 */

import { parseAspect, sizeForAspect } from './pictureTools.js';

/* ------------------------------------------------------------- the shape

   Two number boxes are the right control for "exactly 904×1160" and the wrong
   one for "the same picture, but portrait": that is arithmetic nobody should
   have to do. A ratio keeps the pixel count the workflow is already set to --
   which is what its speed and its memory are measured in -- and changes only
   the shape. */

export const ASPECT_PRESETS = ['1:1', '4:5', '3:4', '2:3', '9:16', '4:3', '3:2', '16:9'];

/** Width and height for a ratio at the current pixel count, on the latent grid. */
export const presetSize = (preset, width, height, step = 16) => {
  const ratio = parseAspect(preset);
  if (!ratio) return null;
  const area = Math.max(256 * 256, (Number(width) || 1024) * (Number(height) || 1024));
  return sizeForAspect(ratio, area, step);
};

/** Which preset a size already is, within rounding; '' for none. */
export const matchPreset = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0)) return '';
  const actual = w / h;
  return ASPECT_PRESETS.find((preset) => {
    const { w: rw, h: rh } = parseAspect(preset);
    /* Three percent, not two: the sizes these models are trained at are
       buckets on a 64-pixel grid, and Anima's own 832×1216 -- which everybody
       calls 2:3 -- is 2.6% off it. The nearest two presets are 6% apart, so
       nothing matches twice. */
    return Math.abs(actual / (rw / rh) - 1) < 0.03;
  }) || '';
};

/** A ratio's outline fitted into a `box`-pixel square, for the button that picks it. */
export const ratioGlyph = (preset, box = 22) => {
  const ratio = parseAspect(preset);
  if (!ratio) return { width: box, height: box };
  const r = ratio.w / ratio.h;
  return r >= 1
    ? { width: box, height: Math.round(box / r) }
    : { width: Math.round(box * r), height: box };
};

/** Megapixels, as the one number that says how heavy a size is. */
export const megapixels = (width, height) => {
  const mp = ((Number(width) || 0) * (Number(height) || 0)) / 1e6;
  return mp >= 10 ? mp.toFixed(1) : mp.toFixed(2);
};

/** `"1024×1360"` (or `x`) as numbers; null for anything else. */
export const parseJobSize = (size) => {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(String(size || ''));
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

/* ------------------------------------------------- after it is made

   Enlarging a picture and cutting it out were things only the chat could ask
   for, in words, of a picture already in the conversation. The Studio is
   where the pictures are, so they are one press away here too -- and each
   result is a card of its own beside the picture it came from, not a
   replacement for it. */

export const OPS = ['upscale', 'rmbg'];
const FACTOR = { upscale: 2, rmbg: 1 };

/** The picture a job made, as opposed to a film it made. */
export const pictureOutput = (job) => {
  const outputs = Array.isArray(job?.outputs) ? job.outputs : [];
  // Older history entries did not record media, but a missing field should
  // not make an otherwise valid saved image disappear after an upgrade.
  return outputs.find(o => o?.media === 'image')
    || outputs.find(o => o && o.media !== 'video' && o.media !== 'audio')
    || null;
};

/** What `/studio/op` is sent for a job's picture, already uploaded as `image`. */
export const opRequest = (job, op, image, requestId) => {
  const size = parseJobSize(job?.size);
  return {
    op,
    image,
    ...(op === 'upscale' ? { factor: FACTOR.upscale } : {}),
    // The server refuses an enlargement that would not fit in a page before
    // it is queued, and needs the size to know.
    ...(size || {}),
    requestId,
  };
};

/**
 * The card for a post-processing job, before ComfyUI has answered. It keeps
 * the prompt and settings of the picture it came from, so reusing it or
 * searching for it works as it would for that picture.
 */
export const opJobFrom = (job, op, { id, label, now = Date.now() }) => {
  const size = parseJobSize(job?.size);
  const factor = FACTOR[op] || 1;
  // What an upscale is compared against: the picture it enlarged.
  const source = op === 'upscale' ? mainOutput(job) : null;
  return {
    ...(source?.media === 'image' && source.url ? { before: source.url } : {}),
    id,
    state: 'queued',
    op,
    parent: job?.id,
    prompt: job?.prompt || '',
    ...(job?.negative ? { negative: job.negative } : {}),
    ...(job?.parts ? { parts: job.parts } : {}),
    model: job?.model,
    modelLabel: label,
    kind: 'image',
    size: size ? `${size.width * factor}×${size.height * factor}` : job?.size,
    ...(job?.seed !== undefined ? { seed: job.seed } : {}),
    startedAt: now,
  };
};

/* -------------------------------------------------------- the viewer

   A film used to be left out of the viewer, so the arrows skipped every video
   and a video could only be watched at card size. Now each finished job is
   viewed by what it mainly made: its film if it made one, its picture if not. */

export const mainOutput = (job) => {
  const outputs = job?.outputs || [];
  return outputs.find(o => o?.media === 'video') || outputs.find(o => o?.media === 'image') || null;
};

export const viewableOf = (jobs = []) => jobs
  .filter(job => job?.state === 'done' && mainOutput(job))
  .map(job => ({ job, output: mainOutput(job) }));

/* ------------------------------------------------------- card size

   How many to see at once is a question about this screen, not about the
   account: a phone and a desktop signed into the same account want different
   answers. So it is kept in this browser only. */

export const DENSITIES = ['s', 'm', 'l'];
const DENSITY_KEY = 'studioDensity';

export const readDensity = () => {
  try {
    const value = localStorage.getItem(DENSITY_KEY);
    return DENSITIES.includes(value) ? value : 'm';
  } catch (e) {
    return 'm';
  }
};

export const writeDensity = (value) => {
  try { localStorage.setItem(DENSITY_KEY, value); } catch (e) { /* private mode */ }
};

/* --------------------------------------------------- two devices' galleries

   What another device sent and what is here are both true: the other may have
   finished jobs this one never saw, and this one may be running a job the
   other has never heard of. So neither replaces the other.

   This used to live in StudioPanel.jsx, which meant it only ran while the
   Studio was on screen -- and the sync writes to storage whether anybody is
   looking or not. Sitting in a conversation while a phone synced was enough to
   have this machine's gallery replaced by the phone's, pictures and all. It is
   here now because src/syncEngine.js has to be able to do the same merge at
   the moment it writes, without a component being mounted. */

const PROGRESS = { starting: 0, queued: 1, running: 2, failed: 3, done: 4 };

/** Every job from both, and where both know one, the one further along. */
export const mergeJobs = (here = [], there = []) => {
  const byId = new Map((here || []).filter(Boolean).map(job => [job.id, job]));
  for (const job of (there || []).filter(Boolean)) {
    const mine = byId.get(job.id);
    // "done" is never followed by "running", so progress is the tie-break.
    if (!mine || (PROGRESS[job.state] ?? 0) > (PROGRESS[mine.state] ?? 0)) byId.set(job.id, job);
  }
  return [...byId.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
};

/* How many are kept. Starred ones are kept past it: starring one is saying
   "not this one", and the limit is for everything nobody said that about. */
export const MAX_HISTORY = 60;

/** The merged list, held to the limit -- the same rule `saveHistory` applies. */
export const trimJobs = (jobs = [], limit = MAX_HISTORY) =>
  jobs.filter((job, i) => i < limit || job.favorite);

/* ------------------------------------------------------ when it is done */

const PENDING = new Set(['starting', 'queued', 'running']);

/** The jobs that were still being made in `before` and have finished in `after`. */
export const justFinished = (before = [], after = []) => {
  const was = new Map(before.map(job => [job.id, job.state]));
  return after.filter(job => (job.state === 'done' || job.state === 'failed') && PENDING.has(was.get(job.id)));
};

/* ------------------------------------------------ before and after, the bar

   Where the bar between an original and its result sits, for BeforeAfter.jsx.
   Here rather than there so it can be tested without a DOM. */

/** The bar's position, in percent, for a pointer at `clientX` over `box`. */
export const splitAt = (clientX, box) => {
  if (!box || !(box.width > 0)) return 50;
  return Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100));
};

/** And moved by a key, or null for a key that does not move it. */
export const splitByKey = (position, key, big = false) => {
  const step = big ? 10 : 2;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, position - step);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(100, position + step);
  if (key === 'Home') return 0;
  if (key === 'End') return 100;
  return null;
};
