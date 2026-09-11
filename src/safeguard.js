/**
 * Whether a picture should be shown straight away.
 *
 * Two witnesses, because each is blind where the other can see.
 *
 * The prompt knows what was *asked for*, and it knows it before a single step
 * has run — which matters, because the half-denoised preview is on screen for
 * a minute before there is a finished picture to look at. But a prompt is
 * only a request: "1girl, beach" can come back as anything.
 *
 * The classifier (see nsfwClassifier.js) knows what was *drawn*. It is a
 * 224-pixel MobileNet and it is not infallible either, so the stronger of the
 * two answers wins: a prompt that asked for `nude` is veiled whatever the
 * classifier makes of the result, and a harmless prompt whose picture came
 * back explicit is veiled on the strength of the picture.
 *
 * Nothing is deleted or refused here. A veiled picture is one click away — the
 * point is that it is the person's click, made knowingly, and not a thumbnail
 * that appears across the room on a shared screen.
 */

import { getSetting, setSetting } from './settingsStore.js';

/* ------------------------------------------------------------- the level */

export const LEVELS = ['off', 'explicit', 'suggestive'];
export const DEFAULT_LEVEL = 'explicit';
const LEVEL_KEY = 'studioSafeguard';
export const SAFEGUARD_EVENT = 'webui:safeguard';

/* An ordinary account setting, so a phone and a laptop signed into the same
   account agree on it — and so a guest's choice is not an account's. */
export const getSafeguardLevel = () => {
  const stored = getSetting(LEVEL_KEY);
  return LEVELS.includes(stored) ? stored : DEFAULT_LEVEL;
};

export const setSafeguardLevel = (level) => {
  if (!LEVELS.includes(level)) return;
  setSetting(LEVEL_KEY, level);
  try { window.dispatchEvent(new CustomEvent(SAFEGUARD_EVENT, { detail: level })); } catch (e) { /* no window */ }
};

/* ------------------------------------------------------------ the verdict */

const RANK = { safe: 0, suggestive: 1, explicit: 2 };

/** The more cautious of two verdicts. `null` means "no opinion". */
export const strongest = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
};

/**
 * The classifier's five scores as one of three words.
 *
 * `porn` and `hentai` are the same verdict for different media — a photograph
 * and a drawing — and this app makes both, so they are summed rather than
 * judged apart: a picture scoring 0.3 on each is not "neither", it is a
 * picture the model could not place between two explicit classes.
 *
 * `sexy` is its own, milder, class — a swimsuit, a pose — and is what the
 * "suggestive" level is for.
 */
export const verdictFrom = (scores = {}) => {
  const porn = Number(scores.porn) || 0;
  const hentai = Number(scores.hentai) || 0;
  const sexy = Number(scores.sexy) || 0;
  if (porn + hentai >= 0.5) return 'explicit';
  if (sexy >= 0.45 || porn + hentai + sexy >= 0.6) return 'suggestive';
  return 'safe';
};

/**
 * Whether a verdict is hidden at a level.
 *
 * `pending` is a picture the classifier has not answered for yet. It is veiled
 * rather than shown: the whole point is not to flash the picture for the
 * second before the answer comes back, and a safe picture loses nothing but
 * that second.
 */
export const shouldVeil = (verdict, level) => {
  if (level === 'off' || !verdict || verdict === 'safe') return false;
  if (verdict === 'pending') return true;
  if (level === 'suggestive') return verdict === 'explicit' || verdict === 'suggestive';
  return verdict === 'explicit';
};

/* ------------------------------------------------------------- the prompt

   Danbooru tags, because that is what these prompts are made of — and a few
   plain words, because Krea is prompted in sentences. Only the positive
   prompt is ever read: `nsfw` in a negative prompt is somebody asking for the
   opposite. */

