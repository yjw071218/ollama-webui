/**
 * One setting, walked across a batch.
 *
 * A batch is the same prompt at a different seed each time, which answers "give
 * me some options" and nothing else. The question it cannot answer is the one
 * everybody actually has: *what does this number do to my picture*. Finding out
 * means eight generations, each preceded by editing one field, and remembering
 * afterwards which was which -- so almost nobody does it, and the settings stay
 * at whatever they were first set to.
 *
 * A sweep is the same batch with one field moved a step at a time, every other
 * thing held still. The seed is held still too, and that is the whole point:
 * two pictures that differ in their seed differ everywhere, and nothing can be
 * learnt by comparing them. Pinned, the only difference on screen is the one
 * being asked about.
 *
 * It is worth this much care because two of the settings it sweeps -- the
 * inpainting guide's strength and how far a mask is widened -- have no right
 * value at all. They depend on the picture, which is exactly why they became
 * sliders; and a slider whose value can only be found by guessing is a slider
 * nobody moves.
 *
 * No React here: the arithmetic is the part that will be wrong, so it is a pure
 * function of numbers. See scripts/sweep.test.mjs.
 */

import { GUIDE_STRENGTH, MASK_GROW_SCALE } from './inpaint.js';

/**
 * What can be swept, and where each value has to be written.
 *
 * `field` is the name in the Studio's form; `wire` is what the job calls it,
 * because three of these are not form fields at all -- they are account
 * settings that ride along with the request (see `inpaintFields`). Keeping the
 * two names apart here is what lets the caller stay ignorant of the
 * difference.
 */
export const AXES = [
  { id: 'steps', field: 'steps', wire: 'steps', integer: true },
  { id: 'cfg', field: 'cfg', wire: 'cfg', decimals: 2 },
  // Only with a reference picture; the caller decides whether to offer it.
  { id: 'denoise', field: 'denoise', wire: 'denoise', range: [0.1, 1], decimals: 2 },
  { id: 'guideStrength', wire: 'guideStrength', range: [GUIDE_STRENGTH.min, GUIDE_STRENGTH.max], decimals: 2 },
  { id: 'maskGrowScale', wire: 'maskGrowScale', range: [MASK_GROW_SCALE.min, MASK_GROW_SCALE.max], decimals: 2 },
];

export const axisById = (id) => AXES.find(axis => axis.id === id) || null;

/**
 * Which axes make sense for this workflow and this job.
 *
 * A workflow with no `cfg` input cannot be swept along it, and the two region
 * dials do nothing without a picture to edit -- offering them would be
 * offering a batch of eight identical pictures.
 */
export const axesFor = ({ has = {}, hasReference = false, region = false } = {}) => AXES.filter((axis) => {
  if (axis.id === 'steps') return !!has.steps;
  if (axis.id === 'cfg') return !!has.cfg;
  if (axis.id === 'denoise') return !!has.denoise && hasReference;
  // The guide and the mask only exist inside a region edit.
  return hasReference && region;
});

/** The range an axis is swept over: its own, or the workflow's for this field. */
export const axisRange = (axis, ranges = {}) => {
  if (!axis) return null;
  const found = axis.range || (axis.field ? ranges[axis.field] : null);
  if (!Array.isArray(found) || found.length !== 2) return null;
  const [low, high] = found.map(Number);
  return Number.isFinite(low) && Number.isFinite(high) && high > low ? [low, high] : null;
};

/** A number as the axis wants it written: whole steps, or two decimals. */
const asAxisValue = (axis, value) => {
  if (axis.integer) return Math.round(value);
  const places = axis.decimals ?? 2;
  return Math.round(value * 10 ** places) / 10 ** places;
};

/**
 * The values one sweep runs at: `count` of them, evenly spaced, ends included.
 *
 * Ends included because the ends are the interesting part -- "what does this
 * look like turned off" and "what does it look like at maximum" are the two
 * questions a sweep is usually asked. A sweep of one is the low end rather
 * than the middle, so that asking for one is asking for a specific picture.
 *
 * Duplicates are dropped: `steps` between 8 and 10 in six goes is 8, 8, 9, 9,
 * 10, 10, and paying for six generations to see three pictures twice is not
 * what anybody meant. The count comes back shorter, and the caller says so.
 */
export const sweepValues = (axis, [low, high] = [], count = 4) => {
  // A sweep needs somewhere to go. Two ends that are the same number is not a
  // range, and the dedupe below would quietly turn it into a batch of one.
  if (!axis || !Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) return [];
  const n = Math.max(1, Math.min(8, Math.round(Number(count) || 1)));
  if (n === 1) return [asAxisValue(axis, low)];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const value = low + ((high - low) * i) / (n - 1);
    const written = asAxisValue(axis, value);
    if (!out.includes(written)) out.push(written);
  }
  return out;
};

/**
 * The jobs a sweep is, as patches to lay over the request.
 *
 * Every one carries the same seed, because a sweep in which the seed also
 * moves is not a sweep -- it is eight different pictures with a caption. The
 * caller supplies it; a sweep with no seed pinned is refused rather than run,
 * since it would cost eight generations and teach nothing.
 */
export const sweepJobs = ({ axis, range, count, seed }) => {
  const found = axisById(axis?.id ? axis.id : axis);
  /* `Number(null)` is 0 and so is `Number('')`, and both are finite -- so
     without this an unpinned seed would sweep at seed 0 rather than being
     refused, which is a real picture and the wrong one. Nothing is not zero. */
  if (seed === null || seed === undefined || seed === '') return [];
  if (!found || !Number.isFinite(Number(seed))) return [];
  const values = sweepValues(found, range, count);
  return values.map(value => ({
    value,
    seed: Number(seed),
    patch: { [found.wire]: value, seed: Number(seed) },
  }));
};

/** "cfg 3.5", for the card that shows which of the sweep this one is. */
export const sweepLabel = (axisId, value, label = axisId) => `${label} ${value}`;
