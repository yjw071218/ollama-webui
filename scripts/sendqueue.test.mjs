// A question that could not be sent, kept rather than lost.
//
// The failure is ordinary: the phone is at the far end of the house and the
// wifi drops for four seconds, or Ollama is still loading a 30B model, or the
// laptop went to sleep. What happened then was `**Error:** Failed to fetch`
// where the answer should be — and the question was gone, because the composer
// had already been cleared.
//
// The rules that matter are about not making it worse: never retry something
// that will fail identically, never retry so fast that four attempts burn
// through before the wifi has noticed it dropped, and never silently send
// something written an hour ago.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const map = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  },
});

const bundle = await rolldown({ input: path.resolve(HERE, '../src/sendQueue.js'), platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.sendqueue-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  MAX_ATTEMPTS, backoffMs, loadQueue, saveQueue, isRetryable,
  makeEntry, enqueue, removeEntry, noteAttempt, nextDue, stalled,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const SCOPE = 'srv-1';
const reset = () => { map.clear(); };

/* ------------------------------------------------- what is worth retrying */

// The ones that might work next time.
for (const message of [
  'Failed to fetch', 'NetworkError when attempting to fetch',
  'Load failed', 'connect ECONNREFUSED 127.0.0.1:11434', 'ETIMEDOUT', 'socket timeout',
]) {
  check(`"${message.slice(0, 34)}" is worth retrying`, isRetryable(new Error(message)));
}
check('a 503 is worth retrying', isRetryable(Object.assign(new Error('x'), { status: 503 })));
check('a 429 is worth retrying', isRetryable(Object.assign(new Error('x'), { status: 429 })));
check('a 408 is worth retrying', isRetryable(Object.assign(new Error('x'), { status: 408 })));

// The ones that will fail identically, so retrying only delays telling you.
check('a 400 is not', !isRetryable(Object.assign(new Error('bad request'), { status: 400 })));
check('a 404 is not', !isRetryable(Object.assign(new Error('no such model'), { status: 404 })));
check('a plain bug is not', !isRetryable(new TypeError('x is not a function')));
check('nothing is not', !isRetryable(null));

// The stop button is not a failure, and queueing it would resend a reply the
// person deliberately cancelled.
check('aborting is never retried', !isRetryable(Object.assign(new Error('aborted'), { name: 'AbortError' })));

/* -------------------------------------------------------------- the wait */

check('the first wait is short', backoffMs(0) <= 2000, String(backoffMs(0)));
check('and it grows', backoffMs(3) > backoffMs(1));
check('but is capped', backoffMs(20) === 30000, String(backoffMs(20)));
check('so a laptop that is asleep is not asked every four minutes', backoffMs(50) === 30000);

/* -------------------------------------------------------- keeping them */

reset();
const entry = makeEntry({
  sessionId: 7,
  model: 'qwen3',
  text: 'a question worth two minutes of writing',
  attachments: [
    { type: 'text', name: 'notes.txt', data: 'x' },
    { type: 'pasted', name: 'pasted.js', data: 'y' },
    // A data URL of several megabytes has no business in localStorage.
    { type: 'image', name: 'photo.png', data: 'AAAA'.repeat(100000) },
  ],
});
eq('the text is kept', entry.text, 'a question worth two minutes of writing');
eq('text attachments travel', entry.attachments.length, 2);
eq('images do not', entry.attachments.filter(a => a.type === 'image').length, 0);
eq('but they are named, so the retry can say what it lost', entry.droppedAttachments.join(','), 'photo.png');

enqueue(SCOPE, entry);
eq('it is in the queue', loadQueue(SCOPE).length, 1);

// Survives a reload: the failures that matter most are the ones where you give
// up and refresh.
eq('and it is in storage, not just in memory', JSON.parse(map.get(`sendQueue@${SCOPE}`)).length, 1);

// One account's held questions are not another's.
eq('another scope has its own queue', loadQueue('srv-2').length, 0);

/* --------------------------------------------------------- when to try */

reset();
enqueue(SCOPE, makeEntry({ sessionId: 1, text: 'first', at: 1000 }));
const first = loadQueue(SCOPE)[0];
check('a fresh entry is due at once', nextDue(loadQueue(SCOPE), 1000)?.id === first.id);

noteAttempt(SCOPE, first.id, new Error('Failed to fetch'), 1000);
const afterOne = loadQueue(SCOPE)[0];
eq('the attempt is counted', afterOne.attempts, 1);
eq('and the error kept, so the person can see why', afterOne.lastError, 'Failed to fetch');

// The one that matters: without a recorded time, all four attempts would fire
// in the same instant.
check('it is not due again immediately', nextDue(loadQueue(SCOPE), 1000) === null);
check('but it is once the wait has passed',
  nextDue(loadQueue(SCOPE), 1000 + backoffMs(1) + 1)?.id === first.id);

// Giving up rather than sending something written an hour ago.
reset();
enqueue(SCOPE, makeEntry({ sessionId: 1, text: 'x', at: 0 }));
const id = loadQueue(SCOPE)[0].id;
for (let i = 0; i < MAX_ATTEMPTS; i++) noteAttempt(SCOPE, id, new Error('nope'), 0);
check('it stops trying', nextDue(loadQueue(SCOPE), 1e9) === null);
eq('and is listed as needing a person', stalled(loadQueue(SCOPE)).length, 1);

/* ------------------------------------------------------------- removal */

reset();
enqueue(SCOPE, makeEntry({ sessionId: 1, text: 'a' }));
enqueue(SCOPE, makeEntry({ sessionId: 1, text: 'b' }));
const [a] = loadQueue(SCOPE);
removeEntry(SCOPE, a.id);
eq('one can be discarded', loadQueue(SCOPE).length, 1);
eq('and the right one is left', loadQueue(SCOPE)[0].text, 'b');
removeEntry(SCOPE, loadQueue(SCOPE)[0].id);
check('an empty queue leaves nothing behind', map.get(`sendQueue@${SCOPE}`) === undefined);

/* -------------------------------------------------------- broken storage */

map.set(`sendQueue@${SCOPE}`, 'not json at all');
eq('rubbish in storage reads as empty', loadQueue(SCOPE).length, 0);
map.set(`sendQueue@${SCOPE}`, '{"not":"an array"}');
eq('and so does the wrong shape', loadQueue(SCOPE).length, 0);

/* ------------------------------------------------------------ the wiring */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

check('a failed send is queued rather than lost',
  /isRetryable\(err\) && !isAutoTool && originalInput\.trim\(\)/.test(app));
check('and the question it holds is the one that was typed',
  /text: originalInput/.test(app));
check('a retry waits for the app to be idle',
  /if \(isGeneratingRef\.current\) return;/.test(app));
check('and does not bother while the browser knows it is offline',
  /navigator\.onLine === false/.test(app));
check('the wifi coming back is a trigger of its own',
  /addEventListener\('online', attempt\)/.test(app));
// Two retries of one entry would send the question twice, which is worse than
// not sending it at all.
check('only one retry runs at a time', /retryingRef\.current/.test(app));
check('a held question whose chat is gone is dropped rather than misfiled',
  /its chat no longer exists/.test(app));
check('the queue is on screen', /className="send-queue"/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