const EXPLICIT_TAGS = new Set([
  'nsfw', 'explicit', 'rating:explicit', 'rating explicit', 'rating_explicit',
  'nude', 'naked', 'completely nude', 'full nudity', 'nudity',
  'nipples', 'nipple', 'areolae', 'areola', 'pussy', 'vagina', 'vulva', 'clitoris',
  'penis', 'erection', 'testicles', 'genitals', 'anus',
  'sex', 'after sex', 'vaginal', 'anal', 'oral', 'fellatio', 'cunnilingus', 'paizuri',
  'handjob', 'footjob', 'masturbation', 'cum', 'cum in pussy', 'ejaculation',
  'pubic hair', 'uncensored', 'hentai', 'porn', 'pornography', 'topless', 'bottomless',
  'bdsm', 'rape', 'nude filter', 'group sex', 'threesome',
]);

const SUGGESTIVE_TAGS = new Set([
  'questionable', 'rating:questionable', 'rating questionable', 'rating_questionable',
  'sensitive', 'rating:sensitive', 'rating sensitive', 'rating_sensitive',
  'underwear', 'underwear only', 'panties', 'lingerie', 'bra', 'cleavage', 'bikini',
  'micro bikini', 'see-through', 'sideboob', 'underboob', 'thong', 'pantyshot',
  'panty shot', 'cameltoe', 'ass', 'ass focus', 'breast focus', 'groin', 'spread legs',
  'covered nipples', 'nipple slip', 'partially nude', 'undressing', 'naked towel',
  'naked shirt', 'naked apron', 'seductive smile', 'sexually suggestive', 'erotic', 'sexy',
  'bondage', 'strap slip', 'wardrobe malfunction',
]);

// Whole words, for prompts written as sentences.
const EXPLICIT_WORDS = /\b(nsfw|nude|naked|nudity|nipples?|pussy|vagina|penis|genitals|porn\w*|hentai|topless|bottomless|sex|masturbat\w*|erection|uncensored)\b/i;
const SUGGESTIVE_WORDS = /\b(lingerie|underwear|panties|bikini|cleavage|seductive|erotic|sexy|see-through|thong)\b/i;

/** A tag as a person would name it: no weight, no escapes, no underscores. */
export const normaliseTag = (raw) => String(raw || '')
  .toLowerCase()
  .replace(/\\([()[\]{}])/g, '$1')
  .replace(/^[\s([{]+|[\s)\]}]+$/g, '')
  .replace(/:\s*-?\d+(?:\.\d+)?$/, '')
  .replace(/^[\s([{]+|[\s)\]}]+$/g, '')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * What the prompt asked for: `'explicit'`, `'suggestive'`, or `null`.
 *
 * A tag found in either list is decided by the list — which is what keeps
 * `covered nipples` suggestive rather than tripping the word `nipples`. Only
 * what no list names falls through to the words.
 */
export const promptSignal = (prompt) => {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  let found = null;
  for (const piece of text.split(/[,\n]/)) {
    const tag = normaliseTag(piece);
    if (!tag) continue;
    if (EXPLICIT_TAGS.has(tag)) return 'explicit';
    if (SUGGESTIVE_TAGS.has(tag)) { found = 'suggestive'; continue; }
    if (EXPLICIT_WORDS.test(tag)) return 'explicit';
    if (SUGGESTIVE_WORDS.test(tag)) found = 'suggestive';
  }
  return found;
};

/* ------------------------------------------------------------ revealing

   Which pictures the person has chosen to see, for this visit. Shared, so
   revealing a card also reveals it in the viewer, and not stored: a picture
   shown on purpose yesterday is veiled again today, on whatever screen it
   happens to come up on. */

const revealed = new Set();
const listeners = new Set();

export const isRevealed = (key) => !!key && revealed.has(key);
export const setRevealed = (key, on) => {
  if (!key) return;
  if (on) revealed.add(key); else revealed.delete(key);
  for (const fn of listeners) fn();
};
export const onRevealChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
