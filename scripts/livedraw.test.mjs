// Watching a picture being made from a device that did not ask for it.
//
// Reported: a picture asked for on the desktop, the phone opened while it was
// being drawn, and the phone showed an empty bubble with three dots for the
// whole two minutes. Nothing was broken. The chat syncs while the answer is
// written, so the empty bubble really was the desktop's answer arriving; the
// job really was running; and `/studio/events` would have streamed every step
// of it to anyone who asked. The phone simply had no way to learn the job id,
// because the browser that queues a job keeps that id in its own localStorage —
// the one thing that cannot travel between devices.
//
// So the server writes the connection down: this job, for that conversation,
// for this account. `/studio/live` answers it, and the phone puts up the same
// progress card, fed by the same stream, as a spectator.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A database of its own. The register of what is being made is a table now --
   it has to outlive a restart, because the work does -- and a test must never
   be able to touch the real one. */
process.env.WEBUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-live-'));
const S = await import(pathToFileURL(path.join(ROOT, 'server/studio.js')).href);

/* ------------------------------------------------- what is running, and whose */

S.forgetLiveJobs();
S.rememberLiveJob({
  id: 'prompt-1', owner: 'user-a', chat: '1730000000001',
  kind: 'image', prompt: 'a cat on a wall', model: 'anima-base', aspect: 1.5,
});

eq('the job is found by the conversation it was queued for',
  S.liveJobsFor('user-a', '1730000000001').map(job => job.id), ['prompt-1']);
eq('  with what the card needs to describe it',
  (({ kind, prompt, model, aspect }) => ({ kind, prompt, model, aspect }))(S.liveJobsFor('user-a', '1730000000001')[0]),
  { kind: 'image', prompt: 'a cat on a wall', model: 'anima-base', aspect: 1.5 });
eq('another conversation of the same account has nothing running',
  S.liveJobsFor('user-a', '1730000000002'), []);
// The chat id is a counter, so it is not a secret. The owner is the half that
// keeps one account from reading another's prompts.
eq('and another account asking about that conversation is told nothing',
  S.liveJobsFor('user-b', '1730000000001'), []);
eq('the guest is its own scope, not everyone', S.liveJobsFor('', '1730000000001'), []);

/* The Studio panel's own work is recorded too -- `/studio/queue` is where "what
   is the machine actually doing" is asked, and an id with nothing to say about
   it is not an answer. It just belongs to no conversation, so it can never come
   back as one's live job. */
check('a job with no conversation belongs to no conversation',
  S.rememberLiveJob({ id: 'panel-1', owner: 'user-a', kind: 'image', prompt: 'a wall' }) !== null
  && S.liveJobsFor('user-a', '').length === 0
  && S.liveJobsFor('user-a', '1730000000001').every(job => job.id !== 'panel-1'));
eq('  but it can be named in the queue, to the account that queued it',
  S.describeQueued('user-a', 'panel-1')?.prompt, 'a wall');
eq('  and never to another one', S.describeQueued('user-b', 'panel-1'), null);

S.forgetLiveJob('prompt-1');
eq('a job that ended is no longer live', S.liveJobsFor('user-a', '1730000000001'), []);

/* Half an hour. A job the server never heard the end of -- ComfyUI killed, the
   browser closed mid-generation -- must not leave a card counting up on a phone
   for the rest of the day. */
{
  const then = Date.now() - 31 * 60 * 1000;
  S.forgetLiveJobs();
  S.rememberLiveJob({ id: 'old', owner: 'u', chat: 'c' }, then);
  eq('a job nobody ever finished expires', S.liveJobsFor('u', 'c'), []);
}
{
  S.forgetLiveJobs();
  for (let n = 0; n < 40; n += 1) S.rememberLiveJob({ id: `j${n}`, owner: 'u', chat: 'c' });
  const live = S.liveJobsFor('u', 'c');
  check('and the register is bounded, oldest out first',
    live.length === 32 && live[0].id === 'j8' && live[31].id === 'j39',
    `${live.length}: ${live[0]?.id}..${live[live.length - 1]?.id}`);
}
S.forgetLiveJobs();

