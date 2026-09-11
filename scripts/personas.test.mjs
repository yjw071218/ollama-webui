// Saved system prompts, and the two ways a library like this goes wrong.
//
// The first is deletion that undoes itself. If "nothing saved" and "never
// opened this app" are the same stored value, the built-ins come back on the
// next reload and the delete button looks broken. An empty array has to be a
// real state, distinct from an absent key.
//
// The second is a label that lies. The prompt box stays editable after a saved
// prompt is applied, so remembering *which one was picked* means the panel goes
// on saying "Code reviewer" over text that has since been rewritten. Which one
// is in effect is therefore worked out by comparing bodies, not by storing an
// id.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/personas.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.personas-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

// The module reads localStorage at call time, so a stand-in is enough.
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

/* ------------------------------------------------------------ the defaults */

store.clear();
const fresh = P.loadPersonas('');
check('a new install starts with something to look at', fresh.length > 0);
check('and each one has a name and a body',
  fresh.every(p => p.id && p.name && typeof p.body === 'string' && p.body.length > 0));
check('they differ in kind rather than in wording',
  new Set(fresh.map(p => p.name)).size === fresh.length);

/* ----------------------------------------------- deleting them has to stick */

// The bug this exists to prevent: "empty" falling back to the built-ins, so
// the last delete silently undoes itself on the next reload.
P.savePersonas('', []);
eq('an empty library stays empty', P.loadPersonas('').length, 0);
check('which is not the same as never having opened the app',
  P.loadPersonas('').length !== fresh.length);

store.clear();
eq('but an absent key still gives the starting set', P.loadPersonas('').length, fresh.length);

/* -------------------------------------------------------------- the scopes */

store.clear();
P.savePersonas('', [P.newPersona({ name: 'Guest only', body: 'g' })]);
P.savePersonas('srv-alice', [P.newPersona({ name: 'Alice A', body: 'a' }), P.newPersona({ name: 'Alice B', body: 'b' })]);
eq('the guest keeps their own list', P.loadPersonas('').length, 1);
eq('and an account keeps its own', P.loadPersonas('srv-alice').length, 2);
eq("one does not leak into the other", P.loadPersonas('srv-alice')[0].name, 'Alice A');
check('and they are separate storage keys',
  P.personaStorageKey('') !== P.personaStorageKey('srv-alice'));

/* --------------------------------------------------------- adding and naming */

let list = [];
list = P.upsertPersona(list, 'Reviewer', 'Review code.');
eq('adding one adds one', list.length, 1);
eq('with the body given', list[0].body, 'Review code.');

list = P.upsertPersona(list, 'Reviewer', 'Review code, briefly.');
eq('the same name replaces rather than duplicates', list.length, 1);
eq('and keeps the newer body', list[0].body, 'Review code, briefly.');

list = P.upsertPersona(list, 'reviewer', 'lowercase');
eq('the match ignores case, because people do', list.length, 1);

list = P.upsertPersona(list, '  Spaced  ', 'x');
eq('a name is trimmed', list[1].name, 'Spaced');
eq('an unnamed one is refused', P.upsertPersona(list, '   ', 'x').length, list.length);

const longName = P.upsertPersona([], 'n'.repeat(500), 'x')[0].name;
check('a very long name is cut to the limit', longName.length <= P.MAX_NAME, String(longName.length));
const longBody = P.upsertPersona([], 'x', 'b'.repeat(P.MAX_BODY + 500))[0].body;
eq('and a very long body too', longBody.length, P.MAX_BODY);

eq('two made in the same millisecond still differ',
  P.newPersona({ name: 'a', body: 'x' }).id === P.newPersona({ name: 'a', body: 'x' }).id, false);

/* ------------------------------------------------- which one is in effect */

