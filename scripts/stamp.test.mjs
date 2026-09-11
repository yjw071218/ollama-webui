// The chat clock, and the three things that were broken without it.
//
// `updatedAt` is what the sync compares. This device uploads a chat only when
// its stamp differs from the one it last sent, and the server keeps a record
// only when its stamp beats the one it holds. So a chat edited without moving
// its stamp is edited in this browser and nowhere else — not late, never.
//
// Three reports, one cause:
//
//   * A chat deleted from the sidebar reached the phone, but a message deleted
//     inside a chat did not. Deleting a chat is a tombstone with its own
//     timestamp; deleting a message was an edit that never moved the clock.
//   * A message sent on the desktop appeared on the phone at once, but the
//     reply did not. Sending stamped the chat. Appending the assistant's empty
//     placeholder did not, and neither did any token after it — so the upload
//     a second later carried the placeholder and every upload after it skipped
//     the chat as unchanged.
//   * The phone showed "Thinking..." for ever, surviving a reload. Of course it
//     did: an assistant message with empty content is exactly what the account
//     held, and reloading fetched it again.
//
// What is asserted here is not "the object changed" — every render changes the
// object — but "the sync would see it", which is the only question that
// mattered and the one nothing was asking.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/sessionEdit.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.stamp-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { stamped, syncWouldSee, conversationTime } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* --------------------------------------------------------------- the rule */

const T0 = 1000;
const NOW = 5000;
const chat = { id: 'c1', title: 'A chat', updatedAt: T0, messages: [] };

const edited = stamped(chat, { ...chat, title: 'Renamed' }, NOW);
eq('an edit is stamped with now', edited.updatedAt, NOW);
eq('and the edit itself is kept', edited.title, 'Renamed');
check('the sync would see it', syncWouldSee(chat, edited));

// Returning the same object is how every caller in App.jsx says "not this
// one". Stamping it would upload an identical chat and let it win a conflict
// it should have lost.
const untouched = stamped(chat, chat, NOW);
eq('a revision that changed nothing is not stamped', untouched.updatedAt, T0);
check('and it is the very same object', untouched === chat);
check('so the sync would not see it', !syncWouldSee(chat, untouched));

// A restore from the undo toast, or a record pulled from the account, carries a
// timestamp that means something. Overwriting it would break the comparison it
// exists for -- a restore stamped with its *old* time loses to the tombstone
// that deleted it and is deleted again on the next pull.
const deliberate = stamped(chat, { ...chat, messages: [1], updatedAt: 9999 }, NOW);
eq('a timestamp the caller chose is left alone', deliberate.updatedAt, 9999);

eq('a revision that returned nothing keeps the original', stamped(chat, null, NOW), chat);

/* ------------------------------------------- the reply that never went up */

// The sequence that produced the bug, run in order. Each step is what App.jsx
// actually does, and after each one the question is the only one that matters:
// would this device now upload the chat?
let live = { id: 'c1', title: 'New Chat', updatedAt: T0, messages: [] };

// 1. The user sends. This one always stamped -- which is why the *question*
//    arrived on the phone and nothing after it ever did.
const sent = stamped(live, {
  ...live, title: 'Explain flexbox', updatedAt: 2000,
  messages: [{ role: 'user', content: 'Explain flexbox' }],
}, 2000);
check('sending stamps the chat', syncWouldSee(live, sent));
live = sent;

// 2. The empty assistant bubble is appended. Before the fix this step did not
//    stamp, so this -- an assistant message with no content -- is the version
//    that the upload a second later carried.
const placeholder = stamped(live, {
  ...live, messages: [...live.messages, { role: 'assistant', content: '' }],
}, 2500);
check('the placeholder is stamped too', syncWouldSee(live, placeholder));
const uploaded = placeholder;   // what the account holds at this point
live = placeholder;

// 3. Tokens arrive. Every flush rewrites the last message.
for (const [at, text] of [[3000, 'Flexbox'], [3500, 'Flexbox lays'], [4000, 'Flexbox lays out']]) {
  const before = live;
  const msgs = [...live.messages];
  msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: text };
  live = stamped(before, { ...before, messages: msgs }, at);
  check(`a token flush at ${at} is visible to the sync`, syncWouldSee(before, live));
}

// 4. The reply finishes: content, metrics and the model are committed.
const before = live;
const msgs = [...live.messages];
msgs[msgs.length - 1] = {
  ...msgs[msgs.length - 1],
  content: 'Flexbox lays out a row or a column.',
  metrics: { tokensPerSec: '42.0' },
  model: 'llama3',
};
live = stamped(before, { ...before, messages: msgs }, 4500);
check('and so is the finished answer', syncWouldSee(before, live));

