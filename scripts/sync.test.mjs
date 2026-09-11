// The upload scheduler, and the reason an answer used to get cut off.
//
// A reply streaming into the chat rewrites the session store on every token, so
// the scheduler pushes constantly while one is being generated. Two things then
// went wrong together:
//
//   * The remote-change poll asked the server where the account stood and
//     compared it with the newest sync this device knew about. A sync that had
//     landed on the server but whose result had not yet come back read as
//     "another device changed something", so the poll pulled — and pulling ends
//     in a reload.
//   * The reload was guarded by "unless the user is busy", but that guard read
//     `isGenerating` through a closure created once at mount, where it was
//     false and stayed false. The guard never fired.
//
// The scheduler's half of the fix is `pending()`: while an upload is queued or
// in flight, the poll must not treat the server's timestamp as news. And
// `flush()` now reports whether the account really is up to date, because
// sign-out clears this device's cache on the strength of that answer.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const stub = path.resolve(HERE, '../node_modules/.localforage-sync-stub.mjs');
fs.writeFileSync(stub, `
const stores = new Map();
const inst = (name) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async getItem(k) { return m.has(k) ? m.get(k) : null; },
    async setItem(k, v) { m.set(k, v); return v; },
    async removeItem(k) { m.delete(k); },
    async iterate(fn) { for (const [k, v] of m) fn(v, k); },
    createInstance: ({ storeName }) => inst(storeName),
  };
};
export default inst('default');
`);

globalThis.localStorage = {
  _d: new Map(),
  get length() { return this._d.size; },
  key(i) { return [...this._d.keys()][i] ?? null; },
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};
globalThis.location = { origin: 'http://localhost:5173' };

