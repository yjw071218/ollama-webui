// A chat that nobody has said anything in yet.
//
// Pressing "new chat" used to create a conversation: a row in the sidebar, a
// record in storage, an upload to the account — before a word had been typed.
// Open the app on a laptop and a phone, glance at each, and you had made two
// chats called "New Chat" and synced them to each other.
//
// Two things have to hold, and they pull in opposite directions:
//
//   * A draft must be invisible and unsaved until the first message.
//   * A chat somebody *cleared* must not be mistaken for one. It has a title
//     they chose, a folder, a place in the list, and it stays.
//
// Inferring from `messages.length === 0` gets the first right and the second
// catastrophically wrong, which is why the flag is explicit.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/draftChat.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.draft-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  isDraft, newDraft, promoted, withoutStaleDrafts, persistable, nextSessionId,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ what it is */

const draft = newDraft('llama3');
check('a new chat starts as a draft', isDraft(draft));
eq('it carries the model it was started with', draft.lastModel, 'llama3');
eq('and nothing has been said in it', draft.messages.length, 0);

/* ----------------------------------------------- the first message ends it */

const spoken = promoted({ ...draft, messages: [{ role: 'user', content: 'hello' }] });
check('saying something makes it a conversation', !isDraft(spoken));
eq('and the message is still there', spoken.messages.length, 1);
// `draft: undefined` and no key at all are the same thing to JSON, which is
// what storage and the sync both speak.
check('the flag does not survive being stored',
  !('draft' in JSON.parse(JSON.stringify(spoken))));

/* --------------------------------------- a cleared chat is not a draft

   The distinction the whole design rests on. Somebody who empties a chat has
   an empty conversation, not a blank slate: it keeps its title, its folder and
   its row. Inferring drafts from `messages.length === 0` would delete it. */

const cleared = { id: 7, title: 'Notes on flexbox', messages: [], folderId: 'f1', createdAt: 1, updatedAt: 2 };
check('a chat someone emptied is not a draft', !isDraft(cleared));
check('so it still reaches storage', persistable([cleared]).length === 1);
eq('with its title intact', persistable([cleared])[0].title, 'Notes on flexbox');

/* ------------------------------------------------------- what gets stored */

const real = { id: 1, title: 'Real', messages: [{ role: 'user', content: 'x' }] };
const mixed = [newDraft(), real, newDraft()];
eq('drafts are kept out of storage', persistable(mixed).length, 1);
eq('and the real one goes in', persistable(mixed)[0].title, 'Real');
eq('an empty list stays empty', persistable([]).length, 0);
eq('and a missing one does not throw', persistable(null).length, 0);

/* ---------------------------------------------------- one draft, not three */

const a = newDraft(), b = newDraft(), c = newDraft();
const after = withoutStaleDrafts([a, real, b], c.id);
eq('the earlier drafts are dropped', after.length, 1);
eq('and the real chat is not', after[0].title, 'Real');
check('the one being kept survives',
  withoutStaleDrafts([a, real], a.id).some(s => s.id === a.id));

/* ----------------------------------------------- ids that cannot collide

   `Date.now()` was the id. Three clicks inside one millisecond made three
   chats sharing one, `reviseSession` matched on it and wrote the first message
   into all three, and the sidebar grew three identical rows -- while storage,
   which keys by id, kept one. This was found by clicking the button three
   times in a browser, so it is a test now. */

const ids = Array.from({ length: 500 }, () => nextSessionId());
eq('five hundred ids in a row are all different', new Set(ids).size, 500);
check('and they ascend', ids.every((id, i) => i === 0 || id > ids[i - 1]));
check('they are numbers, because the app compares them with ===',
  ids.every(id => typeof id === 'number'));

const rapid = [newDraft(), newDraft(), newDraft()];
eq('three drafts made at once have three ids', new Set(rapid.map(s => s.id)).size, 3);

/* --------------------------------------------------------- the call sites */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// The bug was not only in `createNewSession`: every place that mints a chat
// could collide on a double click, and two records with one id can never be
// told apart again.
eq('nothing mints an id from the clock any more', (code.match(/id: Date\.now\(\)/g) || []).length, 0);
check('they all go through the generator', (code.match(/id: nextSessionId\(\)/g) || []).length >= 6);

check('the sidebar hides drafts', /visibleSessions = sortedSessions\.filter\(s => !isDraft\(s\)/.test(code));
check('storage is filtered in one place', /list = persistable\(list\);/.test(code));
check('pressing new chat drops the previous draft', /withoutStaleDrafts\(prev, newSession\.id\)/.test(code));
check('and the first message promotes it', /promoted\(\{/.test(code));

// The screen before a conversation is a different layout, not an empty one.
check('the column says when it is blank', /is-blank/.test(code));
const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
check('and the stylesheet centres the greeting with the composer',
  /\.claude-main\.is-blank \.messages-scroll-area/.test(css) && /margin-top: auto/.test(css));
check('the suggestions sit under the composer, not over it',
  code.indexOf('starter-grid') > code.indexOf('input-area-wrapper'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