const saved = [
  P.newPersona({ name: 'Concise', body: 'Answer briefly.' }),
  P.newPersona({ name: 'Tutor', body: 'Explain from the ground up.' }),
];
eq('the one whose text is in the box', P.matchPersona(saved, 'Answer briefly.')?.name, 'Concise');
eq('whitespace either side does not hide it', P.matchPersona(saved, '  Answer briefly.\n')?.name, 'Concise');
eq('text nobody saved matches nothing', P.matchPersona(saved, 'Something else'), null);

// The label that lies. Editing the box after applying a prompt must stop it
// claiming to be that prompt.
eq('an edited prompt no longer claims to be the saved one',
  P.matchPersona(saved, 'Answer briefly, in Korean.'), null);

eq('an empty box matches nothing', P.matchPersona(saved, ''), null);
eq('and neither does a missing library', P.matchPersona(null, 'Answer briefly.'), null);

/* ------------------------------------------------------------- removing */

const three = [P.newPersona({ name: 'a', body: '1' }), P.newPersona({ name: 'b', body: '2' }), P.newPersona({ name: 'c', body: '3' })];
eq('removing takes one out', P.removePersona(three, three[1].id).length, 2);
eq('and it is the right one',
  P.removePersona(three, three[1].id).map(p => p.name).join(''), 'ac');
eq('removing something absent changes nothing', P.removePersona(three, 'nope').length, 3);

/* --------------------------------------------------- surviving bad storage */

store.clear();
store.set(P.personaStorageKey(''), 'not json at all');
eq('unreadable storage falls back rather than throwing', P.loadPersonas('').length, fresh.length);
store.set(P.personaStorageKey(''), '{"not":"an array"}');
eq('and so does the wrong shape', P.loadPersonas('').length, fresh.length);
store.set(P.personaStorageKey(''), '[{"id":"ok","name":"Fine","body":"x"},{"broken":true},null]');
eq('entries that are not personas are dropped', P.loadPersonas('').length, 1);

/* ------------------------------------------------ it has to reach the account

   The list travels to the account as one record, and the sync decides whether
   this device has anything to send by comparing that record's timestamp with
   the one it last sent. A list saved without a stamp is saved in this browser
   and nowhere else -- which is the same bug src/sessionEdit.js was written
   for, in a different place. */

const app = fs.readFileSync(path.join(ROOT, 'src/personas.js'), 'utf8');
// With the scope, not just with the key. `stampSetting(key)` -- one argument,
// where the signature is (scope, key, at) -- type-checks in JavaScript, stamps
// a scope named after the key under the key `undefined`, and leaves the record
// carrying `updatedAt: 0`. The server treats a tie as "already have it", so
// the first list to reach the account was the last one that ever did: a
// persona made on a phone never appeared on the desktop.
check('saving stamps the key against its scope',
  /stampSetting\(\s*userId\s*,\s*key\s*\)/.test(app));

const sync = fs.readFileSync(path.join(ROOT, 'src/syncEngine.js'), 'utf8');
check('the sync knows where the list lives', sync.includes('systemPrompts:'));
// Collected and applied. Both sides read one table, so a kind added to the
// upload and forgotten in the download -- a record that leaves and never comes
// back -- is no longer expressible.
check('personas are one of the whole-list records',
  /const WHOLE_LISTS = \[[^\]]*'personas'/.test(sync));
eq('and the table drives both directions',
  (sync.match(/WHOLE_LISTS\.map\(/g) || []).length, 2);

const records = fs.readFileSync(path.join(ROOT, 'server/records.js'), 'utf8');
check('the server accepts the record kind', /KINDS = new Set\(\[[^\]]*'personas'/.test(records));

// Without this the key reads back as a setting called `systemPrompts`
// belonging to whichever scope, and then syncs itself to every device twice.
const settings = fs.readFileSync(path.join(ROOT, 'src/settingsStore.js'), 'utf8');
check('and it is not also mistaken for a plain setting', settings.includes("'systemPrompts'"));

/* --------------------------------------------------------- the strings */

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['persona.saved', 'persona.apply', 'persona.savedAs', 'persona.chatOverrides', 'persona.switch']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
