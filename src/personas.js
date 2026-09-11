/**
 * A persona: somebody to talk to, rather than a setting.
 *
 * This began as a list of saved system prompts — useful, but the wrong shape
 * for what people actually keep re-creating by hand. A "code reviewer" is not
 * only a prompt. It is a prompt *and* the model you want reviewing code (the
 * big one, slow, worth waiting for), *and* a temperature (low; a reviewer that
 * invents defects is worse than none), *and* an opening line that says what it
 * is for. Keeping those four things in four different places means setting all
 * four every time, and forgetting one.
 *
 * So a persona carries all of it, and a chat can belong to one. When it does,
 * the chat opens with the greeting, sends with that model and those sampling
 * numbers, and shows the persona's name and avatar on every answer — which is
 * the point of the feature: two chats with two personas should not look like
 * the same assistant twice.
 *
 * ## What is deliberately optional
 *
 * Every field except the name is. A persona with only a prompt is exactly the
 * saved prompt this replaced, and the old entries load unchanged — `model`,
 * `sampling`, `greeting` and `avatar` are simply absent, and absent means
 * "whatever the app is already set to". That matters beyond migration: a
 * persona that pins a model is unusable on a machine that does not have that
 * model, so pinning has to be a choice rather than part of the shape.
 *
 * ## What a persona is not
 *
 * It is not a lock. Applying one writes its prompt into the box, chooses its
 * model in the picker, and sets the sliders — all of which stay editable. The
 * library is a set of starting points; a chat that drifts away from its
 * persona is a chat, not an error.
 */
import { stampSetting } from './settingsStore.js';

const STORAGE_KEY = 'systemPrompts';

export const MAX_NAME = 60;
export const MAX_BODY = 20000;
export const MAX_GREETING = 2000;

/* The sampling numbers a persona may pin. The same field names the sampling
 * presets use, because they are the same controls — a persona that set
 * `temp` while the preset set `temperature` would be two spellings of one
 * idea, and the second one to be written would win at random. */
export const PERSONA_SAMPLING = [
  'temperature', 'topP', 'topK', 'repeatPenalty', 'minP',
  'presencePenalty', 'frequencyPenalty', 'maxTokens',
];

/* Bounds, so a persona restored from storage or typed in by hand cannot put
 * Ollama into a state where it refuses the request or quietly misbehaves. */
const LIMITS = {
  temperature: [0, 2], topP: [0, 1], topK: [0, 200], repeatPenalty: [0, 2],
  minP: [0, 1], presencePenalty: [-2, 2], frequencyPenalty: [-2, 2],
  maxTokens: [-1, 131072],
};

export const sanitiseSampling = (values = {}) => {
  const out = {};
  for (const field of PERSONA_SAMPLING) {
    if (values?.[field] === undefined || values[field] === null || values[field] === '') continue;
    const n = Number(values[field]);
    const range = LIMITS[field];
    if (!Number.isFinite(n) || !range) continue;
    out[field] = Math.min(Math.max(n, range[0]), range[1]);
  }
  return out;
};

