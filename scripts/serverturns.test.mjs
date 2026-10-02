// A turn answered by the server, with no browser open.
//
// Every turn used to be assembled in the browser, so nothing happened while no
// tab was open -- and the schedules said so and fired only while the app was up.
// An account's chats are on the server anyway, so the server can answer one:
// read the chat, ask the model, write the answer back as a record change, and
// ring the doorbell so open devices pull it in.
//
// What is tested is the part with wrong answers that look fine: which system
// prompt wins, what history travels, that an answer lands after anything
// written while the model was thinking, and that two processes against one
// database cannot both answer the same slot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// Its own database: this writes chats and schedules.
process.env.WEBUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-turns-'));
const T = await import(pathToFileURL(path.join(ROOT, 'server/turns.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'server/serverSchedules.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'server/records.js')).href);
const { database } = await import(pathToFileURL(path.join(ROOT, 'server/db.js')).href);

/* ------------------------------------------------------------ the request */

{
  const chat = {
    lastModel: 'qwen3:30b', personaId: 'p1', thinkMode: 'off', temperature: 0.2,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '<think>private</think>hi there' },
      { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_TIME ---\n12:00\n</TOOL_RESULT>' },
      { role: 'user', content: 'see this\n\n--- Attached File: notes.txt ---\nten thousand lines\n-------------------' },
    ],
  };
  const request = T.buildServerRequest({ chat, prompt: 'the news?', personas: [{ id: 'p1', body: 'You are P.' }], globalSystemPrompt: 'Global.' });
  eq('the chat model answers', request.model, 'qwen3:30b');
  // The browser's own order: the chat's override, its persona, the account's.
  eq('a persona beats the account setting', request.messages[0], { role: 'system', content: 'You are P.' });
  eq('  and the chat’s own prompt beats both',
    T.buildServerRequest({ chat: { ...chat, systemPrompt: 'Mine.' }, prompt: 'x', personas: [{ id: 'p1', body: 'P' }], globalSystemPrompt: 'G' }).messages[0].content,
    'Mine.');
  // Scaffolding is addressed to the model, and a stranger to this history.
  eq('the history travels without its reasoning, tool results or attachment bodies',
    request.messages.slice(1).map(m => m.content), ['hello', 'hi there', 'see this', 'the news?']);
  eq('the chat’s thinking level and temperature go with it', [request.think, request.options], [false, { temperature: 0.2 }]);
  eq('  and a chat with no opinion sends neither',
    ['think' in T.buildServerRequest({ chat: { lastModel: 'm', messages: [] }, prompt: 'x' }), 'options' in T.buildServerRequest({ chat: { lastModel: 'm', messages: [] }, prompt: 'x' })],
    [false, false]);
}

/* ------------------------------------------------------- answering, for real */

const owner = 'user-turns';
database().prepare("INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?,?,?,?)")
  .run(owner, 'turns@example.com', 'Turns', Date.now());
const putChat = (id, payload, at = Date.now()) => R.applyChanges(owner, { records: [{ kind: 'chat', id, updatedAt: at, payload }] });
const getChat = (id) => JSON.parse(database().prepare("SELECT payload FROM records WHERE user_id = ? AND kind = 'chat' AND id = ?").get(owner, id).payload);

