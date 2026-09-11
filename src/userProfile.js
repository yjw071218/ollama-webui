/**
 * Who is asking.
 *
 * There are personas in this app already, and they are the wrong half of the
 * pair: they say who the *assistant* is. Nothing said who the person is, so
 * every conversation opened with a model that did not know your name, what you
 * do, what language you want back, or that you have been writing Rust for ten
 * years and do not need the borrow checker explained again. People supply that
 * by hand, in the first message, for ever.
 *
 * ## Fields, not a free-text box
 *
 * A single "tell the model about yourself" textarea is what most apps ship and
 * it produces two failures. People write a paragraph of prose that the model
 * half-ignores, and — worse — they write far too much, because nothing on
 * screen suggests a length. Six short fields with specific questions produce
 * shorter, more usable answers, and the block that goes to the model is
 * assembled rather than pasted.
 *
 * There is still a free-text field at the end, because the six will never
 * cover everybody. It is last and it is labelled as the exception.
 *
 * ## Sent every turn, so it has to be small
 *
 * This goes into the system prompt of every request, which means every token
 * of it is paid for on every message for ever. Hence the per-field caps: not
 * to be stingy, but because a nine-hundred-token self-description is a
 * permanent tax on a 4k context and nobody would consent to that if the cost
 * were shown. `estimateCost` is what shows it.
 */

import { stampSetting } from './settingsStore.js';

export const FIELDS = [
  { key: 'name', max: 60 },
  { key: 'calls', max: 60 },      // what the model should call them
  { key: 'work', max: 200 },      // what they do
  { key: 'expertise', max: 200 }, // what they already know
  { key: 'language', max: 60 },   // what to answer in
  { key: 'style', max: 200 },     // how they want to be answered
  { key: 'notes', max: 600 },     // everything else
];

export const MAX_TOTAL = 1400;

const CAP = new Map(FIELDS.map(f => [f.key, f.max]));

/** One field, shaped to its cap but with its edges left alone.
 *
 * The difference between this and `cleanField` is one `.trim()`, and that
 * `.trim()` is why a space could not be typed into any of these fields. The
 * editor cleans every keystroke as it lands, so the space pressed after a word
 * was removed by the same render that was supposed to show it — the field
 * simply refused spaces, for ever, and in a form whose whole content is prose.
 *
 * Interior runs still collapse, because these are one-line fields and a double
 * space in one is a slip. Only the edges wait, and only until the value is
 * stored or sent.
 */
export const clampField = (key, value) => {
  const max = CAP.get(key);
  if (!max) return '';
  const text = String(value ?? '');
  const flat = key === 'notes' ? text.replace(/\r\n/g, '\n') : text.replace(/\s+/g, ' ');
  return flat.slice(0, max);
};

/** One field, trimmed to its cap. Newlines survive only in `notes`. */
export const cleanField = (key, value) => {
  const max = CAP.get(key);
  if (!max) return '';
  const text = String(value ?? '');
  const flat = key === 'notes' ? text.replace(/\r\n/g, '\n') : text.replace(/\s+/g, ' ');
  return flat.trim().slice(0, max);
};

export const emptyProfile = () => Object.fromEntries(FIELDS.map(f => [f.key, '']));

export const cleanProfile = (profile = {}) =>
  Object.fromEntries(FIELDS.map(f => [f.key, cleanField(f.key, profile?.[f.key])]));

export const isEmpty = (profile) =>
  FIELDS.every(f => !String(profile?.[f.key] || '').trim());

export const profileStorageKey = (userId) => (userId ? `userProfile:${userId}` : 'userProfile');

/* The key `syncEngine.js` carries this under. Named here rather than there so
 * the storage key and the record it travels as cannot drift apart. */
export const PROFILE_RECORD_KIND = 'profile';

export const loadProfile = (userId) => {
  try {
    const raw = JSON.parse(localStorage.getItem(profileStorageKey(userId)) || 'null');
    return raw && typeof raw === 'object' ? cleanProfile(raw) : emptyProfile();
  } catch (e) {
    return emptyProfile();
  }
};

/**
 * Write it, and record when it changed.
 *
 * The stamp is the whole of "I wrote this on my phone and it is not on the
 * laptop". This record travels to the account like the folders and the presets
 * do, and the sync decides whether this device has anything to say by comparing
 * the stamp against the one it last sent. Written without one, a profile is
 * saved in this browser and nowhere else — and, worse, a stamp of zero ties
 * with every other device's zero, so the *first* upload wins for ever and no
 * later edit ever propagates.
 */
export const saveProfile = (userId, profile) => {
  const key = profileStorageKey(userId);
  try {
    localStorage.setItem(key, JSON.stringify(cleanProfile(profile)));
    stampSetting(userId, key);
  } catch (e) { /* quota, or storage disabled */ }
};

/**
 * The block the model is given.
 *
 * Written as statements rather than as a form dump, because "name: 재원" in a
 * system prompt reads to a model as a field it should echo, while "Their name
 * is 재원" reads as a fact. The difference shows up as the model opening every
 * reply with your name until you ask it to stop.
 *
 * The last line matters as much as the rest: without it a model handed a
 * self-description treats the description as the topic, and answers the first
 * question of the conversation by commenting on how interesting your job is.
 */
export const formatProfile = (profile) => {
  const clean = cleanProfile(profile);
  if (isEmpty(clean)) return '';

  const lines = [];
  if (clean.name) lines.push(`Their name is ${clean.name}.`);
  if (clean.calls) lines.push(`Address them as ${clean.calls}.`);
  if (clean.work) lines.push(`What they do: ${clean.work}`);
  if (clean.expertise) lines.push(`What they already know: ${clean.expertise}`);
  if (clean.language) lines.push(`Answer in ${clean.language} unless they write in another language.`);
  if (clean.style) lines.push(`How they want answers: ${clean.style}`);
  if (clean.notes) lines.push(clean.notes);

  return [
    '[Who you are talking to]',
    ...lines,
    'Use this to pitch the answer. Do not mention it, do not greet them by name'
    + ' every message, and do not treat it as the subject of the conversation.',
  ].join('\n');
};

/**
 * What carrying this costs, every message, for ever.
 *
 * Shown in the editor rather than kept as a curiosity: a profile is the one
 * piece of prompt that is never dropped, never summarised and never retrieved
 * conditionally, so a person writing their life story into it deserves to see
 * the meter move while they type.
 */
export const estimateCost = (profile) => {
  const text = formatProfile(profile);
  if (!text) return { tokens: 0, chars: 0 };
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) wide++;
  return {
    chars: text.length,
    tokens: Math.ceil((text.length - wide) / 4 + wide / 1.5),
  };
};

/**
 * What is worth filling in next.
 *
 * An empty six-field form is a form people close. One that says which single
 * field would help most gets one answer, and one answer is enough to be worth
 * having. Ordered by how much each changes an answer rather than by how
 * personal it is: what you already know changes every explanation; your name
 * changes a greeting.
 */
export const nextSuggestion = (profile) => {
  const clean = cleanProfile(profile);
  const order = ['expertise', 'language', 'style', 'work', 'name', 'calls', 'notes'];
  return order.find(key => !clean[key]) || null;
};