/* ------------------------------------------------------------------ the route */

const routes = S.createStudioRoutes({});
check('/studio/live is handled', routes.some(r => r.path === '/studio/live'));

const callLive = (query, { identify = () => '' } = {}) => new Promise((resolve) => {
  const route = S.createStudioRoutes({}, { identify }).find(r => r.path === '/studio/live');
  const res = {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
  };
  route.handler({ url: `/studio/live${query}`, method: 'GET', headers: {} }, res);
});

{
  S.rememberLiveJob({ id: 'prompt-2', owner: 'user-a', chat: '77', kind: 'video', prompt: 'she waves' });
  const mine = await callLive('?chat=77', { identify: () => 'user-a' });
  check('it answers the account that asked for the picture',
    mine.body.success && mine.body.jobs.length === 1 && mine.body.jobs[0].id === 'prompt-2',
    JSON.stringify(mine.body));
  const theirs = await callLive('?chat=77', { identify: () => 'user-b' });
  eq('  and nobody else', theirs.body.jobs, []);
  const quiet = await callLive('?chat=78', { identify: () => 'user-a' });
  eq('  a quiet conversation is a short answer, not an error', [quiet.body.success, quiet.body.jobs], [true, []]);
  const none = await callLive('', { identify: () => 'user-a' });
  eq('  and asking about no conversation is a bad request', none.status, 400);
  S.forgetLiveJobs();
}

/* ------------------------------------------- what survives a restart

   The register is a table rather than a Map because the *work* outlives this
   process: ComfyUI goes on drawing across an `npm start`, and what used to be
   lost was the phone's card, the answer to "what is being made", and the
   notification when it finished. The job carried on, unwatched.

   The cost of surviving is a job that finished while the server was down and
   is still written here. ComfyUI's own queue is the authority, and it is asked
   once at startup. */
{
  S.forgetLiveJobs();
  S.rememberLiveJob({ id: 'still-drawing', owner: 'u', chat: 'c', kind: 'image', prompt: 'a cat' });
  S.rememberLiveJob({ id: 'finished-while-down', owner: 'u', chat: 'c', kind: 'image', prompt: 'a dog' });
  S.rememberLiveJob({ id: 'a-song', owner: 'u', chat: 'c', kind: 'music', prompt: 'lo-fi' });

  eq('the register outlives the process that wrote it',
    S.liveJobsFor('u', 'c').map(job => job.id).sort(),
    ['a-song', 'finished-while-down', 'still-drawing']);
  eq('  and a restart drops what ComfyUI is no longer working on',
    S.reconcileLiveJobs(['still-drawing']), 1);
  // A song is ACE-Step's and is in no ComfyUI queue: judging it against one
  // would cancel every song the moment this server restarted.
  eq('  leaving what it is working on, and what is not its to judge',
    S.liveJobsFor('u', 'c').map(job => job.id).sort(), ['a-song', 'still-drawing']);
  S.forgetLiveJobs();
}
check('the reconcile runs when the routes are made, against the live queue',
  /const dropped = reconcileLiveJobs\(ids\);/.test(read('server/studio.js')));
// A ComfyUI that is not running has no queue to compare against, and the
// half-hour expiry clears the table either way.
check('  and says nothing when there is nothing to compare against',
  /\} catch \(e\) \{ \/\* nothing to reconcile against \*\/ \}/.test(read('server/studio.js')));

/* ------------------------------------------------------------- the two halves */

