import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createChatJobStore } from '../server/chatJobs.js';
import { watchLiveJobs, busyChats } from '../src/liveJobs.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('PC and mobile jobs finish independently, including a split terminal frame before socket close', () => {
  const store = createChatJobStore();
  store.begin('pc', { owner: 'u', chat: 'A', kind: 'cli' });
  store.begin('mobile', { owner: 'u', chat: 'B', kind: 'cli' });
  store.begin('private', { owner: 'other', chat: 'C' });
  assert.deepEqual(new Set(store.live('u').map(j => j.id)), new Set(['pc', 'mobile']));
  assert.deepEqual(busyChats(store.live('u'), 'B', 'B'), ['A']);
  store.appendChunk('pc', '{"message":{"content":"done is just text"}}\n{"do');
  assert.equal(store.live('u').length, 2);
  store.appendChunk('pc', 'ne":true,"eval_count":2}\n');
  assert.deepEqual(store.live('u').map(j => j.id), ['mobile']);
  assert.deepEqual(busyChats(store.live('u'), 'B', 'B'), []);
  store.appendFrame('mobile', { error: 'cancelled' });
  assert.deepEqual(store.live('u'), []);
  assert.equal(store.live('other').length, 1);
});

test('parallel CLI requests in the same chat remain live only until their own terminal frame', () => {
  const store = createChatJobStore();
  store.begin('pc', { owner: 'u', chat: 'A', kind: 'cli' });
  store.begin('mobile', { owner: 'u', chat: 'A', kind: 'cli' });
  store.appendFrame('mobile', { done: true });
  assert.deepEqual(store.live('u', 'A').map(job => job.id), ['pc']);
  store.appendChunk('pc', '{"done":true}');
  assert.deepEqual(store.live('u', 'A'), []);
  assert.equal(store.appendFrame('pc', { cli_activity: { phase: 'running' } }), false);
});

test('mobile refreshes the complete snapshot on return, preserves state offline and removes listeners', async () => {
  const win = new EventTarget(), doc = new EventTarget(); doc.hidden = false;
  let jobs = [{ id: 'pc', chat: 'A' }], fail = false, calls = 0;
  const snapshots = [];
  const stop = watchLiveJobs(value => snapshots.push(value), { win, doc, interval: 60000,
    fetcher: async () => { calls++; if (fail) throw new Error('offline'); return { ok: true, json: async () => ({ success: true, jobs }) }; } });
  await tick(); assert.equal(snapshots[0][0].id, 'pc');
  fail = true; win.dispatchEvent(new Event('online')); await tick();
  assert.equal(snapshots.length, 1);
  fail = false; jobs = []; doc.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.deepEqual(snapshots.at(-1), []);
  stop(); const previous = calls; win.dispatchEvent(new Event('focus')); await tick();
  assert.equal(calls, previous);
});

test('a mobile request in B does not hide PC activity in A; a missed completion reconciles an open replay', async () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const begin = app.indexOf('  useEffect(() => {', app.indexOf('  /* The words of an answer another device is writing.'));
  const ending = '}, [currentSessionId, isStorageLoaded, isGenerating, generatingSessionId]);';
  const source = app.slice(begin, app.indexOf(ending, begin) + ending.length);
  const doc = new EventTarget(), win = new EventTarget(); doc.hidden = false;
  let cleanup, state, timer, jobs = [{ id: 'pc', chat: 'A', startedAt: 1000 }];
  vm.runInNewContext(source, {
    isStorageLoaded: true, currentSessionId: 'A', isGenerating: true, generatingSessionId: 'B',
    AbortController, TextDecoder, document: doc, window: win,
    useEffect: run => { cleanup = run(); },
    setFollowed: value => { state = typeof value === 'function' ? value(state) : value; },
    setInterval: fn => { timer = fn; return 1; }, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    fetchJsonQuietly: async () => ({ success: true, jobs, job: jobs[0] || null, now: 2000 }),
    resumableChatReader: (_response, _id, signal) => ({ read: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) }),
    decodeByteFallback: text => text, fenceThinking: text => text,
    sessionsRef: { current: [] }, askedCount: () => 0,
  });
  try {
    await tick(); assert.equal(state.id, 'pc'); assert.equal(state.live, true, 'shown before first token');
    jobs = []; timer(); await tick();
    assert.equal(state.live, false); assert.equal(state.cliActivity, null);
  } finally { cleanup(); }
});
