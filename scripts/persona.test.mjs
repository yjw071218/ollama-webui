// A persona: somebody to talk to, rather than a setting.
//
// This started as a list of saved system prompts, which is the wrong shape for
// what people kept re-creating by hand. A "code reviewer" is a prompt *and* the
// model you want reviewing code *and* a low temperature (a reviewer that
// invents defects is worse than none) *and* an opening line saying what it is
// for. Four things in four places means setting all four every time.
//
// Two properties carry the design and pull against each other:
//
//   * Everything except the name is optional, and absent means "whatever the
//     app is already set to". A persona that pins a model is unusable on a
//     machine without that model, so pinning has to be a choice — and the old
//     prompt-only entries have to keep loading.
//   * A chat belongs to a persona by id, not by matching its prompt text. A
//     chat stays that persona's after its prompt is edited, and two personas
//     that happen to share a prompt are still two people.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/personas.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.persona-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const P = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the shape */

const reviewer = P.newPersona({
  name: 'Reviewer',
  avatar: '🔍',
  body: 'Review code.',
  greeting: 'Paste the code.',
  model: 'qwen3:8b',
  sampling: { temperature: 0.2, topP: 0.9 },
});
eq('a persona has a name', reviewer.name, 'Reviewer');
eq('an avatar', reviewer.avatar, '🔍');
eq('a model it prefers', reviewer.model, 'qwen3:8b');
eq('an opening line', reviewer.greeting, 'Paste the code.');
eq('and the sampling it wants', reviewer.sampling.temperature, 0.2);

// The minimum. Everything else absent means "whatever is already set", which
// is what lets one persona work on two machines with different models.
const bare = P.newPersona({ name: 'Plain' });
eq('a persona can be nothing but a name', bare.name, 'Plain');
eq('with no model pinned', bare.model, '');
eq('no avatar', bare.avatar, '');
eq('and nothing pinned in sampling', Object.keys(bare.sampling).length, 0);

/* ------------------------------------------------------- the old entries */

// What this replaced wrote: an id, a name and a body. They have to keep
// loading, and to arrive with the new fields filled in rather than undefined,
// so the UI does not have to check for both shapes everywhere.
store.clear();
store.set(P.personaStorageKey(''), JSON.stringify([
  { id: 'old1', name: 'Old prompt', body: 'Be terse.' },
]));
const migrated = P.loadPersonas('');
eq('an entry from before this change still loads', migrated.length, 1);
eq('with its prompt', migrated[0].body, 'Be terse.');
eq('an avatar it never had', migrated[0].avatar, '');
eq('a model it never had', migrated[0].model, '');
eq('and sampling it never had', JSON.stringify(migrated[0].sampling), '{}');

/* ------------------------------------------------------------- the avatar */

eq('one glyph is kept', P.cleanAvatar('🔍'), '🔍');
eq('two are kept', P.cleanAvatar('AB'), 'AB');
eq('a sentence is cut to two', P.cleanAvatar('Reviewer'), 'Re');
eq('whitespace goes', P.cleanAvatar('  ⚡  '), '⚡');
eq('nothing stays nothing', P.cleanAvatar(''), '');
eq('and undefined does not become "undefined"', P.cleanAvatar(undefined), '');
// A surrogate pair is one character to a reader and two to `.slice`, so
// cutting by code unit would leave half an emoji.
eq('an emoji is one character, not two code units', [...P.cleanAvatar('👩‍🔬x')].length <= 2, true);

/* --------------------------------------------------------- the sampling */

const wild = P.sanitiseSampling({ temperature: 99, topP: -3, topK: 'abc', nonsense: 5 });
eq('a temperature past the limit is clamped', wild.temperature, 2);
eq('and below it too', wild.topP, 0);
eq('a value that is not a number is dropped', 'topK' in wild, false);
eq('and a field that is not a sampling setting', 'nonsense' in wild, false);
eq('an empty string is not zero', 'temperature' in P.sanitiseSampling({ temperature: '' }), false);

/* ------------------------------------------------ which persona a chat is */

const list = [reviewer, P.newPersona({ name: 'Tutor', body: 'Explain things.' })];

