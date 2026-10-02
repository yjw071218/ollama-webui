/**
 * The two numbers a region edit cannot measure for you.
 *
 * Everything else about redrawing one part of a picture is a measurement --
 * how far past a hairline to grow the mask, how wide a soft edge has to be
 * before the composite stops smudging, how far clothes reach past the outline
 * SAM3 draws round them. Those were taken off edits that came back wrong and
 * they are written down in server/workflows.js, where they belong: nobody
 * should have to discover them twice.
 *
 * Two of them are not properties of the code, though. They are properties of
 * the picture in front of you:
 *
 *   - **How hard the guide pulls.** kohya-ss's inpainting LLLite is shown the
 *     picture around the mask so that what is drawn inside continues what is
 *     outside. At 1 a redrawn hand continues the arm it is attached to. But an
 *     outfit changed outright wants the old outfit to have less of a say, and
 *     a hand that came back fused with the mug wants more, and no default is
 *     both.
 *
 *   - **How far the mask is widened.** The right width is the width of what the
 *     mask missed -- the sheer sleeve past the outline, the sliver of old
 *     picture at the end of a brush stroke. Too narrow leaves the old edge
 *     standing; too wide redraws a collar that an edit of the hair never asked
 *     about.
 *
 * Both are multipliers rather than pixel counts, so the measurements underneath
 * survive: clothes stay wider than hair, a painted mask stays a share of its
 * own picture, and one slider moves all of them together. At 1 -- where they
 * start -- a job is byte for byte the job it would have been before either
 * existed, which is why `inpaintFields` leaves them out entirely there.
 *
 * The ranges are the server's, copied rather than imported because this half
 * runs in a browser, and checked against it in scripts/drawedit.test.mjs.
 */

import { getSetting, setSetting } from './settingsStore.js';

export const GUIDE_STRENGTH = { min: 0, max: 2, step: 0.05, default: 1 };
export const MASK_GROW_SCALE = { min: 0.25, max: 2.5, step: 0.05, default: 1 };

const KEYS = {
  guideStrength: 'inpaintGuideStrength',
  maskGrowScale: 'inpaintMaskGrowScale',
};

/**
 * A dial's value as a number inside its range; its default for anything else.
 *
 * Rounded to the step, because a slider's arithmetic does not land on it: five
 * presses of the right arrow from 1 is 1.2500000000000002, and that is what
 * would be written down, shown, and sent.
 */
export const tuned = (value, range) => {
  /* `Number(null)` is 0 and `Number('')` is 0, and a setting that was never
     written reads back as one of them -- so without this an untouched guide
     would arrive as "off" and an untouched mask at the narrow end of its
     range. Nothing is not zero. */
  if (value === null || value === undefined || value === '') return range.default;
  const n = Number(value);
  if (!Number.isFinite(n)) return range.default;
  return Math.round(Math.min(Math.max(n, range.min), range.max) * 100) / 100;
};

/** Both dials, as they were left. An ordinary account setting, so it syncs. */
export const getInpaintTuning = () => ({
  guideStrength: tuned(getSetting(KEYS.guideStrength), GUIDE_STRENGTH),
  maskGrowScale: tuned(getSetting(KEYS.maskGrowScale), MASK_GROW_SCALE),
});

/** One or both, written back. */
export const setInpaintTuning = (patch = {}) => {
  for (const name of Object.keys(KEYS)) {
    if (patch[name] === undefined) continue;
    const range = name === 'guideStrength' ? GUIDE_STRENGTH : MASK_GROW_SCALE;
    setSetting(KEYS[name], String(tuned(patch[name], range)));
  }
};

/**
 * The dials as fields on a generation request -- and nothing at all where
 * neither has been moved.
 *
 * Left out rather than sent as 1, so that a reader who has never opened this
 * sends exactly the request they sent yesterday. A dial nobody turned should
 * not be able to change anything, including by being a number the server has
 * to decide what to do with.
 */
export const inpaintFields = (tuning = getInpaintTuning()) => ({
  ...(tuning.guideStrength !== GUIDE_STRENGTH.default ? { guideStrength: tuning.guideStrength } : {}),
  ...(tuning.maskGrowScale !== MASK_GROW_SCALE.default ? { maskGrowScale: tuning.maskGrowScale } : {}),
});

/** "×1.25", for a slider that is showing a multiplier rather than a quantity. */
export const asFactor = (value) => `×${Number(value).toFixed(2).replace(/\.?0+$/, '') || '0'}`;
