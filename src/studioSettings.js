/**
 * What the Studio was set to last time.
 *
 * ## Per workflow, not per app
 *
 * Krea 2 Turbo runs at 8 steps and guidance 1; Anima wants 40 and 7. One saved
 * set of numbers shared between them would be wrong for whichever one you did
 * not set it from, so the store is keyed by workflow and switching between two
 * of them restores each one's own last state rather than carrying the other's
 * over.
 *
 * ## Why saved values are checked before they are used
 *
 * A setting names a file. Checkpoints get renamed, LoRAs get deleted, a model
 * pack gets uninstalled — and a saved name that no longer exists is not a
 * harmless leftover: it is a generation that fails a minute in, on a value the
 * person cannot see because it is sitting in a picker that renders it as
 * selected. So everything that names a file is checked against what ComfyUI
 * currently has, and anything that has gone simply is not restored.
 *
 * The numbers are checked too, against the workflow's own ranges, because a
 * workflow edited to cap its steps lower should not be handed the old higher
 * value from before the edit.
 */

import { stampSetting } from './settingsStore.js';

const KEY = 'studioSettings';

export const storeKey = (scope) => `${KEY}:${scope || 'guest'}`;

/* Not a workflow: which workflow draws the pictures asked for in a chat.
   Kept in the same store so it syncs with the rest of the Studio, under a key
   no workflow id can collide with. `{ model: 'auto' | 'anima-base' | 'krea2-turbo' }`. */
export const CHAT_PICTURE_KEY = '__chat';

export const CHAT_PICTURE_MODELS = ['auto', 'anima-base', 'krea2-turbo'];

export const readChatPictureModel = (scope) => {
  const chosen = readAll(scope)?.[CHAT_PICTURE_KEY]?.model;
  return CHAT_PICTURE_MODELS.includes(chosen) ? chosen : 'auto';
};

export const writeChatPictureModel = (scope, model) =>
  writeSettings(scope, CHAT_PICTURE_KEY, { model: CHAT_PICTURE_MODELS.includes(model) ? model : 'auto' });