eq('a chat belongs to the persona it names',
  P.personaOf(list, { personaId: reviewer.id })?.name, 'Reviewer');
eq('a chat with no persona belongs to none', P.personaOf(list, { id: 1 }), null);
eq('and one naming a deleted persona too', P.personaOf(list, { personaId: 'gone' }), null);

/* The id, not the prompt. A chat stays this persona's after its prompt has
   been edited -- otherwise the avatar and the name would vanish from a
   conversation the moment somebody adjusted its instructions. */
eq('editing the prompt does not orphan the chat',
  P.personaOf(list, { personaId: reviewer.id, systemPrompt: 'something else' })?.id, reviewer.id);

// `matchPersona` answers a different question -- "is this text one of the
// saved ones" -- and is what the settings panel uses.
eq('the settings panel can still match by text',
  P.matchPersona(list, 'Review code.')?.name, 'Reviewer');
eq('and matches nothing once the text changes',
  P.matchPersona(list, 'Review code, briefly.'), null);

/* --------------------------------------------------------- the greeting */

const opening = P.openingMessages(reviewer, 5000);
eq('a greeting becomes one message', opening.length, 1);
eq('from the assistant', opening[0].role, 'assistant');
eq('carrying the text', opening[0].content, 'Paste the code.');
eq('dated', opening[0].at, 5000);
// Marked so the transcript can tell it from something the model said, but
// otherwise an ordinary message: copying, quoting and exporting all work.
eq('and marked as a greeting', opening[0].greeting, true);
eq('a persona with no greeting opens with nothing', P.openingMessages(bare).length, 0);
eq('and so does no persona at all', P.openingMessages(null).length, 0);
eq('whitespace is not a greeting', P.openingMessages({ greeting: '   ' }).length, 0);

/* ------------------------------------------------------- adding and editing */

let saved = [];
saved = P.upsertPersona(saved, 'Reviewer', { body: 'Review.', avatar: '🔍', model: 'm1' });
eq('adding one adds one', saved.length, 1);
eq('with everything given', saved[0].model, 'm1');

saved = P.upsertPersona(saved, 'Reviewer', { body: 'Review, briefly.' });
eq('the same name replaces rather than duplicates', saved.length, 1);
eq('the new body lands', saved[0].body, 'Review, briefly.');
eq('and what was not mentioned is kept', saved[0].avatar, '🔍');

// A built-in that has been edited is no longer a built-in; it is theirs.
let builtins = P.BUILTIN_PERSONAS.map(p => ({ ...p }));
builtins = P.upsertPersona(builtins, 'Concise', { body: 'Changed.' });
eq('an edited built-in stops claiming to be one',
  builtins.find(p => p.name === 'Concise').builtin, false);

eq('an unnamed persona is refused', P.upsertPersona(saved, '   ', { body: 'x' }).length, saved.length);
const longName = P.upsertPersona([], 'n'.repeat(500), { body: 'x' })[0].name;
check('a very long name is cut', longName.length <= P.MAX_NAME, String(longName.length));

/* -------------------------------------------------- deleting them sticks */

// "Nothing saved" and "never opened this app" must be different stored values,
// or the last delete undoes itself on the next reload.
store.clear();
P.savePersonas('', []);
eq('an empty library stays empty', P.loadPersonas('').length, 0);
store.clear();
check('but an absent key gives the starting set', P.loadPersonas('').length > 0);

store.set(P.personaStorageKey(''), 'not json');
check('unreadable storage falls back rather than throwing', P.loadPersonas('').length > 0);

/* ----------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('a chat can be started as a persona', /const startChatAsPersona = /.test(code));
check('which records who it is with', /personaId: persona\.id/.test(code));
check('the answers carry the persona avatar', /chatPersona\?\.avatar/.test(code));
check('the send path reads the prompt from the persona, not the settings box',
  /persona\?\.body \|\| systemPrompt/.test(code));
check('and reads the list through a ref, since a turn outlives the render',
  /personasRef\.current/.test(code));
check('applying one sets its model', /setSelectedModel\(persona\.model\)/.test(code));
check('and its sampling', /SAMPLING_SETTERS\[field\]/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['persona.pickTitle', 'persona.startChat', 'persona.pinSetup', 'persona.anyModel']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
