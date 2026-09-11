// Who is asking.
//
// There were personas already, and they are the wrong half of the pair: they
// say who the assistant is. Nothing said who the person is, so every
// conversation opened with a model that did not know your name, what you do,
// what language you want back, or that you have written Rust for ten years and
// do not need the borrow checker explained again.
//
// The constraint that shapes everything: this goes into the system prompt of
// every request for ever, so a nine-hundred-token self-description is a
// permanent tax on a 4k context.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/userProfile.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.userprofile-test-bundle.mjs');
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

/* ------------------------------------------------------------- the fields */

eq('an empty profile has every field', Object.keys(P.emptyProfile()).length, P.FIELDS.length);
eq('and is empty', P.isEmpty(P.emptyProfile()), true);
eq('one with a name is not', P.isEmpty({ name: '재원' }), false);
eq('whitespace is still empty', P.isEmpty({ name: '   ' }), true);

eq('a field is trimmed', P.cleanField('name', '  재원  '), '재원');
// Everything except the free-text field is one line: a name with a newline in
// it breaks the block it is assembled into.
eq('a newline in a single-line field is flattened', P.cleanField('name', 'a\nb'), 'a b');
eq('but notes keep their shape', P.cleanField('notes', 'a\nb'), 'a\nb');
check('a long field is cut to its own cap',
  P.cleanField('name', 'x'.repeat(500)).length === P.FIELDS.find(f => f.key === 'name').max);
eq('a field that is not a field is nothing', P.cleanField('nonsense', 'x'), '');
eq('and undefined does not become "undefined"', P.cleanField('name', undefined), '');

/* ------------------------------------------------- a space can be typed

   The editor cleans every keystroke as it lands, and `cleanField` ends in
   `.trim()`. So the space pressed after a word was deleted by the same render
   that was supposed to show it: these fields did not merely trim on save, they
   refused spaces outright, for ever, in a form whose entire content is prose.
   In Korean that is not cosmetic -- `사용자 페르소나` without its space is a
   different string.

   `clampField` is what the editor uses: the same shaping, minus the trim. */

eq('a trailing space survives while it is still being typed',
  P.clampField('name', '김 정'), '김 정');
eq('and the space that is the last thing typed is kept',
  P.clampField('work', 'backend '), 'backend ');
eq('a leading one too, until it is stored',
  P.clampField('calls', ' 재'), ' 재');
eq('notes keep a trailing newline while writing',
  P.clampField('notes', 'one\n'), 'one\n');
// Interior runs still collapse. These are one-line fields and a double space
// inside one is a slip rather than an intention.
eq('but a double space inside is still one space',
  P.clampField('work', 'a  b'), 'a b');
eq('and the cap still applies',
  P.clampField('name', 'x'.repeat(500)).length, P.FIELDS.find(f => f.key === 'name').max);
// The trim has not gone anywhere; it has moved to where the value is stored.
eq('storing still takes the edges off', P.cleanField('work', 'backend '), 'backend');

/* --------------------------------------------- and it has to reach the account

   This was the one library that never travelled. Written on a phone it stayed
   on that phone: nothing collected it, and nothing stamped it either -- and an
   unstamped record carries `updatedAt: 0`, which the server reads as a tie and
   a tie means "already have it". */

store.clear();
P.saveProfile('srv-abc', { name: '재원' });
const stamps = JSON.parse(store.get('settingStamps@srv-abc') || '{}');
check('saving stamps the record against its own scope',
  Number(stamps[P.profileStorageKey('srv-abc')]) > 0,
  JSON.stringify(stamps));
eq('and the guest gets their own stamp bucket',
  Object.keys(JSON.parse(store.get('settingStamps@guest') || '{}')).length, 0);

/* -------------------------------------------------------------- the block */

const profile = {
  name: '재원', calls: '재원 씨', work: 'a graduate student',
  expertise: 'fluent in Python, new to Rust', language: 'Korean',
  style: 'short, code first', notes: 'I use a Windows machine.',
};
const block = P.formatProfile(profile);

// "name: 재원" in a system prompt reads to a model as a field it should echo;
// "Their name is 재원" reads as a fact. The difference shows up as the model
// opening every reply with your name.
check('it reads as statements, not as a form', /Their name is 재원\./.test(block));
check('the address form is given', /Address them as 재원 씨/.test(block));
check('what they know is in it', block.includes('new to Rust'));
check('so is the language', /Answer in Korean/.test(block));
check('and the free text is passed through', block.includes('Windows machine'));