// The claim the whole thing rests on: the account was holding the placeholder,
// and what this device would now send is not that.
check('the account is holding an empty reply', uploaded.messages[1].content === '');
check('and the device now has something newer to send', syncWouldSee(uploaded, live));
eq('which is the answer', live.messages[1].content, 'Flexbox lays out a row or a column.');

/* ------------------------------------------------- deleting one message */

const conversation = {
  id: 'c2',
  updatedAt: T0,
  messages: [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
  ],
};

const pruned = stamped(conversation, {
  ...conversation,
  messages: conversation.messages.filter((_, i) => i !== 1),
}, NOW);
eq('the message is gone', pruned.messages.length, 2);
check('and the deletion would reach the other device', syncWouldSee(conversation, pruned));

// Undo restores the old array. It is a change in its own right and has to
// travel too, or the other device keeps the version with the message removed.
const undone = stamped(pruned, { ...pruned, messages: conversation.messages }, NOW + 1000);
eq('undo brings it back', undone.messages.length, 3);
check('and that travels as well', syncWouldSee(pruned, undone));

/* -------------------------------------------------------- the small edits */

for (const [name, revise] of [
  ['starring a message', c => ({ ...c, messages: c.messages.map((m, i) => (i ? m : { ...m, starred: true })) })],
  ['clearing a chat', c => ({ ...c, messages: [] })],
  ['renaming it', c => ({ ...c, title: 'Something else', titleLocked: true })],
  ['pinning it', c => ({ ...c, pinned: true })],
  ['moving it to a folder', c => ({ ...c, folderId: 'f1' })],
]) {
  check(`${name} reaches the account`, syncWouldSee(conversation, stamped(conversation, revise(conversation), NOW)));
}

/* ------------------------------------------------- two clocks, not one

   `updatedAt` is the sync clock and every edit has to move it — which is what
   everything above this line is about. But the sidebar was reading that same
   number as "when I last talked in this chat", so filing a three-week-old
   conversation into a folder jumped it to the top of the list and relabelled
   it "just now".

   Both readings are reasonable and they cannot be the same field. The second
   is derived from the messages, which already carry their own timestamps —
   nothing to store, nothing to migrate, and no way for it to disagree with
   what the transcript shows. */

const SPOKEN = 1700000000000;
const talked = {
  id: 1,
  createdAt: SPOKEN - 60000,
  updatedAt: SPOKEN,
  messages: [
    { role: 'user', content: 'hello', at: SPOKEN - 1000 },
    { role: 'assistant', content: 'hi', at: SPOKEN },
  ],
};

eq('the conversation time is the last message', conversationTime(talked), SPOKEN);

// The case that was reported. Filing it away is an edit — it has to sync — but
// it is not a conversation.
const filed = stamped(talked, { ...talked, folderId: 'f1' }, SPOKEN + 9000000);
check('filing it into a folder still reaches the account', syncWouldSee(talked, filed));
eq('but it does not change when you last talked', conversationTime(filed), SPOKEN);
check('even though the record itself moved', filed.updatedAt > talked.updatedAt);

// The same for every other edit that is not somebody speaking.
for (const [name, revise] of [
  ['renaming it', c => ({ ...c, title: 'New name' })],
  ['pinning it', c => ({ ...c, pinned: true })],
  ['starring a message', c => ({ ...c, messages: c.messages.map((m, i) => (i ? m : { ...m, starred: true })) })],
  ['archiving it', c => ({ ...c, archived: true })],
]) {
  const after = stamped(talked, revise(talked), SPOKEN + 9000000);
  check(`${name} still syncs`, syncWouldSee(talked, after));
  eq(`${name} does not move the conversation time`, conversationTime(after), SPOKEN);
}

// And actually saying something does move it.
const replied = stamped(talked, {
  ...talked,
  messages: [...talked.messages, { role: 'user', content: 'more', at: SPOKEN + 9000000 }],
}, SPOKEN + 9000000);
eq('saying something does move it', conversationTime(replied), SPOKEN + 9000000);

/* ---------------------------------------------------------- the fallbacks */

eq('a message saved before timestamps falls back to the record',
  conversationTime({ updatedAt: 42, messages: [{ role: 'user', content: 'x' }] }), 42);
eq('an empty chat falls back to when it was made',
  conversationTime({ createdAt: 7, messages: [] }), 7);
eq('a chat with neither is zero rather than NaN', conversationTime({}), 0);
eq('nothing at all is zero', conversationTime(null), 0);
eq('a broken messages field does not throw',
  conversationTime({ updatedAt: 5, messages: 'not an array' }), 5);

// Scanned from the end, so a trailing message with no `at` does not hide the
// one before it — the assistant placeholder is appended before it is answered.
eq('a trailing unstamped message looks further back',
  conversationTime({ updatedAt: 1, messages: [
    { role: 'user', content: 'q', at: 500 },
    { role: 'assistant', content: '' },
  ] }), 500);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