// Every push is answered by hand, so the window between "the server has it" and
// "this device knows" can be held open for as long as a check needs.
let pending = [];
let calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET' });
  return new Promise((resolve) => {
    pending.push((body, status = 200) => resolve({
      ok: status < 300,
      status,
      json: async () => body,
    }));
  });
};

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/syncEngine.js'),
  external: ['react', 'react/jsx-runtime', 'lucide-react'],
  platform: 'neutral',
  resolve: { alias: { localforage: stub } },
});
const file = path.resolve(HERE, '../node_modules/.sync-test.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();

const S = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

/** Answer the oldest outstanding request. */
const answer = async (body, status = 200) => {
  const respond = pending.shift();
  if (!respond) throw new Error('no request was outstanding');
  respond(body, status);
  await settle();
};

const reset = () => { pending = []; calls = []; };

/* ------------------------------------------------------------ pending() */

reset();
let results = [];
let scheduler = S.createSyncScheduler({
  delay: 5,
  scope: () => 'srv-abc',
  onResult: (r) => results.push(r),
  onError: () => {},
});

eq('an idle scheduler is not pending', scheduler.pending(), false);

scheduler.schedule();
eq('a scheduled upload is pending before it fires', scheduler.pending(), true);

await new Promise(r => setTimeout(r, 20));
eq('and still pending once it is in flight', scheduler.pending(), true);
check('the upload really was sent', calls.some(c => c.url === '/api/auth/sync' && c.method === 'POST'));

// This is the window the poll used to fire in: the server has the new state,
// but this device has not yet recorded the timestamp it was given.
await answer({ success: true, ownerId: 'abc', rev: 5000, applied: 0, rejected: 0, records: [], complete: true });
eq('once answered it is no longer pending', scheduler.pending(), false);
eq('and the result was reported', results.length, 1);
eq('with the revision the device must record', results[0].rev, 5000);
scheduler.cancel();

/* ------------------------------------------------------------- flush() */

reset();
results = [];
scheduler = S.createSyncScheduler({
  delay: 10000,          // long enough that only an explicit flush can fire it
  scope: () => 'srv-abc',
  onResult: (r) => results.push(r),
  onError: () => {},
});

scheduler.schedule();
const flushed = scheduler.flush();
await settle();
check('flushing sends immediately rather than waiting for the timer',
  calls.some(c => c.url === '/api/auth/sync'));

await answer({ success: true, ownerId: 'abc', rev: 6000, applied: 0, rejected: 0, records: [], complete: true });
eq('and reports that the account is up to date', await flushed, true);
scheduler.cancel();

// A failed upload must say so. Sign-out clears this device's cache on the
// strength of this answer, so a hopeful `true` loses the settings outright.
reset();
let errors = [];
scheduler = S.createSyncScheduler({
  delay: 10000,
  scope: () => 'srv-abc',
  onResult: () => {},
  onError: (e) => errors.push(e),
});
const failing = scheduler.flush();
await settle();
await answer({ success: false, error: 'disk full' }, 500);
eq('a failed upload reports false', await failing, false);
eq('and the failure is surfaced', errors.length, 1);
scheduler.cancel();

// Two callers, one upload: the second must wait for the first rather than being
// told someone else is doing it and returning as though it had finished.
reset();
results = [];
scheduler = S.createSyncScheduler({
  delay: 10000,
  scope: () => 'srv-abc',
  onResult: (r) => results.push(r),
  onError: () => {},
});
const first = scheduler.flush();
await settle();
const second = scheduler.flush();
await settle();
eq('the second caller did not start a second upload',
  calls.filter(c => c.url === '/api/auth/sync').length, 1);
await answer({ success: true, ownerId: 'abc', rev: 7000, applied: 0, rejected: 0, records: [], complete: true });
eq('the first caller sees the result', await first, true);
eq('and so does the second', await second, true);
scheduler.cancel();

/* --------------------------------------------------- nothing to sync */

// Signed out there is no account to sync with, so an upload is not merely
// skipped — it must never be attempted, or the guest's chats go somewhere.
reset();
scheduler = S.createSyncScheduler({ delay: 5, scope: () => '', onError: () => {} });
eq('the guest reports nothing to do', await scheduler.flush(), true);
eq('and sends nothing', calls.filter(c => c.url === '/api/auth/sync').length, 0);
scheduler.cancel();

reset();
scheduler = S.createSyncScheduler({ delay: 5, scope: () => null, onError: () => {} });
eq('an unresolved scope sends nothing either', await scheduler.flush(), true);
eq('really nothing', calls.filter(c => c.url === '/api/auth/sync').length, 0);
scheduler.cancel();

/* ------------------------------------------------------ owner mismatch */

// The server says this session belongs to somebody else. Retrying would turn
// one wrong upload into a loop of them, so the scheduler stops itself.
reset();
let mismatches = [];
scheduler = S.createSyncScheduler({
  delay: 5,
  scope: () => 'srv-abc',
  onResult: () => {},
  onError: () => {},
  onOwnerMismatch: (e) => mismatches.push(e),
});
const refused = scheduler.flush();
await settle();
await answer({ success: false, code: 'owner-mismatch', error: 'wrong account' }, 409);
eq('the upload reports failure', await refused, false);
eq('and the mismatch is reported once', mismatches.length, 1);

reset();
scheduler.schedule();
await new Promise(r => setTimeout(r, 20));
eq('a stopped scheduler sends nothing more',
  calls.filter(c => c.url === '/api/auth/sync').length, 0);
eq('and reports itself as not pending', scheduler.pending(), false);
scheduler.cancel();

/* ------------------------------------------- the ceiling on coalescing */

// A debounce with no ceiling is not coalescing, it is postponement. Every
// change pushes the timer out by the full delay, so a change arriving more
// often than the delay means the timer never fires at all -- and a streaming
// reply is precisely that: the chat is rewritten several times a second for as
// long as the model is talking.
//
// The visible symptom was on the other device. It received the empty assistant
// placeholder, then nothing at all until the answer was finished, so it sat on
// "Thinking..." for the whole of a long reply. `maxDelay` is the promise that a
// change is sent within that long however busy things are.

reset();
scheduler = S.createSyncScheduler({
  delay: 50,             // never reached: the changes below are 10ms apart
  maxDelay: 120,
  scope: () => 'srv-abc',
  onResult: () => {},
  onError: () => {},
});

// Twenty changes at 10ms is 200ms of continuous editing. Under a plain
// debounce of 50ms, not one of them would have been sent.
for (let i = 0; i < 20; i++) {
  scheduler.schedule();
  await new Promise(r => setTimeout(r, 10));
}
check('a stream of changes is uploaded rather than postponed',
  calls.some(c => c.url === '/api/auth/sync' && c.method === 'POST'),
  `${calls.length} calls`);
scheduler.cancel();
reset();

// And with no ceiling asked for, the old behaviour is exactly as it was --
// which is what every other caller of this scheduler still relies on.
scheduler = S.createSyncScheduler({
  delay: 50,
  scope: () => 'srv-abc',
  onResult: () => {},
  onError: () => {},
});
for (let i = 0; i < 20; i++) {
  scheduler.schedule();
  await new Promise(r => setTimeout(r, 10));
}
eq('without a ceiling, a plain debounce still waits for quiet',
  calls.filter(c => c.url === '/api/auth/sync').length, 0);
scheduler.cancel();
reset();

// Quiet is still quiet: one change, and the ceiling does not make it fire any
// sooner than the delay it was given.
scheduler = S.createSyncScheduler({
  delay: 40,
  maxDelay: 500,
  scope: () => 'srv-abc',
  onResult: () => {},
  onError: () => {},
});
scheduler.schedule();
await new Promise(r => setTimeout(r, 15));
eq('a single change still waits out the delay',
  calls.filter(c => c.url === '/api/auth/sync').length, 0);
await new Promise(r => setTimeout(r, 60));
eq('and then goes', calls.filter(c => c.url === '/api/auth/sync').length, 1);
scheduler.cancel();

/* ------------------------------------------------- a cancelled scheduler */

reset();
scheduler = S.createSyncScheduler({ delay: 5, scope: () => 'srv-abc', onError: () => {} });
scheduler.schedule();
scheduler.cancel();
await new Promise(r => setTimeout(r, 20));
eq('cancelling drops the queued upload',
  calls.filter(c => c.url === '/api/auth/sync').length, 0);
eq('and it is not pending', scheduler.pending(), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