// Without this, a model handed a self-description treats the description as
// the topic and answers the first question by commenting on your job.
check('it is told not to make this the subject', /not treat it as the subject/i.test(block));
check('and not to greet by name every message', /every message/i.test(block));

eq('an empty profile produces no block', P.formatProfile(P.emptyProfile()), '');
eq('and neither does nothing at all', P.formatProfile(undefined), '');
check('a profile with one field produces a short one',
  P.formatProfile({ language: 'Korean' }).split('\n').length <= 4);

/* --------------------------------------------------------------- the cost */

// Never dropped, never summarised, never retrieved conditionally: the one
// piece of prompt that is paid for on every single message.
const cost = P.estimateCost(profile);
check('a filled profile costs something', cost.tokens > 0);
eq('an empty one costs nothing', P.estimateCost(P.emptyProfile()).tokens, 0);
check('and a longer one costs more',
  P.estimateCost({ ...profile, notes: 'x'.repeat(500) }).tokens > cost.tokens);

/* ---------------------------------------------------------- what to fill in */

// An empty six-field form is a form people close. One that names the single
// field that would help most gets one answer.
eq('the field that changes most answers is suggested first',
  P.nextSuggestion(P.emptyProfile()), 'expertise');
eq('then the language', P.nextSuggestion({ expertise: 'x' }), 'language');
// A name changes a greeting; what you already know changes every explanation.
check('the name is not the first thing asked for',
  P.nextSuggestion(P.emptyProfile()) !== 'name');
eq('a full profile suggests nothing',
  P.nextSuggestion(Object.fromEntries(P.FIELDS.map(f => [f.key, 'x']))), null);

/* --------------------------------------------------------------- storage */

store.clear();
P.saveProfile('', profile);
eq('a profile survives a reload', P.loadProfile('').name, '재원');
eq('an account keeps its own', P.loadProfile('srv-alice').name, '');
store.set(P.profileStorageKey(''), 'not json');
eq('unreadable storage is an empty profile rather than a crash', P.isEmpty(P.loadProfile('')), true);
// A field removed from the code should not resurface as a line in the prompt.
store.set(P.profileStorageKey(''), JSON.stringify({ name: 'x', obsolete: 'y' }));
eq('a field that is no longer a field is dropped', 'obsolete' in P.loadProfile(''), false);
// Storage is the boundary a too-long value would otherwise cross.
store.set(P.profileStorageKey(''), JSON.stringify({ name: 'x'.repeat(500) }));
check('and an over-long stored value is cut on the way in',
  P.loadProfile('').name.length <= P.FIELDS.find(f => f.key === 'name').max);

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the profile reaches the system prompt', /formatProfile\(userProfile\)/.test(code));
// Stated fact before things inferred from earlier conversations, so a model
// reading both treats a contradiction the right way round.
check('before what was merely inferred about them',
  code.indexOf('profileBlock,') < code.indexOf('memoryBlock,'));
check('it is stored per profile', /saveProfile\(profileScope/.test(code));
check('and every field is editable', /PROFILE_FIELDS\.map/.test(code));
// The editor must not use the storing form, or the trim comes straight back.
check('the editor clamps rather than cleans', /clampField\(field\.key/.test(code));
check('and does not trim on every keystroke', !/cleanField\(field\.key/.test(code));

const sync = fs.readFileSync(path.join(ROOT, 'src/syncEngine.js'), 'utf8');
check('the sync knows where the profile lives', sync.includes('userProfile:'));
check('it is one of the whole-list records',
  /const WHOLE_LISTS = \[[^\]]*'profile'/.test(sync));

const records = fs.readFileSync(path.join(ROOT, 'server/records.js'), 'utf8');
check('the server accepts the record kind', /KINDS = new Set\(\[[\s\S]*?'profile'[\s\S]*?\]\)/.test(records));

// Without this the guest's sweep -- every bare key with no `@` in it -- picks
// up `userProfile:srv-abc` as well and syncs one account's profile as another's.
const settings = fs.readFileSync(path.join(ROOT, 'src/settingsStore.js'), 'utf8');
check('and it is not also mistaken for a plain setting', settings.includes("'userProfile'"));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['profile.title', 'profile.expertise', 'profile.cost', 'profile.suggest']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}
// Every field needs a label and a hint, or the form is a row of empty boxes.
for (const field of ['name', 'calls', 'work', 'expertise', 'language', 'style', 'notes']) {
  eq(`"${field}" has a label everywhere`, (i18n.split(`'profile.${field}':`).length - 1), 12);
  eq(`and a hint everywhere`, (i18n.split(`'profile.${field}Hint':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
check('.profile-field is styled', css.includes('.profile-field'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