let counter = 0;
const nextId = () => `sp${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * One avatar, as one or two characters.
 *
 * Emoji rather than an image on purpose. An uploaded picture would have to be
 * stored, synced and resized, and it would be the largest thing in the record
 * by two orders of magnitude — for a mark that is drawn at twenty-eight
 * pixels. Two characters is also enough for initials, which is what somebody
 * naming a persona after a person will reach for.
 */
export const cleanAvatar = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return [...text].slice(0, 2).join('');
};

export const newPersona = ({ name, body = '', avatar = '', model = '', greeting = '', sampling } = {}) => ({
  id: nextId(),
  name: String(name || '').trim().slice(0, MAX_NAME) || 'Untitled',
  body: String(body ?? '').slice(0, MAX_BODY),
  avatar: cleanAvatar(avatar),
  // Empty means "whatever is selected". A persona that pins a model this
  // machine has never pulled would otherwise be unusable rather than merely
  // unopinionated.
  model: String(model || ''),
  greeting: String(greeting ?? '').slice(0, MAX_GREETING),
  sampling: sanitiseSampling(sampling),
  createdAt: Date.now(),
});

/* A few to start from.
 *
 * Three that differ in kind rather than in wording, because the field is
 * easier to understand from contrast than from description. They are ordinary
 * entries: editable, deletable, and not restored if removed.
 */
export const BUILTIN_PERSONAS = [
  {
    id: 'builtin-concise',
    name: 'Concise',
    avatar: '⚡',
    body: 'Answer briefly and directly. No preamble, no summary of the question, '
      + 'no offers of further help. If something is uncertain, say so in a clause '
      + 'rather than a paragraph.',
    greeting: '',
    model: '',
    sampling: { temperature: 0.4 },
    builtin: true,
  },
  {
    id: 'builtin-reviewer',
    name: 'Code reviewer',
    avatar: '🔍',
    body: 'You are reviewing code written by a competent engineer. Point out real '
      + 'defects — wrong behaviour, unhandled cases, races — before style. Quote the '
      + 'line you mean. If the code is fine, say so instead of inventing something '
      + 'to improve.',
    greeting: 'Paste the code and say what it is meant to do. I will look for defects first and style second.',
    model: '',
    // Low, because a reviewer that invents defects is worse than no reviewer.
    sampling: { temperature: 0.2, topP: 0.9 },
    builtin: true,
  },
  {
    id: 'builtin-tutor',
    name: 'Explain it to me',
    avatar: '🎓',
    body: 'Explain things from the ground up, one idea at a time, checking that each '
      + 'step follows from the last. Prefer a concrete example over an abstract '
      + 'definition. Assume intelligence, not knowledge.',
    greeting: 'What would you like to understand? Tell me where to start from and I will build up from there.',
    model: '',
    sampling: { temperature: 0.7 },
    builtin: true,
  },
];

export const personaStorageKey = (userId) =>
  userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;

/** Fill in what an older record does not have, so one shape reaches the UI. */
const hydrate = (p) => ({
  avatar: '',
  model: '',
  greeting: '',
  sampling: {},
  ...p,
  sampling: sanitiseSampling(p.sampling),
});

export const loadPersonas = (userId) => {
  try {
    const raw = localStorage.getItem(personaStorageKey(userId));
    if (raw === null) return BUILTIN_PERSONAS.map(hydrate);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return BUILTIN_PERSONAS.map(hydrate);
    // An empty array is a real state — somebody deleted them all — and is
    // returned as such. Falling back to the built-ins here is how a deletion
    // undoes itself on the next reload.
    return parsed
      .filter(p => p && p.id && typeof p.name === 'string' && typeof p.body === 'string')
      .map(hydrate);
  } catch (e) {
    return BUILTIN_PERSONAS.map(hydrate);
  }
};

/**
 * Write the list, and record when it changed.
 *
 * The stamp is not bookkeeping: the whole list travels to the account as one
 * record, and the sync decides whether this device has anything to say by
 * comparing that record's timestamp against the one it last sent. A list saved
 * without a stamp is saved in this browser and nowhere else.
 */
export const savePersonas = (userId, personas) => {
  const key = personaStorageKey(userId);
  try {
    localStorage.setItem(key, JSON.stringify(personas));
    // (scope, key) -- called with one argument this stamped a scope named
    // after the key, under the key `undefined`, so `settingStamps(scope)[key]`
    // stayed absent and every upload of this list carried `updatedAt: 0`. The
    // server resolves by timestamp and treats a tie as "already have it", so
    // the first list to reach the account was the last one that ever did.
    stampSetting(userId, key);
  } catch (e) { /* quota */ }
  return personas;
};

/** Two prompts are the same prompt if they say the same thing. */
const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

/**
 * Which saved prompt is currently in effect, if any.
 *
 * By body rather than by a remembered id, because the box stays editable: a
 * stored id would still read "Code reviewer" after the text below it had been
 * replaced, which is worse than showing nothing.
 */
export const matchPersona = (personas, current) =>
  (personas || []).find(p => same(p.body, current)) || null;

/** The persona a chat belongs to, if it still exists. */
export const personaOf = (personas, session) =>
  (personas || []).find(p => p.id === session?.personaId) || null;

/**
 * Adding one, or replacing an existing one.
 *
 * `patch.id` is which entry is being edited, and it takes precedence over the
 * name. Without it this matched by name alone, which is right for "save the
 * current prompt as X" and wrong for the Edit button beside a row: renaming
 * "Reviwer" to "Reviewer" matched nothing, so the fix arrived as a second
 * persona and the typo stayed in the list next to it.
 *
 * A name that now collides with a *different* entry still merges into that
 * one. Two personas called the same thing are two rows nobody can tell apart.
 */
export const upsertPersona = (personas, name, patch = {}) => {
  const trimmed = String(name || '').trim().slice(0, MAX_NAME);
  if (!trimmed) return personas;
  const fields = typeof patch === 'string' ? { body: patch } : patch;
  const { id: editing, ...rest } = fields;
  const byName = (personas || []).find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  const existing = (editing && (personas || []).find(p => p.id === editing)) || byName;
  if (existing) {
    return personas.map(p => (p.id === existing.id
      ? hydrate({
        ...p,
        ...rest,
        name: trimmed,
        body: String(rest.body ?? p.body).slice(0, MAX_BODY),
        avatar: cleanAvatar(rest.avatar ?? p.avatar),
        greeting: String(rest.greeting ?? p.greeting ?? '').slice(0, MAX_GREETING),
        sampling: sanitiseSampling(rest.sampling ?? p.sampling),
        // An edited built-in is no longer a built-in; it is theirs.
        builtin: false,
      })
      : p));
  }
  return [...(personas || []), newPersona({ ...rest, name: trimmed })];
};

export const removePersona = (personas, id) => (personas || []).filter(p => p.id !== id);

/**
 * What a chat should look like when it is started as this persona.
 *
 * The greeting is an ordinary assistant message rather than a special kind of
 * thing, so everything that already works on an answer — copying it, quoting
 * it, reading it aloud, exporting it — works on this too. It carries `greeting`
 * only so the transcript can tell it apart from something the model said, and
 * `at` so it sorts where it belongs.
 */
export const openingMessages = (persona, now = Date.now()) => {
  const text = String(persona?.greeting || '').trim();
  if (!text) return [];
  return [{
    role: 'assistant',
    content: text,
    at: now,
    greeting: true,
    metrics: null,
    model: persona.model || null,
  }];
};
