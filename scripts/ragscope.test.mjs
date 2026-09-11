// Which documents a chat may search.
//
// Attachments are indexed rather than truncated now, which was the right fix
// and made a second problem visible: every indexed document went into one flat
// library that every chat searched. A tuition invoice attached on Monday was
// still being retrieved into an unrelated question about code on Friday —
// silently, because retrieval never reports what it chose not to find. It was
// not a bug in retrieval. Nothing recorded where a document came from, so
// there was nothing to filter on.
//
// Three kinds share the library now and they are not interchangeable:
// a document added in Settings belongs to everyone, one pinned to a folder
// belongs to that project, and one that arrived as an attachment belongs to
// the chat it arrived in.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleOne = async (entry, out, external = []) => {
  const b = await rolldown({ input: path.resolve(HERE, entry), external, platform: 'neutral' });
  const file = path.resolve(HERE, out);
  await b.write({ file, format: 'esm' });
  await b.close();
  return import(pathToFileURL(file).href);
};

const rag = await bundleOne('../src/rag.js', '../node_modules/.ragscope-test-bundle.mjs',
  ['localforage', 'pdfjs-dist', 'mammoth']);
const scope = await bundleOne('../src/profileScope.js', '../node_modules/.ragscope-profile-bundle.mjs');
const { visibleDocuments } = rag;
const { deriveScope } = scope;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const names = (docs) => docs.map(d => d.name).sort().join(',');
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const LIBRARY = [
  { id: '1', name: 'manual.pdf' },                                  // added in Settings
  { id: '2', name: 'invoice.pdf', chatId: 'chat-a' },               // attached in one chat
  { id: '3', name: 'notes.txt', chatId: 'chat-b' },                 // attached in another
  { id: '4', name: 'spec.md', folderId: 'folder-x' },               // pinned to a project
  { id: '5', name: 'old.txt', chatId: 'chat-a', enabled: false },   // switched off
];

/* ---------------------------------------------------------- the three kinds */

eq('a chat sees the shared library and its own attachments',
  names(visibleDocuments(LIBRARY, { chatId: 'chat-a' })), 'invoice.pdf,manual.pdf');

// The one that matters: chat B must not see what was attached to chat A.
eq('and never another chat\'s attachments',
  names(visibleDocuments(LIBRARY, { chatId: 'chat-b' })), 'manual.pdf,notes.txt');

eq('a chat in the folder also sees what is pinned there',
  names(visibleDocuments(LIBRARY, { chatId: 'chat-a', folderId: 'folder-x' })),
  'invoice.pdf,manual.pdf,spec.md');

eq('a chat in a different folder does not',
  names(visibleDocuments(LIBRARY, { chatId: 'chat-a', folderId: 'folder-y' })),
  'invoice.pdf,manual.pdf');

eq('a chat in no folder does not', names(visibleDocuments(LIBRARY, { chatId: 'chat-a', folderId: null })),
  'invoice.pdf,manual.pdf');

eq('a brand new chat sees only the shared library',
  names(visibleDocuments(LIBRARY, { chatId: 'chat-new' })), 'manual.pdf');

/* ------------------------------------------------------------- the corners */

// Switching a document off has to keep working, and has to beat ownership.
check('a disabled document is invisible even to its own chat',
  !visibleDocuments(LIBRARY, { chatId: 'chat-a' }).some(d => d.name === 'old.txt'));

// Ids come back from storage as whatever JSON made of them; a chat id is a
// number in the session list and a string on the document.
eq('a numeric chat id matches its string form',
  names(visibleDocuments([{ id: '9', name: 'x.txt', chatId: '77' }], { chatId: 77 })), 'x.txt');

eq('no library is no documents', names(visibleDocuments(null, { chatId: 'a' })), '');
eq('an empty library is no documents', names(visibleDocuments([], { chatId: 'a' })), '');
eq('rubbish in the library does not throw',
  names(visibleDocuments([null, undefined, { id: '1', name: 'ok.txt' }], { chatId: 'a' })), 'ok.txt');
eq('asked with no scope at all, only shared documents',
  names(visibleDocuments(LIBRARY)), 'manual.pdf');

/* --------------------------------------------- the key the library lives at

   Separately from scoping, and found while wiring it: the knowledge panel was
   handed `user?.id` while everything else used `deriveScope(user)`. Those are
   two different strings the moment somebody signs in, so a document added in
   Settings was written to `knowledge:42`, while the chat retrieved from
   `knowledge:srv-42` and the sync engine synced `knowledge:srv-42`. It was
   listed in the panel, never retrieved, and never synced.

   It worked perfectly for the guest, because both spell `knowledge:guest`,
   which is exactly why nobody saw it. */

// `keyFor` is rag.js's, reproduced: it is one line and importing the module's
// private is not worth a re-export.
const keyFor = (userId) => `knowledge:${userId || 'guest'}`;

check('signed in, the panel and the chat used different keys',
  keyFor(42) !== keyFor(deriveScope({ id: 42 })),
  `${keyFor(42)} vs ${keyFor(deriveScope({ id: 42 }))}`);
check('as the guest they agree, which is exactly why this hid',
  keyFor(undefined) === keyFor(deriveScope(null)),
  `${keyFor(undefined)} vs ${keyFor(deriveScope(null))}`);
