/**
 * Checking a finished picture, and redrawing the part that came back wrong.
 *
 * Reported: a picture is right in every way that was asked for -- the pose,
 * the outfit, the light -- and one hand has six fingers. Nothing in the
 * request was wrong and nothing about drawing it again would be better; the
 * only thing wrong with the picture is two hundred pixels of it. Redrawing the
 * whole thing at a new seed throws away everything that worked, and it is what
 * everybody does, because finding the bad part and fixing only that part is
 * three deliberate steps and each of them is a chore.
 *
 * All three already exist here. A vision model can look at a picture and say
 * what is wrong with it. SAM3 can find "hands" in a picture from that word.
 * And a region edit redraws only inside the mask it is given, guided by
 * kohya-ss's inpainting LLLite so that what is drawn inside continues what is
 * outside. This file is the join: the words the vision model is asked for, the
 * reading of its answer, and the prompt the redraw is made from.
 *
 * Deliberately no React and no fetch. Everything here is a pure function of
 * text, so the judgement -- which is the part that will be wrong -- can be
 * tested on the answers real models actually give. See scripts/retouch.test.mjs.
 */

import { getSetting, setSetting } from './settingsStore.js';

/* --------------------------------------------------------------- the mode

   Three, not a switch, because the two failure modes pull in opposite
   directions. A check that never acts is a check nobody reads; a check that
   always acts will one day redraw a hand that was fine, and the reader will
   not know it happened. So: off, offered, or done -- and when it is done, what
   it started from is kept beside it.

   `off` is the default. The check is not free: the picture models and the
   language models share one card, so the server takes the language model off
   it before a picture is queued (see server/vram.js), and asking a vision
   model about the result puts it back on -- a load, an answer, and an unload
   around every single picture. That is a cost somebody should choose, having
   read what it buys, rather than discover as "generation got slower". */

export const MODES = ['off', 'suggest', 'auto'];
export const DEFAULT_MODE = 'off';
const MODE_KEY = 'pictureRetouch';

export const getRetouchMode = () => {
  const stored = getSetting(MODE_KEY);
  return MODES.includes(stored) ? stored : DEFAULT_MODE;
};

export const setRetouchMode = (mode) => {
  if (!MODES.includes(mode)) return;
  setSetting(MODE_KEY, mode);
};

/* ----------------------------------------------------------- the vocabulary

   What the vision model is allowed to name. Not a free-text answer, because
   the word it returns is fed to SAM3Segment as the thing to find in the
   picture, and SAM3 finds nouns: "hands" is a mask, "the anatomy of her left
   hand near the ribbon" is nothing at all. An answer outside this list is
   dropped rather than guessed at -- see `readVerdict`.

   Everything here is a part a diffusion model gets wrong often enough to be
   worth a second pass, and that SAM3 can actually segment. `background` is not
   on the list on purpose: a background that came back muddled is a whole-
   picture problem, and redrawing it inside a mask leaves a seam around the
   subject, which is a worse picture than the one it fixed. */

export const REGIONS = [
  'hands', 'fingers', 'arms', 'legs', 'feet',
  'face', 'eyes', 'mouth', 'ears', 'hair',
  'clothes', 'shoes',
];

/* ------------------------------------------------------------ the question

   Written at the failure it is for. A model asked "what is wrong with this
   picture?" answers as a critic -- the composition is unbalanced, the mood is
   unclear -- and every one of those answers would start a redraw of something
   that was a choice. So it is asked for one kind of fault only, given the
   words it may answer in, and told to say that nothing is wrong, which is the
   answer most of the time and the one a model is least willing to give. */

export const INSPECT_PROMPT = [
  'You are checking one AI-generated picture for the specific mistakes image models make:',
  'a malformed hand, extra or missing fingers, an extra or missing limb, eyes that do not',
  'match or are broken, a distorted mouth, clothing that melts into the body or into itself,',
  'a strap or a sleeve that goes nowhere.',
  '',
  'Judge nothing else. Style, composition, colour, lighting, mood, taste, how attractive',
  'anybody is, and anatomy that is merely stylised are all outside what you are looking for.',
  'Report a part only if it is actually MALFORMED -- something the artist would call a',
  'mistake, not a choice. Most pictures have nothing wrong with them; saying so is the',
  'expected answer, not a failure to find something.',
  '',
  'Reply with JSON and nothing else. Either:',
  '{"ok": true}',
  'when nothing is malformed, or:',
  `{"parts": [{"region": "hands", "problem": "six fingers on the right hand"}]}`,
  '',
  `"region" must be exactly one of: ${REGIONS.join(', ')}.`,
  'At most two parts, worst first. Keep "problem" under eight words.',
].join('\n');

/* -------------------------------------------------------------- the answer */

/** The first `{...}` in a reply, past any prose or code fence around it. */
const firstObject = (text) => {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) return null;
  /* Braces counted rather than a regex to the last `}`: a model that explains
     itself after the JSON ("{...} I found this because...") ends the reply with
     a brace of its own often enough to matter, and the greedy match then takes
     the explanation into the parse and fails. */
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
};