/** Everything saved, for every workflow, in this profile. */
export const readAll = (scope) => {
  try {
    const raw = localStorage.getItem(storeKey(scope));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
};

/* What is deliberately not remembered.
 *
 * `referenceImage` names a file uploaded into ComfyUI's input folder for one
 * generation. Restoring it a week later points at something ComfyUI has very
 * likely tidied away, and a picture that fails because of an invisible stale
 * filename is worse than one you have to attach again. */
const TRANSIENT = new Set(['referenceImage']);

export const writeSettings = (scope, modelId, form) => {
  if (!modelId) return;
  try {
    const all = readAll(scope);
    const keep = {};
    for (const [name, value] of Object.entries(form || {})) {
      if (TRANSIENT.has(name)) continue;
      keep[name] = value;
    }
    /* Unchanged is not a write. The form effect fires on every render that
       touches `form`, including the one that restores it from a sync — and a
       restore that re-stamps would upload, arrive on the other device as
       newer, be restored there, re-stamp, and upload back, for ever. */
    if (JSON.stringify(all[modelId] ?? null) === JSON.stringify(keep)) return;
    all[modelId] = keep;
    localStorage.setItem(storeKey(scope), JSON.stringify(all));
    /* Timestamped, or the sync engine cannot tell which device wrote last and
       the phone's prompt and the desktop's fight over each other. `updatedAt:
       0` reads as "older than everything", so an unstamped write uploads and
       is then immediately overwritten by whatever the account already had --
       which is exactly how the user profile behaved before it was stamped. */
    stampSetting(scope, storeKey(scope));
  } catch (e) { /* quota, or storage disabled */ }
};

export const clearSettings = (scope, modelId) => {
  try {
    const all = readAll(scope);
    delete all[modelId];
    localStorage.setItem(storeKey(scope), JSON.stringify(all));
    stampSetting(scope, storeKey(scope));
  } catch (e) { /* private mode */ }
};

/** Which saved fields name a file, and which list decides whether it still exists. */
const FILE_FIELDS = { model: 'model', vae: 'vae', clip: 'clip', sampler: 'sampler', scheduler: 'scheduler' };

const stillThere = (value, options) => {
  // No list means "could not ask" — which is not the same as "it is gone", and
  // throwing a setting away because ComfyUI happened to be down is worse than
  // keeping one that may be stale.
  if (!Array.isArray(options) || options.length === 0) return true;
  return options.includes(value);
};

const inRange = (value, range, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (!Array.isArray(range)) return n;
  return Math.min(Math.max(n, range[0]), range[1]);
};

/**
 * The form to open a workflow with: its defaults, with whatever was saved and
 * is still valid laid over the top.
 *
 * `model` here is the *described* workflow from `/studio/models` — its
 * defaults, its ranges, and the lists of what ComfyUI currently has.
 */
export const restoreForm = (model, saved = {}) => {
  const defaults = model?.defaults || {};
  const choices = model?.choices || {};
  const ranges = model?.ranges || {};
  const has = model?.has || {};

  const form = {
    /* The positive prompt, in the four parts people actually edit separately.
     *
     * `prompt` is the subject and changes every time; the other three are
     * settings that change once a month. Keeping them in one box meant
     * re-reading a wall of quality tags to find the two words worth changing,
     * and re-typing them whenever the box was cleared.
     *
     * They are joined in order when the job is sent -- see `joinPrompt` -- and
     * the order is the point: these models read a prompt positionally. */
    lead: '',
    artist: '',
    prompt: '',
    tail: '',
    negative: '',
    width: defaults.width || 1024,
    height: defaults.height || 1024,
    steps: defaults.steps ?? 20,
    cfg: defaults.cfg ?? 5,
    duration: defaults.duration ?? 5,
    fps: defaults.fps ?? 24,
    sampler: defaults.sampler || '',
    scheduler: defaults.scheduler || '',
    model: '',
    vae: '',
    clip: '',
    loras: [],
    seed: '',
    lockSeed: false,
    referenceImage: '',
    // How many to make per press of Generate, each with its own seed.
    batch: 1,
  };

  if (!saved || typeof saved !== 'object') return form;

  // The prose and the switches restore as they were.
  if (typeof saved.prompt === 'string') form.prompt = saved.prompt;
  if (typeof saved.lead === 'string') form.lead = saved.lead;
  if (typeof saved.tail === 'string') form.tail = saved.tail;
  /* The artist box restores whatever the workflow does with it. Anima has a
     dedicated artist encoder and the other two get the names folded into the
     prompt, but both are a place to put them -- unlike a negative prompt, which
     Krea 2 genuinely cannot use. */
  if (typeof saved.artist === 'string') form.artist = saved.artist;
  if (typeof saved.negative === 'string' && has.negative) form.negative = saved.negative;
  if (typeof saved.seed === 'string') form.seed = saved.seed;
  form.lockSeed = !!saved.lockSeed;

  // The numbers restore inside whatever the workflow now allows.
  form.width = inRange(saved.width, null, form.width);
  form.height = inRange(saved.height, null, form.height);
  form.steps = inRange(saved.steps, ranges.steps, form.steps);
  form.cfg = inRange(saved.cfg, ranges.cfg, form.cfg);
  form.duration = inRange(saved.duration, ranges.duration, form.duration);
  form.fps = inRange(saved.fps, null, form.fps);
  form.batch = Math.round(inRange(saved.batch, [1, 8], form.batch));

  // The names restore only if they still name something.
  for (const field of Object.keys(FILE_FIELDS)) {
    const value = saved[field];
    if (typeof value === 'string' && value && stillThere(value, choices[field])) {
      form[field] = value;
    }
  }

  /* LoRAs, dropping any the machine no longer has. Silently: a list that comes
     back one shorter is obvious on screen, whereas a row naming a file that was
     deleted last week is a failure forty seconds into the next generation. */
  if (Array.isArray(saved.loras)) {
    form.loras = saved.loras
      .filter(row => row && typeof row.name === 'string' && row.name)
      .filter(row => stillThere(row.name, choices.lora))
      .slice(0, model?.loraSlots || 0)
      .map(row => ({
        name: row.name,
        weight: Number.isFinite(Number(row.weight)) ? Number(row.weight) : 1,
      }));
  }

  return form;
};

/** How many saved names were thrown away, so the panel can say so once. */
export const droppedFrom = (model, saved = {}) => {
  const choices = model?.choices || {};
  let dropped = 0;
  for (const field of Object.keys(FILE_FIELDS)) {
    const value = saved?.[field];
    if (typeof value === 'string' && value && !stillThere(value, choices[field])) dropped += 1;
  }
  for (const row of Array.isArray(saved?.loras) ? saved.loras : []) {
    if (row?.name && !stillThere(row.name, choices.lora)) dropped += 1;
  }
  return dropped;
};

/* ============================================================ finding a LoRA

   Two hundred and five of them in a `<select>`. The native control's type-ahead
   matches from the start of the string, and these names start with a folder —
   `anima\style\NyteTyde.safetensors` — so typing "nyte" matches nothing and the
   only way to the one you want is to scroll two hundred rows.

   So the list is searched instead, on the terms below. The rules come from what
   the names in that list actually look like rather than from a general idea of
   search: they carry folders, extensions, versions and a house style of
   underscores and camel case, and every one of those is punctuation the person
   typing will leave out. */

/** `anima\style\NyteTyde.safetensors` -> `NyteTyde` */
export const loraLabel = (name) => String(name || '')
  .replace(/\.(safetensors|ckpt|pt|bin)$/i, '')
  .split(/[\\/]/)
  .pop();

/** `anima\style\NyteTyde.safetensors` -> `anima / style` */
export const loraFolder = (name) => {
  const parts = String(name || '').split(/[\\/]/);
  parts.pop();
  return parts.join(' / ');
};

/* Everything a query could reasonably ignore: the separators, the extension,
 * and the boundaries inside a run-together name. Comparing on this means "nyte
 * tyde", "NyteTyde" and "nytetyde" are one query, and so are "blue archive" and
 * "BlueArchiveStyleB1". */
const flatten = (text) => String(text || '')
  .toLowerCase()
  .replace(/\.(safetensors|ckpt|pt|bin)$/i, '')
  .replace(/[^a-z0-9]+/g, '');

/**
 * Does this name answer this query?
 *
 * Every whitespace-separated word has to appear, so "anima nyte" narrows rather
 * than widens — which is the behaviour anyone who has used a file search
 * expects, and the opposite of what OR-ing the terms would do on a list this
 * long.
 */
export const matchesQuery = (name, query) => {
  const terms = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const flat = flatten(name);
  const raw = String(name || '').toLowerCase();
  return terms.every(term => flat.includes(flatten(term)) || raw.includes(term));
};

/**
 * The list, filtered and ordered by how well each name answers.
 *
 * A match on the file's own name beats a match on the folder it sits in: typing
 * "anima" should not bury the LoRA actually called Anima under the two hundred
 * that merely live in `anima\`.
 */
export const searchNames = (names = [], query = '', limit = 60) => {
  const terms = String(query || '').trim().toLowerCase();
  const hits = [];
  for (const name of names) {
    if (!matchesQuery(name, query)) continue;
    const label = flatten(loraLabel(name));
    const flatTerms = flatten(terms);
    // 0 starts the name, 1 is inside the name, 2 is only in the folder.
    const rank = !flatTerms ? 1
      : label.startsWith(flatTerms) ? 0
      : label.includes(flatTerms) ? 1
      : 2;
    hits.push({ name, rank });
  }
  hits.sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map(hit => hit.name);
};
