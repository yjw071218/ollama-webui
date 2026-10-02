/**
 * Prompt blocks, saved by name.
 *
 * The Studio remembers what each workflow was last set to, which is the right
 * behaviour for "carry on where I left off" and no help at all for the thing
 * people actually do: keep a handful of prompts they return to. A character
 * described in forty tags, a lighting recipe, a set of quality words that suit
 * one checkpoint -- each of those is rebuilt by hand every time, or dug out of
 * an old picture's settings.
 *
 * The app already answers this twice, for chat: `samplingPresets` for the
 * numbers and `systemPrompts` for the personas. Both are named lists, saved
 * per account, synced as one record. This is the third, for the four prompt
 * boxes, deliberately built the same way -- down to stamping the write, which
 * is what the other two had to learn the hard way (a save that does not move
 * the stamp is a save no other device ever hears about).
 *
 * ## What a preset holds
 *
 * The four boxes, and nothing else. Not the size, not the sampler, not the
 * LoRA stack: those belong to the workflow and are already remembered per
 * workflow. Mixing them in would mean loading a character also changed the
 * resolution, which is the kind of surprise that makes a feature untrustworthy.
 *
 * ## And how it is applied
 *
 * Either replacing what is in the boxes or added to them, because both are
 * real: "load my character" replaces, and "add my quality tags" appends. The
 * caller decides; `applyPreset` does both and never duplicates a block that is
 * already there.
 */

import { stampSetting } from './settingsStore.js';

const STORAGE_KEY = 'studioPrompts';

/** The four boxes a preset is made of. */
export const FIELDS = ['lead', 'artist', 'prompt', 'tail'];

export const presetsKey = (scope) => `${STORAGE_KEY}:${scope || 'guest'}`;

/** A name that will fit on a chip, and is not blank. */
const cleanName = (name) => String(name ?? '').trim().slice(0, 60);

/** Only the four fields, each a trimmed string. */
export const presetValues = (form = {}) => Object.fromEntries(
  FIELDS.map(field => [field, String(form[field] ?? '').trim()]),
);

/** Is there anything in it? A preset of four empty boxes is not one. */
export const isEmptyPreset = (values = {}) => FIELDS.every(field => !String(values[field] ?? '').trim());

export const loadStudioPresets = (scope) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(presetsKey(scope)) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && item.id && typeof item.name === 'string')
      .map(item => ({
        id: String(item.id),
        name: cleanName(item.name),
        values: presetValues(item.values || {}),
        at: Number(item.at) || 0,
      }));
  } catch (e) {
    return [];
  }
};

export const saveStudioPresets = (scope, presets) => {
  try {
    localStorage.setItem(presetsKey(scope), JSON.stringify(presets));
    // Stamped, or the list uploads as older than everything and comes straight
    // back down as whatever the account already had. See `savePresets`.
    stampSetting(scope, presetsKey(scope));
  } catch (e) { /* quota, or storage disabled */ }
};

/**
 * The list with one more in it, newest first.
 *
 * A name already used is overwritten rather than duplicated: typing the same
 * name again is how anybody expects to say "update this one", and a list with
 * two "character" in it is a list nobody can use.
 */
export const withPreset = (presets, { name, values, now = Date.now() }) => {
  const clean = cleanName(name);
  const made = {
    id: `sp-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: clean,
    values: presetValues(values),
    at: now,
  };
  const rest = presets.filter(item => item.name.toLowerCase() !== clean.toLowerCase());
  return [made, ...rest];
};

export const withoutPreset = (presets, id) => presets.filter(item => item.id !== id);

/**
 * A preset, into the form.
 *
 * `mode` is 'replace' or 'add'. Adding joins with a comma and leaves out what
 * the box already says, so pressing it twice does nothing the second time --
 * which matters, because a prompt with its quality tags in it twice is not
 * merely untidy: these models read a repeated tag as a heavier one.
 */
export const applyPreset = (form = {}, values = {}, mode = 'replace') => {
  const next = { ...form };
  for (const field of FIELDS) {
    const incoming = String(values[field] ?? '').trim();
    if (mode === 'replace') {
      // A preset that says nothing about a box leaves that box alone; it does
      // not blank it. A character preset has no opinion about quality tags.
      if (incoming) next[field] = incoming;
      continue;
    }
    if (!incoming) continue;
    const already = String(next[field] ?? '').trim();
    if (!already) { next[field] = incoming; continue; }
    // Tag by tag, so adding a block that overlaps adds only what is missing.
    const have = new Set(already.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean));
    const adding = incoming.split(',').map(tag => tag.trim()).filter(tag => tag && !have.has(tag.toLowerCase()));
    next[field] = adding.length ? `${already}, ${adding.join(', ')}` : already;
  }
  return next;
};

/** Which preset, if any, is exactly what is in the boxes now. */
export const matchingPreset = (presets, form) => {
  const now = presetValues(form);
  return presets.find(item => FIELDS.every(field => item.values[field] === now[field])) || null;
};