check('and the scope form is the one the sync engine uses',
  keyFor(deriveScope({ id: 42 })) === `knowledge:${deriveScope({ id: 42 })}`);

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const sync = fs.readFileSync(path.resolve(HERE, '../src/syncEngine.js'), 'utf8');
check('the panel is given the scope, not the id', /<KnowledgePanel[\s\S]{0,900}?userId=\{profileScope\}/.test(app));
check('and the sync engine keys the same store by scope', /knowledge:\$\{scope\}/.test(sync));

/* -------------------------------------------------------- the call site */

check('retrieval is told which chat is asking', /chatId: currentSessionId/.test(app));
check('and which folder it is in', /folderId: currentFolderId/.test(app));
check('the guard uses the scoped list rather than the whole library',
  /const inScope = visibleDocuments\(knowledge, \{/.test(app) && /inScope\.length > 0/.test(app));

const ingest = fs.readFileSync(path.resolve(HERE, '../src/ingest.js'), 'utf8');
check('an attached document records the chat it arrived in',
  /chatId \? \{ chatId: String\(chatId\) \}/.test(ingest));
check('a document with no owner stays shared',
  !/chatId: String\(chatId\) \}\s*:\s*\{ chatId: null/.test(ingest));

const panel = fs.readFileSync(path.resolve(HERE, '../src/KnowledgePanel.jsx'), 'utf8');
check('a scoped document can be promoted to the whole library', /const share = async \(id\)/.test(panel));
check('and promoting it just drops the owner', /const \{ chatId, folderId, \.\.\.rest \} = d;/.test(panel));

/* --------------------------------------- searching your own chats by meaning

   Chat search matched substrings, which works when you remember the words —
   and the whole difficulty is that you do not. You remember working out how a
   hash table resizes; you type "해시 테이블 크기" and find nothing, because what
   you actually wrote was "버킷 개수를 두 배로". The embedding parts were already
   here, doing exactly this for attached documents. */

const chat = await bundleOne('../src/chatSearch.js', '../node_modules/.chatsearch-test-bundle.mjs',
  ['localforage', 'pdfjs-dist', 'fflate']);
const { indexablePieces, indexSignature, literalMatches, mergeResults } = chat;

const SESSIONS = [
  { id: 1, title: 'Hash tables', updatedAt: 10, messages: [
    { role: 'user', content: 'how does a hash table grow when it fills up' },
    { role: 'assistant', content: 'It doubles the number of buckets and rehashes every key into the new array.' },
    { role: 'user', content: '<TOOL_RESULT>\nsome machine output nobody remembers reading\n</TOOL_RESULT>' },
    { role: 'assistant', content: 'ok' },
  ] },
  { id: 2, title: 'Dinner', updatedAt: 20, messages: [
    { role: 'user', content: 'what can I make with eggs and rice for dinner tonight' },
  ] },
];

const pieces = indexablePieces(SESSIONS);
check('tool results are not indexed', !pieces.some(p => p.text.includes('machine output')));
check('nor are one-word replies', !pieces.some(p => p.text === 'ok'));
check('real messages are', pieces.length === 3, String(pieces.length));
check('and each knows where it came from',
  pieces.every(p => p.sessionId && Number.isInteger(p.messageIndex)));

// Opening a chat changes a title or a scroll position, not what was said.
// Re-embedding a year of history for that would be absurd.
const renamed = [{ ...SESSIONS[0], title: 'Renamed' }, SESSIONS[1]];
check('renaming a chat does not invalidate the index',
  indexSignature(indexablePieces(renamed)) === indexSignature(pieces));
const edited = [
  { ...SESSIONS[0], messages: [...SESSIONS[0].messages, { role: 'user', content: 'and what about collisions in practice' }] },
  SESSIONS[1],
];
check('but saying something new does',
  indexSignature(indexablePieces(edited)) !== indexSignature(pieces));

// Substring first: typing an error code or a filename should find that string,
// and the five chats most *like* it are the feature getting in the way.
const literal = literalMatches(SESSIONS, 'eggs');
check('a literal match is found', literal.length === 1 && literal[0].sessionId === '2');
check('and is marked as literal', literal[0].literal === true);
check('a title match counts too', literalMatches(SESSIONS, 'dinner').length === 1);
check('no query finds nothing', literalMatches(SESSIONS, '   ').length === 0);

const merged = mergeResults(literal, [{ sessionId: '2', score: 0.9 }, { sessionId: '1', score: 0.8 }]);
check('literal hits come first', merged[0].literal === true);
check('a chat found both ways appears once', merged.filter(r => r.sessionId === '2').length === 1);
check('and one found only by meaning is added', merged.some(r => r.sessionId === '1'));

// Embedding the query costs a round trip; doing it per keystroke would be
// absurd, so it is a thing you press.
check('searching by meaning is asked for, not automatic',
  /onClick=\{runSemanticSearch\}/.test(app) && !/onChange[\s\S]{0,80}runSemanticSearch/.test(app));
check('a new query clears the previous answer',
  /setSemanticHits\(\[\]\);[\s\S]{0,90}\}, \[sessionSearchQuery\]\)/.test(app));
check('and the index is cached rather than rebuilt each time',
  /cached\.signature === signature && cached\.model === model/.test(
    fs.readFileSync(path.resolve(HERE, '../src/chatSearch.js'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
