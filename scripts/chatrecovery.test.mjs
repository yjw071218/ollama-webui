import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createChatJobStore, followChatJob } from '../server/chatJobs.js';
import { resumableChatReader } from '../src/chatStream.js';

// Run the actual restoration effects with a small hook scheduler so storage
// writes and subsequent renders occur in the same order as in the browser.
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const drawingEffects = app.slice(app.indexOf('  const [drawing, setDrawing]'),
  app.indexOf('  /* A picture this conversation is having made somewhere else.'));
const drawingHarness = ({ chat = 'A', generating = null, saved = {}, status } = {}) => {
  const storage = new Map(Object.entries(saved));
  const hooks = [], effects = [], writes = [];
  let cursor = 0, dirty = true, polls = 0;
  const state = { drawing: null, generating, busy: !!generating };
  const context = vm.createContext({
    currentSessionId: chat, generatingSessionId: generating, profileScope: 'test',
    DRAWING_WINDOW_MS: 21600000,
    localStorage: { getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    useState: () => [state.drawing, value => {
      state.drawing = typeof value === 'function' ? value(state.drawing) : value; dirty = true;
    }],
    useRef: value => hooks[cursor++] ??= { current: value },
    useEffect: (run, deps) => {
      const index = cursor++, old = hooks[index];
      if (!old || deps.some((v, i) => !Object.is(v, old.deps[i]))) {
        effects.push(() => { old?.cleanup?.(); hooks[index] = { deps, cleanup: run() }; });
      }
    },
    setGeneratingSessionId: value => { state.generating = value; dirty = true; },
    setIsGenerating: value => { state.busy = value; dirty = true; },
    forgetGeneration: () => {},
    fetchJsonQuietly: async () => { polls++; return status; },
    finalOutput: (outputs = []) => outputs[0],
    reviseSession: (id, change) => writes.push({ id, session: change({ messages: [{ role: 'assistant' }] }) }),
    setInterval: () => 1, clearInterval: () => {},
  });
  return { state, storage, writes, get polls() { return polls; },
    async settle() {
      for (let i = 0; i < 12 && dirty; i++) {
        dirty = false; cursor = 0; context.generatingSessionId = state.generating;
        vm.runInContext(`(() => { ${drawingEffects} })()`, context);
        while (effects.length) effects.shift()();
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(dirty, false, 'restoration must settle instead of repeatedly restoring a finished job');
    },
    navigate(id) { context.currentSessionId = id; dirty = true; },
  };
};
const drawingKey = chat => `chatDrawing:test:${chat}`;
const savedDrawing = () => JSON.stringify({ id: 'picture', sessionId: 'A', startedAt: Date.now() });

for (const state of ['done', 'failed', 'unknown']) {
  test(`restored ${state} picture clears its key before another render can restore it`, async () => {
    const h = drawingHarness({ saved: { [drawingKey('A')]: savedDrawing() },
      status: { state, outputs: [{ url: '/picture.png', filename: 'picture.png' }] } });
    await h.settle();
    assert.equal(h.storage.has(drawingKey('A')), false);
    assert.equal(h.state.drawing, null);
    assert.equal(h.state.busy, false);
    assert.equal(h.polls, 1);
    assert.equal(h.writes.length, state === 'done' ? 1 : 0);
  });
}

test('finished picture without outputs also stops the restored generation', async () => {
  const h = drawingHarness({ saved: { [drawingKey('A')]: savedDrawing() }, status: { state: 'done' } });
  await h.settle();
  assert.equal(h.state.busy, false);
  assert.equal(h.storage.size, 0);
});

test('a restored background picture writes its result only to its original chat', async () => {
  const h = drawingHarness({ chat: 'B', generating: 'A', saved: { [drawingKey('A')]: savedDrawing() },
    status: { state: 'done', outputs: [{ url: '/picture.png' }] } });
  await h.settle();
  assert.deepEqual(h.writes.map(w => w.id), ['A']);
  assert.equal(h.storage.size, 0);
  assert.equal(h.state.busy, false);
});

test('navigating during a running picture never copies its recovery key to another chat', async () => {
  const h = drawingHarness({ saved: { [drawingKey('A')]: savedDrawing() }, status: { state: 'running' } });
  await h.settle();
  h.navigate('B');
  await h.settle();
  assert.equal(h.storage.has(drawingKey('A')), true);
  assert.equal(h.storage.has(drawingKey('B')), false);
});

test('a recovery key copied by an older version cannot restore another chat\'s picture', async () => {
  const h = drawingHarness({ chat: 'B', saved: { [drawingKey('B')]: savedDrawing() }, status: { state: 'running' } });
  await h.settle();
  assert.equal(h.polls, 0);
  assert.equal(h.state.drawing, null);
  assert.equal(h.storage.size, 0);
});

test('text replay restores the answer without navigating away from the selected chat', async () => {
  const source = app.slice(app.indexOf('  // Restore one server-owned generation'),
    app.indexOf('  /* The picture being drawn for the answer that is being written.'));
  const navigations = [], writes = [];
  let forgotten = false, busy = false;
  const saved = { jobId: 'finished', sessionId: 'A', messageIndex: 0 };
  const frames = [
    { cli_started: { provider: 'codex', startedAt: 123 }, cli_activity: { phase: 'thinking', at: 124 } },
    { cli_activity: { phase: 'running', at: 125 } },
    { message: { content: '복구된 답변' }, done: true },
  ].map(frame => new TextEncoder().encode(JSON.stringify(frame) + '\n'));
  vm.runInNewContext(source, {
    isStorageLoaded: true, generationStorageKey: 'generation',
    localStorage: { getItem: () => JSON.stringify(saved) },
    AbortController, TextDecoder, abortControllerRef: { current: null },
    useEffect: run => run(),
    fetch: async () => ({ json: async () => ({ known: true, running: false }) }),
    setCurrentSessionId: id => navigations.push(id),
    setGeneratingSessionId: () => {}, setIsGenerating: value => { busy = value; },
    isGeneratingRef: { current: false },
    resumableChatReader: () => ({ read: async () => frames.length
      ? { done: false, value: frames.shift() } : { done: true } }),
    decodeByteFallback: text => text,
    reviseSession: (id, change) => writes.push({ id, session: change({ messages: [{ content: '' }] }) }),
    drawingLooksLive: () => false, drawingKeyFor: id => id,
    flushSync: run => run(), persistSessions: async () => true, sessionsRef: { current: [] },
    forgetGeneration: () => { forgotten = true; }, addLog: () => {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(navigations, []);
  assert.equal(writes.at(-1).id, 'A');
  assert.equal(writes.at(-1).session.messages[0].content, '복구된 답변');
  assert.equal(writes[0].session.messages[0].cliActivity.phase, 'thinking');
  assert.equal(writes[1].session.messages[0].cliActivity.phase, 'running');
  assert.equal(writes.at(-1).session.messages[0].cliActivity, null);
  assert.equal(writes.at(-1).session.messages[0].cliStarted.startedAt, 123);
  assert.equal(busy, false);
  assert.equal(forgotten, true);
});

const drain = async reader => {
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    chunks.push(Buffer.from(value));
  }
};

test('a live replay survives subscriber closure and preserves UTF-8 and final metrics', async () => {
  const store = createChatJobStore();
  const job = store.begin('live');
  let cancelled = 0;
  store.attach(job.id, { abort: () => cancelled++ });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://test');
    followChatJob(req, res, job, url.searchParams.get('offset'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    store.appendChunk(job.id, '{"message":{"content":"시작 🎉"}}\n');
    const controller = new AbortController();
    const first = await fetch(url, { signal: controller.signal });
    const part = await first.body.getReader().read();
    assert.match(new TextDecoder().decode(part.value), /시작 🎉/);
    controller.abort();
    assert.equal(cancelled, 0);

    // Another tab attaches before completion and sees newly emitted tokens.
    const resumed = resumableChatReader(null, job.id, new AbortController().signal,
      (path, options) => fetch(url + path, options));
    const initial = await resumed.read();
    assert.match(new TextDecoder().decode(initial.value), /시작/);
    store.appendChunk(job.id, '{"message":{"content":" 끝부분 유지"}}\n');
    const next = await resumed.read();
    assert.match(new TextDecoder().decode(next.value), /끝부분 유지/);
    assert.equal(job.finished, false);
    store.appendChunk(job.id, '{"done":true,"eval_count":123,"eval_duration":1000000000}');
    store.finish(job.id);
    const tail = await drain(resumed);
    assert.equal(JSON.parse(tail).eval_count, 123);
    assert.equal(cancelled, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('reconnect after a byte inside a Korean character neither duplicates nor corrupts text', async () => {
  const wire = Buffer.from('{"message":{"content":"한글 😀 끝"},"done":true}\n');
  const split = wire.indexOf(Buffer.from('한')) + 1;
  let calls = 0;
  const response = { body: { getReader: () => ({
    async read() {
      if (calls++ === 0) return { value: wire.subarray(0, split), done: false };
      throw new TypeError('connection lost');
    }, cancel: async () => {},
  }) } };
  const reader = resumableChatReader(response, 'same-job', new AbortController().signal,
    async url => {
      assert.match(url, /id=same-job/);
      assert.equal(Number(new URL(url, 'http://test').searchParams.get('offset')), split);
      return new Response(wire.subarray(split));
    });
  assert.equal(await drain(reader), wire.toString('utf8'));
});

test('an explicit server stop terminates all subscribers with a terminal frame', async () => {
  const store = createChatJobStore();
  const job = store.begin('stop');
  let stops = 0;
  store.attach(job.id, { abort: () => stops++ });
  assert.equal(store.stop(job.id), true);
  assert.equal(stops, 1);
  assert.equal(JSON.parse(job.frames.at(-1)).done, true);
  assert.equal(store.appendChunk(job.id, 'late text'), false);
});

test('streaming UTF-8 decoder retains every character at every byte boundary', () => {
  const text = JSON.stringify({ content: '한국어 日本語 😀 마지막', metrics: { evalCount: 321 } });
  const bytes = Buffer.from(text);
  for (let split = 1; split < bytes.length; split++) {
    const decoder = new StringDecoder('utf8');
    assert.equal(decoder.write(bytes.subarray(0, split)) + decoder.end(bytes.subarray(split)), text);
  }
});
