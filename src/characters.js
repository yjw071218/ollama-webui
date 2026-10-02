/**
 * A character, or a style, that this install has been taught.
 *
 * What it is on disk is a LoRA and a word. The LoRA is trained from a handful
 * of pictures (see server/training.js); the word is what a prompt says to
 * summon it. Everything else here is about getting those two into a prompt
 * correctly, and about what to write in the captions the trainer reads --
 * which is the part that decides whether the run produces a character or a
 * blur.
 *
 * Pure, so the caption rules can be tested without a GPU. They are the one
 * thing in this feature that cannot be checked by running it: a bad caption
 * scheme does not fail, it just quietly trains the wrong thing, forty minutes
 * at a time.
 */

import { stampSetting } from './settingsStore.js';

/* -------------------------------------------------------- what is learnt

   The two are the same mechanism and opposite captioning, which is why they
   are one concept here rather than two features.

   A LoRA learns whatever the captions do not already account for. So to teach
   a *character* you write down everything that varies between the pictures --
   the pose, the background, the clothes -- and leave the character itself
   unsaid except for the trigger word, and the trigger is what the unexplained
   likeness attaches to. To teach a *style* you do the reverse: describe the
   subjects fully, every one of them, so that what is left unaccounted for is
   the only thing they have in common, which is how they are drawn. */

export const KINDS = ['character', 'style'];
export const DEFAULT_KIND = 'character';

/* Tags kept in a character's captions even though they are true of every
   picture in the set. They are not part of a likeness -- they are the frame a
   likeness sits in -- and dropping them trains the trigger to mean "one girl,
   alone" as much as it means the character, so asking for two of her later
   produces one. */
const ANCHORS = new Set([
  '1girl', '1boy', '1other', 'solo', '2girls', '2boys', 'multiple girls', 'multiple boys',
  'male focus', 'female focus',
]);

/* Tags that say something about the picture as an artefact rather than about
   what is in it. In a character's captions they are noise; in a style's they
   are actively wrong, because "sketch" and "monochrome" are exactly what the
   trigger is supposed to come to mean. */
const ABOUT_THE_DRAWING = new Set([
  'highres', 'absurdres', 'lowres', 'commentary', 'commentary request',
  'english commentary', 'bad id', 'bad pixiv id', 'artist name', 'signature',
  'watermark', 'web address', 'dated', 'twitter username', 'scan',
]);

/**
 * The word a prompt says to summon this.
 *
 * Deliberately not a real word. A trigger that is also ordinary English --
 * "luna", "knight" -- is a token the base model already has strong opinions
 * about, and training fights those opinions instead of filling an empty slot.
 * A short made-up token has no prior to overcome.
 */
export const triggerFor = (name) => {
  const text = String(name || '');
  const base = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12);
  /* A name with no Latin letters in it -- which is most names typed here --
     leaves nothing to build a token from, and every such character would get
     the same one. So the name itself becomes the token, through a hash: still
     stable for the same name, still meaningless to the base model, and no
     longer the same word for every character somebody calls 루나 or 星. */
  if (base) return `${base}chr`;
  let h = 2166136261;
  for (const ch of text) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return `chr${h.toString(36)}`;
};