/** One word from the model held against the list; '' for anything else. */
export const asRegion = (raw) => {
  const word = String(raw || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return '';
  if (REGIONS.includes(word)) return word;
  /* A singular where the list is plural, which is what a model writes when it
     found one of them: "hand", "eye", "shoe". The other way round is not
     accepted -- there is no region this list holds in the singular. */
  const plural = REGIONS.find(region => region === `${word}s` || region === `${word}es`);
  return plural || '';
};

/**
 * What a vision model's reply means: `{ ok: true }`, or the parts it named.
 *
 * Tolerant on the way in and strict on the way out. A local model wraps its
 * JSON in a code fence, or answers in prose with the JSON at the end, or names
 * a region that is not on the list, and none of those is a reason to redraw
 * something; but none of them is a reason to give up on the rest of the answer
 * either. Anything that cannot be read at all is `{ ok: true }` -- an
 * unreadable answer is not evidence that the picture is wrong.
 */
export const readVerdict = (text) => {
  const source = firstObject(text);
  if (!source) return { ok: true };
  let parsed = null;
  try { parsed = JSON.parse(source); } catch (e) { return { ok: true }; }
  if (!parsed || typeof parsed !== 'object') return { ok: true };
  if (parsed.ok === true) return { ok: true };

  const parts = [];
  for (const entry of Array.isArray(parsed.parts) ? parsed.parts : []) {
    const region = asRegion(entry?.region);
    if (!region || parts.some(part => part.region === region)) continue;
    parts.push({ region, problem: String(entry?.problem || '').trim().slice(0, 80) });
  }
  return parts.length ? { ok: false, parts } : { ok: true };
};

/* ---------------------------------------------------------------- the plan

   Two parts at most, and both in one pass rather than one pass each.

   A pass is a whole generation -- the model on the card, the sampler, the
   upscaler after it -- so two passes is twice the wait for a picture that was
   already finished. The region edit takes up to three comma-separated nouns
   and merges them into one mask (see regionTerms on the server), and the two
   worst parts of a picture are rarely next to each other, so the merged mask
   is two small islands rather than one large one. Three is the server's
   limit; two is used here because the third thing a model names is the one it
   was reaching for. */

const MAX_PARTS = 2;

/** The one redraw to make from a verdict, or null when there is nothing to do. */
export const retouchPlan = (verdict) => {
  const parts = (verdict?.parts || []).slice(0, MAX_PARTS);
  if (!parts.length) return null;
  return {
    region: parts.map(part => part.region).join(', '),
    // What to tell the reader it found. The worst one: it was asked for worst first.
    problem: parts[0].problem || '',
    parts,
  };
};

/* -------------------------------------------------------------- the redraw

   What is drawn inside the mask, and only that.

   Not the picture's own prompt. A region edit draws whatever the prompt names
   *inside the mask*, so handing it "1girl, flower field, sailor uniform"
   because that is what the picture is of would draw a girl in a flower field
   inside the outline of a hand. What belongs here is the part, described as it
   should have come out -- and nothing else. Everything that keeps the redraw
   in the same picture comes from elsewhere: the workflow is the one that drew
   it, and the inpainting LLLite is shown the pixels around the mask. */

const FIXES = {
  hands: 'perfect hands, five fingers, correctly drawn fingers',
  fingers: 'five fingers, correctly drawn fingers, clean finger separation',
  arms: 'anatomically correct arms, natural arm pose',
  legs: 'anatomically correct legs, natural leg pose',
  feet: 'anatomically correct feet, correctly drawn toes',
  face: 'clean detailed face, correct facial features',
  eyes: 'matching eyes, symmetrical eyes, clean eye detail',
  mouth: 'cleanly drawn mouth, correct teeth',
  ears: 'correctly drawn ears',
  hair: 'cleanly drawn hair, consistent hair strands',
  clothes: 'cleanly drawn clothing, consistent seams and folds',
  shoes: 'cleanly drawn shoes, matching pair',
};

/**
 * A plan's region as the reader's own language calls it.
 *
 * The word itself cannot be translated where it is used: it is an English noun
 * on purpose, because it is fed to SAM3 to find the part in the picture. So
 * the noun travels in English and is named in the reader's language only where
 * it is shown -- "hands, eyes" is what the mask-finder is given and
 * "손, 눈" is what the button says.
 */
export const regionLabel = (region, t) => String(region || '')
  .split(',')
  .map(word => word.trim())
  .filter(Boolean)
  .map(word => (t ? t(`retouch.region.${word}`) : word))
  .join(', ');

/** The prompt for a plan's redraw: the parts as they should have been drawn. */
export const retouchPrompt = (plan) => (plan?.parts || [])
  .map(part => FIXES[part.region] || `cleanly drawn ${part.region}`)
  .join(', ');

// Automatic repairs should retain the character's identity inside the mask.
// Strong replacement remains available through an explicit edit.
export const RETOUCH_DENOISE = 0.65;

/* --------------------------------------------------------- what it is worth

   Whether a check is possible at all, said once so the chat and the Studio
   cannot disagree about it. A vision model is needed; without one the mode is
   a setting that silently does nothing, which is the failure this returns a
   reason for rather than reproducing. */

/** The model to ask about a picture: the one in use if it sees, else the vision one. */
export const inspector = ({ active, activeSees, vision, visionSees }) => {
  if (active && activeSees) return active;
  if (vision && visionSees) return vision;
  return '';
};