const studio = read('server/studio.js');
check('a generation records the conversation it is for', /rememberLiveJob\(\{\s*\n\s*id: queued\.prompt_id,/.test(studio));
check('as does an edit, which blocks the answer just as long', /kind: 'edit',/.test(studio));
// Finished is not live. Without this a phone opening the chat afterwards is
// offered a progress bar for a picture that is already in the conversation.
check('and a job that finished, failed or vanished is forgotten',
  (studio.match(/forgetLiveJob\(id\);/g) || []).length >= 3);
check('as is one that was stopped', /if \(all\) forgetLiveJobs\(\); else forgetLiveJob\(id\);/.test(studio));
check('the account is read from the session, not from the request body',
  /identify: \(req\) => String\(authenticate\(req\)\.user\?\.id \|\| ''\)/.test(read('server/api.js')));

const app = read('src/App.jsx');
check('the browser says which conversation a picture is for',
  (app.match(/\.\.\.\(currentSessionId \? \{ chat: String\(currentSessionId\) \} : \{\}\),/g) || []).length === 3);
check('and asks what is being made for the conversation on screen',
  /\/studio\/live\?chat=\$\{encodeURIComponent\(chat\)\}/.test(app));
check('  only while it has nothing of its own going on',
  /if \(drawing \|\| isGenerating\) return undefined;/.test(app));
check('  putting up the ordinary card, watched rather than owned',
  /restored: true,\s*\n\s*watched: true,/.test(app));
// The watched card is written down nowhere, so nothing else ties it to a chat:
// a phone that moved to another conversation would carry it there.
check('  and dropping it on leaving that conversation',
  /if \(drawing\?\.watched && String\(drawing\.sessionId\) !== String\(currentSessionId\)\) \{/.test(app)
  && /&& \(!drawing\.watched \|\| String\(drawing\.sessionId\) === String\(currentSessionId\)\) && \(/.test(app));
// The device that asked is the one that writes the picture into the
// conversation; it reaches every other device as an ordinary sync. Writing it
// from both ends would put it in twice, or into whichever message happened to
// be last on the phone.
check('a watched job never writes its result into the conversation',
  /if \(drawing\.watched\) \{[\s\S]*?setDrawing\(null\);[\s\S]*?return;\s*\n\s*\}/.test(app));
check('nor is it saved as this device\'s own generation',
  // Written under the chat the picture belongs to, not the chat on screen.
  /if \(drawing\?\.id && !drawing\.watched\) \{\s*\n\s*localStorage\.setItem\(drawingKeyFor\(drawing\.sessionId \|\| currentSessionId\)/.test(app));
// Stopping it reaches the machine running it, because it is the server that is
// told: ComfyUI's job leaves the queue and the chat stream ends with an error
// frame, which is exactly what that machine would see if it had been stopped
// there. See `stopElsewhere`.
check('but it can be stopped, from the card and from the composer',
  /onCancel=\{drawing\.watched \? stopElsewhere : stopGeneration\}/.test(app)
  && /\) : remoteTurnHere \? \(/.test(app));

const card = read('src/studioProgress.jsx');
check('the card says where the work is happening', /elsewhere && \(/.test(card)
  && /t\('studio\.elsewhere'\)/.test(card));
check('with the explanation in its title', /title=\{t\('studio\.elsewhereHelp'\)\}/.test(card));
const i18n = read('src/i18n.jsx');
check('in every language', (i18n.match(/'studio\.elsewhere':/g) || []).length === 12);

/* ========================================== the words, not just the picture

   The same gap, for the answer itself. The conversation syncs while it is
   written, so a second device does see the reply -- a second or two behind and
   in lumps, because it arrives by way of storage and an upload. The live bytes
   were always readable: `/api/chat/replay?follow=1` streams them to anyone,
   from any byte offset. Only the id was missing. */

const { createChatJobStore } = await import(pathToFileURL(path.join(ROOT, 'server/chatJobs.js')).href);

{
  const store = createChatJobStore();
  store.begin('job-1', { owner: 'user-a', chat: '5' });
  store.appendChunk('job-1', '{"message":{"content":"hel"}}\n');

  eq('an answer being written is found by its conversation',
    store.live('user-a', '5').map(job => job.id), ['job-1']);
  eq('  and not by another account', store.live('user-b', '5'), []);
  eq('  nor in another conversation', store.live('user-a', '6'), []);
  // By then the answer is in the conversation, and the conversation travels.
  store.finish('job-1');
  eq('a finished answer is not something to follow', store.live('user-a', '5'), []);

  // A turn retried mid-flight begins the job again, and that second call is
  // where the conversation is known if the first one did not carry it.
  const store2 = createChatJobStore();
  store2.begin('job-2');
  store2.begin('job-2', { owner: 'user-a', chat: '9' });
  eq('a job begun twice keeps the metadata it was given',
    store2.live('user-a', '9').map(job => job.id), ['job-2']);
  store2.begin('job-2', { owner: '', chat: '' });
  eq('  and a later call with nothing in it does not erase that',
    store2.live('user-a', '9').map(job => job.id), ['job-2']);
}

{
  const api = await import(pathToFileURL(path.join(ROOT, 'server/api.js')).href);
  const routes = api.createApiRoutes({}, { allowLocalFs: false });
  check('/api/chat/live is handled', routes.some(r => r.path === '/api/chat/live'));
  const route = routes.find(r => r.path === '/api/chat/live');
  const call = (query) => new Promise((resolve) => {
    route.handler({ url: `/api/chat/live${query}`, method: 'GET', headers: {} }, {
      statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); },
    });
  });
  const quiet = await call('?chat=5');
  eq('  a conversation with nothing being written answers so', [quiet.body.success, quiet.body.job], [true, null]);
  const none = await call('');
  eq('  and asking about no conversation is a bad request', none.status, 400);
}

check('the browser says which conversation the answer is for',
  /'X-Chat-Conversation': String\(startedIn\)/.test(app));
// Three servers can be the one writing the answer, and a fact only two of them
// record is a feature that works on some installs.
for (const [file, name] of [['server/index.js', 'the Ollama proxy'], ['server/vram.js', 'the card guard'], ['server/llamacpp.js', 'the llama.cpp routes']]) {
  check(`${name} records who the answer is for`,
    /ownerOfRequest\(req\)/.test(read(file)) && /x-chat-conversation/.test(read(file)));
}
// The account comes from the session cookie. A conversation id is a counter,
// so on its own it would let one account read another's answer as it is typed.
check('and the account is the session\'s, never the request body\'s',
  /export const ownerOfRequest = \(req\) =>/.test(read('server/session.js')));

check('the browser follows what it finds', /\/api\/chat\/live\?chat=\$\{encodeURIComponent\(chat\)\}/.test(app)
  && /resumableChatReader\(null, id, controller\.signal\)/.test(app));
/* Shown over the stored message, never written into it. This device has the
   words but not the pictures the turn made, not its metrics, and not whatever
   the author's copy will say when it lands -- writing that into the chat would
   upload a poorer copy with a newer timestamp, which is how a record is lost. */
check('  and shows it without writing it into the conversation',
  /const shown = \[\.\.\.stored\];/.test(app)
  && /if \(\(stored\[index\]\.content \|\| ''\)\.length >= followed\.content\.length\) return stored;/.test(app));
check('  handing over to the real copy as soon as it has caught up',
  /const messages = useMemo\(\(\) => \{/.test(app));
check('  and following nothing while this device is the one generating',
  /if \(!isStorageLoaded \|\| !currentSessionId \|\| isGenerating\) \{\s*\n\s*setFollowed\(null\);/.test(app));

/* ===================================== what the machine is doing, in order

   The panel knew about the jobs *this browser* started and nothing else: not
   the picture the chat is drawing, not what another device queued, and not the
   order. One card said how many were in front of it, and that was the whole of
   it -- so ComfyUI could be busy for half an hour on work with no card
   anywhere, and the only cancel that could be trusted stopped everything. */

{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).endsWith('/queue')) throw new Error(`unexpected ${url}`);
    return {
      ok: true,
      json: async () => ({
        queue_running: [[0, 'running-1']],
        queue_pending: [[1, 'mine-1'], [2, 'theirs-1']],
      }),
    };
  };
  try {
    S.forgetLiveJobs();
    S.rememberLiveJob({ id: 'running-1', owner: 'me', kind: 'image', prompt: 'a cat', model: 'anima-base' });
    S.rememberLiveJob({ id: 'mine-1', owner: 'me', kind: 'video', prompt: 'she waves' });
    S.rememberLiveJob({ id: 'theirs-1', owner: 'somebody-else', kind: 'image', prompt: 'a secret' });

    const route = S.createStudioRoutes({}, { identify: () => 'me' }).find(r => r.path === '/studio/queue');
    const answer = await new Promise((resolve) => {
      route.handler({ url: '/studio/queue', method: 'GET', headers: {} }, {
        statusCode: 200, setHeader() {}, end(body) { resolve(JSON.parse(body)); },
      });
    });
    eq('the queue is running first, then waiting in order',
      answer.jobs.map(job => [job.id, job.state, job.ahead]),
      [['running-1', 'running', 0], ['mine-1', 'queued', 1], ['theirs-1', 'queued', 2]]);
    eq('  with a line to read for the account that queued it',
      answer.jobs[1].prompt, 'she waves');
    // In the list because it is in front of yours, which is the useful fact.
    // What it is a picture of is not yours to read.
    check('  and another account\'s job listed but not described',
      answer.jobs[2].mine === false && answer.jobs[2].prompt === undefined,
      JSON.stringify(answer.jobs[2]));
    S.forgetLiveJobs();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const panel = read('src/StudioPanel.jsx');
check('the panel asks for the queue and shows it',
  /fetch\('\/studio\/queue'/.test(panel) && /className="studio-queue"/.test(panel));
check('  slower than a progress bar: it is the shape of the wait, not the wait',
  /setInterval\(look, 2500\)/.test(panel));
check('  with a stop on each job of its own', /onClick=\{\(\) => cancel\(item\.id\)\}/.test(panel));
check('  and no strip at all when nothing is queued', /\{queue\.length > 0 && \(/.test(panel));
// The panel is hidden rather than unmounted when the reader leaves it, so
// "mounted" is not "open" -- and a panel nobody can see must not go on asking.
check('  and nothing asked while the panel is not the thing on screen',
  /if \(!open\) return undefined;/.test(panel) && /open=\{sidebarPlace === 'studio'\}/.test(app));

/* ============================================== and a song is a job like any other

   Five minutes of one, with the same claim on another device's screen. ACE-Step
   is not ComfyUI, so the only part that differs is which engine is asked how it
   is getting on. */

S.forgetLiveJobs();
S.rememberLiveJob({ id: 'song-1', owner: 'user-a', chat: '12', kind: 'music', prompt: 'lo-fi, rhodes piano' });
eq('a song being made is live for its conversation too',
  S.liveJobsFor('user-a', '12').map(job => [job.id, job.kind]), [['song-1', 'music']]);
S.forgetLiveJobs();

const music = read('server/music.js');
check('the music route records the conversation', /kind: 'music',/.test(music)
  && /owner: identify\(req\)/.test(music));
check('  and forgets the song when it is done or has failed',
  /if \(read\.failed\) forgetLiveJob\(id\);/.test(music)
  && /forgetLiveJob\(id\);[\s\S]{0,320}sendJson\(res, \{ success: true, id, done: true, tracks \}\)/.test(music));
check('the browser says which conversation a song is for',
  /\.\.\.\(currentSessionId \? \{ chat: String\(currentSessionId\) \} : \{\}\),\s*\n\s*\}\),\s*\n\s*signal,/.test(app));
// `/studio/job` has never heard of an ACE-Step id. Asked there it answers
// "unknown", which reads as "gone" and takes the card down mid-song.
check('and a watched song is asked of the engine making it, not of ComfyUI',
  /const song = drawing\.watched && drawing\.kind === 'music';/.test(app)
  && /`\/music\/status\?id=\$\{encodeURIComponent\(drawing\.id\)\}`/.test(app));

// One register, three kinds of work. Two registers would be two answers to
// "what is this machine doing".
check('all of it lives in one register', /from '\.\/liveJobs\.js'/.test(read('server/studio.js'))
  && /from '\.\/liveJobs\.js'/.test(music));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