/** Tags, tidied: trimmed, deduped, order kept, and the file-metadata ones dropped. */
export const cleanTags = (tags = []) => {
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const tag = String(raw || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag || ABOUT_THE_DRAWING.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
};

/** The tags true of every picture in the set -- the likeness, for a character. */
export const sharedTags = (perImage = []) => {
  const lists = perImage.map(cleanTags);
  if (lists.length < 2) return [];
  const rest = lists.slice(1).map(list => new Set(list));
  return lists[0].filter(tag => rest.every(set => set.has(tag)));
};

/* A caption is read once per epoch per picture; a hundred tags is not more
   information, it is a longer sentence for the same picture. Danbooru's own
   tagging rarely says anything useful past this many. */
const CAPTION_TAGS = 30;

/**
 * One caption per picture, as the trainer's `.txt` sidecars.
 *
 * `perImage[i]` is what the tagger read off picture `i`. What comes back is
 * the same length and in the same order, because the files are paired by
 * position.
 */
export const captionsFor = ({ kind = DEFAULT_KIND, trigger, tags: perImage = [] } = {}) => {
  const word = String(trigger || '').trim();
  // For a character: what every picture shares is the character, and saying it
  // is what stops it attaching to the trigger. For a style: nothing is held
  // back, because what is common is how it is drawn and that has no tag.
  const held = kind === 'character'
    ? new Set(sharedTags(perImage).filter(tag => !ANCHORS.has(tag)))
    : new Set();

  return perImage.map((tags) => {
    const kept = cleanTags(tags).filter(tag => !held.has(tag)).slice(0, CAPTION_TAGS);
    return [word, ...kept].filter(Boolean).join(', ');
  });
};

/* ------------------------------------------------------------- using one */

/** A tag list as a prompt is written: comma-separated, no empties. */
const asTags = (prompt) => String(prompt || '').split(',').map(t => t.trim()).filter(Boolean);

/* Two spellings of one tag.
 *
 * A character tag carries its series in brackets, and the brackets have to be
 * escaped for the image model -- `hoshino \(blue archive\)`. Both forms are
 * written by somebody at some point: a model writes it plainly, the tag list
 * and the server's correction write it escaped. Compared raw they are two
 * different tags, and taking a character *out* of a prompt then silently does
 * nothing. See `fixTagPrompt` in server/booruTags.js, whose `tagKey` folds them
 * the same way. */
const sameTag = (tag) => String(tag || '').toLowerCase().replace(/\\([()])/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * A prompt with this conversation's character in front of it, once.
 *
 * Reported: a model writing `iseri nina (blue archive)` for a character who has
 * nothing to do with that game, and a different spelling of her in every
 * picture of the same conversation. A model is asked to re-invent the person
 * each time it draws, and it is confidently wrong in a new way each time.
 *
 * So a conversation can carry its character as tags somebody chose once --
 * `iseri nina, black hair, short hair` -- and they go at the front of every
 * picture in it, exactly as written. Any of them the model also wrote are taken
 * out of its part, in either spelling of the brackets, so nothing is said twice.
 */
export const withPinnedCharacter = (pinned, prompt) => {
  const tags = asTags(pinned);
  if (!tags.length) return String(prompt || '');
  const held = new Set(tags.map(sameTag));
  const rest = asTags(prompt).filter(tag => !held.has(sameTag(tag)));
  return [...tags, ...rest].join(', ');
};

/**
 * A prompt with the trigger in it, once, at the front.
 *
 * At the front because these prompts are booru tags and the first tags carry
 * the most weight; once because a reader who has already typed the trigger
 * meant it once, and twice is a different and stronger thing than they asked
 * for.
 */
export const promptWith = (character, prompt) => {
  const word = String(character?.trigger || '').trim().toLowerCase();
  if (!word) return String(prompt || '');
  const tags = asTags(prompt);
  if (tags.some(tag => tag.toLowerCase() === word)) return String(prompt || '');
  return [character.trigger, ...tags].join(', ');
};

export const STRENGTH = { min: 0, max: 1.5, step: 0.05, default: 0.85 };

/* A strength as a number, or the default for anything that is not one.
 *
 * Not `Number.isFinite(Number(x))`, because `Number(null)` and `Number('')`
 * are both 0 and 0 is a legal strength here -- so an unset one would load the
 * LoRA at zero, which is a character switched on that draws nothing and gives
 * no sign why. The same trap has cost this codebase two evenings already, in
 * the inpainting dials and in the sweep's seed. */
const asStrength = (value) => {
  if (value === null || value === undefined || value === '') return STRENGTH.default;
  const n = Number(value);
  return Number.isFinite(n) ? n : STRENGTH.default;
};

/**
 * A LoRA stack with this character in it.
 *
 * Replaced rather than appended when it is already there, so turning a
 * character off and on again does not fill the nine slots with copies of it.
 */
export const stackWith = (loras = [], character) => {
  if (!character?.lora) return loras;
  const weight = asStrength(character.strength);
  const without = loras.filter(row => row?.name !== character.lora);
  return [...without, { name: character.lora, weight }];
};

/** And without it, for turning one off. */
export const stackWithout = (loras = [], character) =>
  (character?.lora ? loras.filter(row => row?.name !== character.lora) : loras);

/** Whether this stack already carries the character. */
export const stackHas = (loras = [], character) =>
  !!character?.lora && loras.some(row => row?.name === character.lora);

/**
 * The character a name refers to, as a model would have written it.
 *
 * Matched loosely on purpose. The model is copying a name out of a list in its
 * own context and will sometimes give it back with the quotes still on, or in
 * a different case, or as the trigger word instead -- and a swap that refuses
 * because of a capital letter is a swap that gets retried three times and then
 * described in prose.
 */
export const findCharacter = (list = [], name) => {
  const wanted = String(name || '').trim().replace(/^["'\u2018\u2019\u201c\u201d]|["'\u2018\u2019\u201c\u201d]$/g, '').toLowerCase();
  if (!wanted) return null;
  const same = (value) => String(value || '').trim().toLowerCase() === wanted;
  return list.find(one => same(one.name))
    || list.find(one => same(one.trigger))
    // Last: a name that merely contains it, so "루나" finds "루나 (교복)".
    || list.find(one => String(one.name || '').toLowerCase().includes(wanted))
    || null;
};

/* ------------------------------------------------- swapping one for another

   Putting a different character into a finished picture is the region edit
   that already exists, pointed at whoever is in it: SAM3 finds the person, the
   mask is grown past their outline, and only that part is redrawn -- with the
   new character's LoRA loaded and their trigger in the prompt.

   The nouns are what SAM3 is asked to find. More than one because a picture
   has one of them and not the others, and SAM3 answers with what it found. */

export const SWAP_REGION = 'girl, boy, person';

/* Enough for a different face, hair and build; not so much that the pose and
   the framing go with them. Below about 0.8 the old likeness bleeds through
   and the result is neither character. */
export const SWAP_DENOISE = 0.92;

/**
 * Who to put in the picture, from a name.
 *
 * Two kinds of answer, and which one it is depends only on whether the name is
 * in the library:
 *
 *   * a trained character -- it has a LoRA and a trigger word, which is how
 *     you get a likeness the base model has never seen;
 *   * anyone else -- the words themselves, taken as danbooru tags. These
 *     models were trained on danbooru, so `hoshino (blue archive)` is a
 *     character they already draw; asking for a LoRA first would be forty
 *     minutes of training to reproduce something already there.
 *
 * The second is not a fallback for a failed lookup. It is the normal case for
 * every character that has ever been tagged, which is most of them.
 */
export const swapTarget = (library = [], name) => {
  const trained = findCharacter(library, name);
  if (trained) return { kind: 'trained', name: trained.name, character: trained };
  const tags = String(name || '').trim();
  if (!tags) return null;
  return { kind: 'tags', name: tags, tags };
};

/**
 * What to send to redraw whoever is in a picture as somebody else.
 *
 * `prompt` is the picture's own prompt where it has one: the clothes, the
 * setting and the pose are what should survive the swap, and they are already
 * written down there. What is replaced is the character -- the old one's words
 * come out and the new one's go in, because a prompt naming both is a prompt
 * asking for a blend of the two faces.
 *
 * `style` is whatever was asked for alongside: "in watercolour", "90s anime
 * cel". It goes on the end, after the subject, which is where a modifier
 * belongs in a booru prompt.
 */
export const swapRequest = ({ picture, into, from = null, prompt = '', style = '' } = {}) => {
  if (!into) return null;
  const trained = into.kind === 'trained' ? into.character : null;
  if (into.kind === 'trained' && !trained?.lora) return null;
  if (into.kind !== 'trained' && !String(into.tags || '').trim()) return null;

  /* The old character out. A trained one leaves by its trigger; one that was
     only ever tags leaves by those tags, which is why `from` may carry either.
     Matched whole, so "hoshino (blue archive)" does not take "hoshino" out of
     an unrelated tag. */
  const leaving = new Set([
    ...(from?.trigger ? [String(from.trigger)] : []),
    ...asTags(from?.tags || ''),
  ].map(sameTag));

  const base = asTags(prompt || picture?.prompt || '')
    .filter(tag => !leaving.has(sameTag(tag)));

  const withCharacter = trained
    ? promptWith(trained, base.join(', '))
    // Tags go to the front for the same reason a trigger does: these prompts
    // are read positionally and the subject is what this request is about.
    : [...asTags(into.tags), ...base].join(', ');

  const styled = asTags(style).length
    ? [...asTags(withCharacter), ...asTags(style)].join(', ')
    : withCharacter;

  return {
    region: SWAP_REGION,
    denoise: SWAP_DENOISE,
    prompt: styled,
    // Only a trained character brings a LoRA. One drawn from tags brings none,
    // and must not inherit the one that drew the character being replaced.
    loras: trained ? stackWith(stackWithout([], from?.character || from), trained) : [],
  };
};

/* ------------------------------------------------------------ the record */

/** A trained character, as it is kept and synced. */
export const characterRecord = ({
  id, name, kind = DEFAULT_KIND, trigger, lora, strength = STRENGTH.default,
  cover = '', images = 0, rank = 0, epochs = 0, at = Date.now(),
} = {}) => ({
  id: String(id || ''),
  name: String(name || '').trim(),
  kind: KINDS.includes(kind) ? kind : DEFAULT_KIND,
  trigger: String(trigger || '').trim(),
  lora: String(lora || ''),
  strength: asStrength(strength),
  cover: String(cover || ''),
  images: Number(images) || 0,
  rank: Number(rank) || 0,
  epochs: Number(epochs) || 0,
  at: Number(at) || Date.now(),
});

/** Newest first, which is the order a library of these is useful in. */
export const byNewest = (list = []) => [...list].sort((a, b) => (b?.at || 0) - (a?.at || 0));

/* ------------------------------------------------------------- the library

   Kept and synced exactly as the prompt blocks beside it are (see
   src/studioPresets.js): one small named list per account, read and written
   whole, stamped so the upload is not older than what the account already
   has.

   The LoRA itself is not in here and does not sync. It is a file on the
   machine that trained it, in the ComfyUI that will draw with it -- which is
   the same machine serving this app, so a phone opening the same server draws
   with it too. A phone pointed at a *different* ComfyUI would see the
   character in the library and not be able to use it, which is the same thing
   that is already true of every checkpoint and every one of the two hundred
   LoRAs installed here. */

const STORAGE_KEY = 'characters';

export const charactersKey = (scope) => `${STORAGE_KEY}:${scope || 'guest'}`;

export const loadCharacters = (scope) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(charactersKey(scope)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return byNewest(parsed.filter(item => item?.id && item?.lora).map(characterRecord));
  } catch (e) {
    return [];
  }
};

export const saveCharacters = (scope, list) => {
  try {
    localStorage.setItem(charactersKey(scope), JSON.stringify(byNewest(list).map(characterRecord)));
    // Stamped, or it uploads as older than everything and comes straight back
    // down as whatever the account had. See `saveStudioPresets`.
    stampSetting(scope, charactersKey(scope));
  } catch (e) { /* quota, or storage disabled */ }
};

/** The list with one more in it; a repeat of the same id replaces it. */
export const withCharacter = (list = [], character) => {
  const next = characterRecord(character);
  if (!next.id) return list;
  return byNewest([next, ...list.filter(item => item.id !== next.id)]);
};

export const withoutCharacter = (list = [], id) => list.filter(item => item.id !== String(id));

/** The one a picture was made with, if any of them was. */
export const characterOf = (list = [], settings) => {
  const names = (settings?.loras || []).map(row => String(row?.name || ''));
  if (!names.length) return null;
  return list.find(item => names.some(name => sameLora(name, item.lora))) || null;
};

/** Two LoRA names, compared the way ComfyUI's own lists spell them. */
export const sameLora = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase()
  === String(b || '').replace(/\\/g, '/').toLowerCase();
