// Two devices, one chat: an edit made on an out-of-date copy is merged, not
// allowed to wipe out what another device wrote in the meantime.
// See server/chatMerge.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-chatmerge-'));
process.env.WEBUI_DATA_DIR = data;

const { closeDatabase, database } = await import('../server/db.js');
const { applyChanges } = await import('../server/records.js');
const { mergeChats } = await import('../server/chatMerge.js');

let pass = 0, fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};
const texts = (chat) => (chat?.messages || []).map(m => m.content);
const u = (content, at) => ({ role: 'user', content, at });
const a = (content, at) => ({ role: 'assistant', content, at });

/* ------------------------------------------------------------ the merge */

{
  const server = { title: 'T', messages: [u('q1', 1), a('r1', 2), u('q2', 3), a('r2', 4)] };
  const mine = { title: 'T', model: 'new', messages: [u('q1', 1), a('r1', 2)] };
  const merged = mergeChats(server, mine);
  check('a stale copy keeps the messages it never received', texts(merged).join() === 'q1,r1,q2,r2');
  check('  and its own change to the chat still lands', merged.model === 'new');
}
{
  const server = { title: 'T', messages: [u('q1', 1), a('r1', 2)] };
  const mine = { title: 'T', messages: [u('q1', 1), a('r1', 2), u('q2', 5), a('r2', 6)] };
  check('a copy that only added messages is taken as it is', texts(mergeChats(server, mine)).join() === 'q1,r1,q2,r2');
}
{
  const server = { title: 'T', messages: [u('q1', 1), a('r1', 2), u('from pc', 10), a('pc answer', 11)] };
  const mine = { title: 'T', messages: [u('q1', 1), a('r1', 2), u('from phone', 7), a('phone answer', 8)] };
  check('both added: both kept, in the order they were written',
    texts(mergeChats(server, mine)).join() === 'q1,r1,from phone,phone answer,from pc,pc answer');
}
{
  const server = { title: 'T', messages: [u('q1', 1), a('the whole answer', 2)] };
  const mine = { title: 'T', messages: [u('q1', 1), a('the whole', 2)] };
  check('a reply caught mid-stream on one side is kept whole, once',
    texts(mergeChats(server, mine) ?? server).join() === 'q1,the whole answer'
    && texts(mergeChats(mine, server)).join() === 'q1,the whole answer');
}
{
  const server = { title: 'T', messages: [u('q1', 1), a('r1', 2)] };
  check('nothing new: the server copy stands', mergeChats(server, { ...server, messages: [...server.messages] }) === null);
  const starred = { title: 'T', messages: [u('q1', 1), { ...a('r1', 2), starred: true }] };
  check('a star on a message the server has is news', mergeChats(server, starred)?.messages[1].starred === true);
}

{
  // The bug in the screenshot: an edited question came back twice.
  const base = { title: 'T', messages: [u('q1', 1), a('r1', 2)] };
  const server = { title: 'T', messages: [u('q1', 1), a('r1 and more', 2)] };
  const mine = { title: 'T', messages: [{ ...u('q1 edited', 1), editedAt: 50 }, a('new answer', 60)] };
  const merged = mergeChats(server, mine, base);
  check('an edited question is one message, not two', texts(merged).join() === 'q1 edited,new answer', texts(merged).join());
  const noBase = mergeChats(server, mine);
  check('  even without the base copy, its key is not repeated',
    noBase.messages.filter(x => x.role === 'user' && x.at === 1).length === 1, texts(noBase).join());
  check('  and the edit wins over the old words', noBase.messages[0].content === 'q1 edited');
}
{
  const base = { title: 'T', messages: [u('q1', 1), a('old answer', 2)] };
  const server = { title: 'T', messages: [u('q1', 1), a('old answer', 2)], model: 'x' };
  const mine = { title: 'T', messages: [u('q1', 1), a('regenerated', 9)] };
  check('a regenerated answer replaces the old one instead of sitting beside it',
    texts(mergeChats(server, mine, base)).join() === 'q1,regenerated');
}
{
  const base = { title: 'T', messages: [u('q1', 1), a('r1', 2), u('q2', 3), a('r2', 4)] };
  const server = { title: 'T', messages: [u('q1', 1), a('r1', 2)] };
  const mine = { title: 'T', model: 'm', messages: [u('q1', 1), a('r1', 2), u('q2', 3), a('r2', 4)] };
  check('a turn deleted on another device is not resurrected by a stale copy',
    texts(mergeChats(server, mine, base)).join() === 'q1,r1');
}
{
  const list = [u('q', 1), a('r', 2), a('r longer', 2)];
  const { uniqueMessages } = await import('../server/chatMerge.js');
  const out = uniqueMessages(list);
  check('no key appears twice', out.length === 2 && out[1].content === 'r longer');
}