{
  putChat('c1', { id: 'c1', title: 'News', lastModel: 'qwen3:30b', messages: [{ role: 'user', content: 'hi' }] }, 1000);
  let asked = null;
  const result = await T.runServerTurn({
    owner, chatId: 'c1', prompt: 'the news?', now: () => 5000,
    fetchImpl: async (url, init) => {
      asked = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ message: { content: 'It rained.' }, eval_count: 3, eval_duration: 1e9, total_duration: 2e9 }) };
    },
  });
  eq('a server turn answers', result.ok, true);
  eq('  asking the model it was set up with', [asked.url.endsWith('/api/chat'), asked.body.model, asked.body.stream], [true, 'qwen3:30b', false]);
  const chat = getChat('c1');
  eq('  and writing the question and the answer into the chat',
    chat.messages.slice(-2).map(m => [m.role, m.content]), [['user', 'the news?'], ['assistant', 'It rained.']]);
  // Marked, so it reads as the machine's own question.
  eq('  marked as the server’s', [chat.messages.at(-2).scheduled, chat.messages.at(-1).answeredBy], [true, 'server']);
  eq('  with its figures', chat.messages.at(-1).metrics.evalCount, 3);
}
{
  /* Written to while the model thought. The reader's newer message is kept and
     the answer goes after it -- reading the chat once, at the start, would
     write the old copy back over it. */
  putChat('c2', { id: 'c2', lastModel: 'm', messages: [{ role: 'user', content: 'first' }] }, 1000);
  await T.runServerTurn({
    owner, chatId: 'c2', prompt: 'scheduled', now: () => 9000,
    fetchImpl: async () => {
      putChat('c2', { id: 'c2', lastModel: 'm', messages: [{ role: 'user', content: 'first' }, { role: 'user', content: 'typed meanwhile' }] }, 2000);
      return { ok: true, json: async () => ({ message: { content: 'answer' } }) };
    },
  });
  eq('something written while the model was thinking is kept',
    getChat('c2').messages.map(m => m.content), ['first', 'typed meanwhile', 'scheduled', 'answer']);
}
{
  const gone = await T.runServerTurn({ owner, chatId: 'nope', prompt: 'x', fetchImpl: async () => { throw new Error('should not ask'); } });
  eq('a conversation that is not here is a clear no, not a crash', gone.ok, false);
  const down = await T.runServerTurn({ owner, chatId: 'c1', prompt: 'x', fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  eq('  and so is a model that is not running', [down.ok, /ECONNREFUSED/.test(down.error)], [false, true]);
  const busy = await T.runServerTurn({ owner, chatId: 'c1', prompt: 'x', beforeInference: async () => 'drawing', fetchImpl: async () => { throw new Error('should not ask'); } });
  eq('  and a picture holding the card waits rather than fighting it', busy.ok, false);
  eq('a guest has nothing on this server to answer in', (await T.runServerTurn({ owner: '', chatId: 'c1', prompt: 'x' })).ok, false);
}

/* ------------------------------------------------------------ the schedules */

{
  const bad = S.createSchedule(owner, { chat: 'c1', prompt: 'x', at: '25:00' });
  check('a schedule with no real time is refused and says why', /HH:MM/.test(bad.error || ''), JSON.stringify(bad));
  eq('  and one with no account at all', !!S.createSchedule('', { chat: 'c1', prompt: 'x' }).error, true);

  const made = S.createSchedule(owner, { chat: 'c1', prompt: 'the news?', every: 'day', at: '08:00' }, new Date('2026-03-10T15:00:00').getTime());
  eq('a schedule is made for the account that asked', S.listSchedules(owner).map(s => s.id), [made.schedule.id]);
  eq('  and is shown as running on the server', made.schedule.runsOn, 'server');
  eq('  and nobody else sees it', S.listSchedules('someone-else'), []);

  const slot = new Date('2026-03-11T08:00:30').getTime();
  /* Two processes, one database -- `npm run dev` and `npm start` at once. The
     claim moves `last_run_at` only if it still holds what was read, so the
     second process finds nothing to do. */
  const firstClaim = S.claimDue(slot);
  const secondClaim = S.claimDue(slot);
  eq('a due schedule is claimed once', firstClaim.map(s => s.id), [made.schedule.id]);
  eq('  and a second runner at the same moment gets nothing', secondClaim, []);
  eq('  and it is not due again for that slot', S.claimDue(slot + 60000), []);

  eq('switched off, it is never claimed', [S.setScheduleEnabled(owner, made.schedule.id, false), S.claimDue(new Date('2026-03-12T08:00:30').getTime())], [true, []]);
  eq('another account cannot switch it on', S.setScheduleEnabled('someone-else', made.schedule.id, true), false);
  eq('and it can be removed by its own account', S.deleteSchedule(owner, made.schedule.id), true);
}

/* --------------------------------------------------------------- the wiring */

const api = read('server/api.js');
for (const route of ['/api/schedules', '/api/schedules/enabled', '/api/schedules/delete']) {
  check(`${route} is handled`, api.includes(`route('${route}'`));
}
// Changing schedules is a write, and a write has to prove it came from the app.
check('changing a schedule needs a signed-in, verified request',
  (api.match(/guard\(req, res, \{ methods: \['POST'\] \}\);\s*\n\s*if \(!auth\) return;\s*\n\s*try \{\s*\n\s*(const made = createSchedule|const \{ id, enabled \}|const \{ id \} = await jsonBody\(req\);\s*\n\s*sendJson\(res, \{ success: deleteSchedule)/g) || []).length === 3);
// Started by the servers, not by createApiRoutes, which the tests call dozens
// of times and which must not leave timers that could answer a real schedule.
check('the runner is started by both servers and nowhere else',
  /startScheduleRunner\(env,/.test(read('server/index.js'))
  && /startScheduleRunner\(env,/.test(read('vite.config.js'))
  && !/startScheduleRunner/.test(api));

const app = read('src/App.jsx');
check('an account’s schedules are the server’s list', /const shownSchedules = accountId \? serverSchedules : schedules;/.test(app));
// Left running for an account, a browser list would be answered twice.
check('  and the browser runner is the guest’s alone', /schedules\.length === 0 \|\| accountId\) return undefined;/.test(app));
check('  with what a server answer cannot do said before the list', /t\(accountId \? 'schedule\.helpServer' : 'schedule\.help'\)/.test(app));
// What stopped the last one, from the server that tried.
check('  and why the last one did not run', /item\.lastError && <span className="schedule-error">/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
