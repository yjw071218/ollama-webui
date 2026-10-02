import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-telegram-'));
process.env.WEBUI_DATA_DIR = data;

const { closeDatabase, database } = await import('../server/db.js');
const { applyChanges, changesSince } = await import('../server/records.js');
const T = await import('../server/telegram.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};

database().exec(`INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u1', 'A', 'password', 1, 0);`);
applyChanges('u1', { records: [
  { kind: 'setting', id: 'defaultModel', updatedAt: 1, payload: 'qwen3:8b' },
  { kind: 'memory', id: 'm1', updatedAt: 1, payload: { id: 'm1', text: 'Prefers short answers.', kind: 'preference', enabled: true } },
] });

const sent = [];
const turns = [];
const send = async (chat, text) => { sent.push({ chat, text }); };
const turn = async (args) => { turns.push(args); return { ok: true, answer: `<think>hmm</think>Answer to: ${args.prompt}` }; };
const msg = (chatId, text) => ({ chat: { id: chatId }, text });
const last = () => sent[sent.length - 1]?.text || '';

try {
  await T.handleMessage(msg(111, 'hello'), { send, turn });
  check('an unlinked chat is told how to link and nothing is answered', /not linked/.test(last()) && turns.length === 0);

  await T.handleMessage(msg(111, '/start not-a-code'), { send, turn });
  check('a wrong code does not link', /open the web UI/.test(last()) && !T.linkFor(111));

  const code = T.makeLinkCode('u1');
  await T.handleMessage(msg(111, `/start ${code}`), { send, turn });
  const linked = T.linkFor(111);
  check('a code links the chat to the account', linked?.user_id === 'u1' && /^Linked/.test(last()));
  check('and makes a conversation in the web UI',
    changesSince('u1', 0).records.some(r => r.kind === 'chat' && r.id === linked.chat_id && r.payload.title === 'Telegram'));

  await T.handleMessage(msg(222, `/start ${code}`), { send, turn });
  check('a code works once', !T.linkFor(222));

  await T.handleMessage(msg(111, 'What is 2+2?'), { send, turn });
  check('a message becomes a server turn in the linked conversation',
    turns.length === 1 && turns[0].chatId === linked.chat_id && turns[0].owner === 'u1' && turns[0].origin === 'telegram');
  check('with the default model and the account context',
    turns[0].model === 'qwen3:8b' && turns[0].extraSystem.includes('Prefers short answers'));
  check('the answer is sent back without its reasoning', last() === 'Answer to: What is 2+2?');

  await T.handleMessage(msg(111, '/model gemma3:27b'), { send, turn });
  await T.handleMessage(msg(111, 'again'), { send, turn });
  check('/model changes the model for this chat', turns[1].model === 'gemma3:27b');

  const before = T.linkFor(111).chat_id;
  await new Promise(r => setTimeout(r, 5));
  await T.handleMessage(msg(111, '/new'), { send, turn });
  check('/new starts another conversation', T.linkFor(111).chat_id !== before);

  check('long answers are split under Telegram\'s limit',
    T.splitMessage('a '.repeat(5000), 4000).every(p => p.length <= 4000));
  check('links are listed for the settings screen', T.linksOf('u1').length === 1);

  await T.handleMessage(msg(111, '/unlink'), { send, turn });
  check('/unlink forgets the chat', !T.linkFor(111));
} finally {
  closeDatabase();
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