/* ------------------------------------------------------ one writer per chat */
{
  const { createChatJobStore } = await import('../server/chatJobs.js');
  const store = createChatJobStore();
  store.begin('pc', { owner: 'u', chat: 'c1' });
  let refused = null;
  try { store.begin('phone', { owner: 'u', chat: 'c1' }); } catch (e) { refused = e; }
  check('a second local answer in one chat is refused', refused?.statusCode === 409 && refused?.code === 'CHAT_BUSY');
  check('  the same job id begun again is not a conflict', !!store.begin('pc', { owner: 'u', chat: 'c1' }));
  check('  another chat is free', !!store.begin('other', { owner: 'u', chat: 'c2' }));
  check('  another account is free', !!store.begin('theirs', { owner: 'v', chat: 'c1' }));
  let cliRefused = null;
  try { store.begin('cli-1', { owner: 'u', chat: 'c1', kind: 'cli' }); } catch (e) { cliRefused = e; }
  check('  a CLI answer waits for a local one in progress', cliRefused?.statusCode === 409);
  store.appendChunk('pc', '{"message":{"content":"x"},"done":true}\n');
  check('  a local answer that said done frees the chat', !!store.begin('phone', { owner: 'u', chat: 'c1' }));
  store.finish('phone');
  store.begin('cli-a', { owner: 'u', chat: 'c3', kind: 'cli' });
  check('CLI answers run in parallel in one chat', !!store.begin('cli-b', { owner: 'u', chat: 'c3', kind: 'cli' }));
  let localAfterCli = null;
  try { store.begin('local', { owner: 'u', chat: 'c3' }); } catch (e) { localAfterCli = e; }
  check('  but a local one does not join them', localAfterCli?.statusCode === 409);
  store.stop('cli-a'); store.stop('cli-b');
  check('  stopped answers free the chat', !!store.begin('local', { owner: 'u', chat: 'c3' }));
}

/* ------------------------------------------------------- through the server */

const db = database();
db.exec("INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u1', 'A', 'password', 1, 0)");
const stored = () => JSON.parse(db.prepare("SELECT payload FROM records WHERE user_id='u1' AND id='c1'").get().payload);
try {
  // Both devices in step at v100.
  applyChanges('u1', { records: [{ kind: 'chat', id: 'c1', updatedAt: 100, payload: { title: 'T', messages: [u('q1', 1), a('r1', 2)] } }] });
  // The PC answers the next question.
  applyChanges('u1', { records: [{ kind: 'chat', id: 'c1', updatedAt: 200, base: 100, payload: { title: 'T', messages: [u('q1', 1), a('r1', 2), u('q2', 150), a('r2', 160)] } }] });
  // The phone, still at v100, changes the chat's model a moment later.
  const answer = applyChanges('u1', { records: [{ kind: 'chat', id: 'c1', updatedAt: 210, base: 100, payload: { title: 'T', lastModel: 'm2', messages: [u('q1', 1), a('r1', 2)] } }] });
  check('the PC\'s answer survives the phone\'s stale write', texts(stored()).join() === 'q1,r1,q2,r2');
  check('  and the phone\'s change is in it', stored().lastModel === 'm2');
  const back = (answer.records || []).find(r => r.id === 'c1');
  check('  the merged chat goes back to the phone, newer than its own write', back && back.updatedAt > 210 && texts(back.payload).join() === 'q1,r1,q2,r2');

  // A device in step (base = what the server has) replaces as before -- a deletion works.
  const now = db.prepare("SELECT updated_at FROM records WHERE user_id='u1' AND id='c1'").get().updated_at;
  applyChanges('u1', { records: [{ kind: 'chat', id: 'c1', updatedAt: now + 10, base: now, payload: { title: 'T', messages: [u('q1', 1), a('r1', 2)] } }] });
  check('an edit on the current copy replaces it (deleting a turn still works)', texts(stored()).join() === 'q1,r1');

  // An older client, with no base, is last-write-wins as it always was.
  applyChanges('u1', { records: [{ kind: 'chat', id: 'c1', updatedAt: now + 20, payload: { title: 'T', messages: [u('only', 1)] } }] });
  check('no base: the later write wins, as before', texts(stored()).join() === 'only');
} finally {
  closeDatabase?.();
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
