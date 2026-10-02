import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createChatJobStore, readChatJob, cancelChatJob, replayChatJob } from '../server/chatJobs.js';
import { readRequestBody } from '../server/requestBody.js';
import { memoryPressure, commitAvailable, commitShortfall, forgetCommit, isLocalAddress } from '../server/resourceSafety.js';
import fs from 'node:fs';
import { inferenceHook } from '../server/vram.js';

test('cancel releases controllers, is idempotent, and keeps a terminal replay frame', () => {
  for (const method of ['destroy', 'abort']) {
    const store = createChatJobStore();
    let stops = 0;
    store.begin(method);
    store.attach(method, { [method]: () => stops++ });
    store.appendChunk(method, '{"message":{"content":"hello"}}\n');
    assert.equal(store.stop(method), true);
    assert.equal(store.stop(method), false);
    assert.equal(stops, 1);
    assert.equal(store.read(method).controller, undefined);
    assert.equal(store.read(method).finished, true);
    assert.match(replayChatJob(store.read(method)), /"done":true/);
    assert.equal(store.appendChunk(method, 'late'), false);
  }
});

test('per-job response and tiny-frame limits stop generation without growing forever', () => {
  for (const limits of [{ maxJobBytes: 8192 }, { maxFrames: 3 }]) {
    const store = createChatJobStore({ limits });
    store.begin('large');
    let aborted = false;
    store.attach('large', { abort: () => { aborted = true; } });
    for (let i = 0; i < 10000; i++) store.appendChunk('large', 'x'.repeat(1024));
    assert.equal(aborted, true);
    assert.equal(store.read('large').finished, true);
    assert.ok(store.stats().bytes < 8192);
  }
});

test('global response bytes and job count stay bounded under repeated jobs', () => {
  const store = createChatJobStore({ limits: { maxJobs: 8, maxBytes: 32768, maxJobBytes: 16384 } });
  for (let i = 0; i < 1000; i++) {
    store.begin(String(i));
    store.appendChunk(String(i), 'x'.repeat(12000));
    store.finish(String(i));
    assert.ok(store.stats().jobs <= 8);
    assert.ok(store.stats().bytes <= 32768);
  }
  const busy = createChatJobStore({ limits: { maxJobs: 2 } });
  busy.begin('a'); busy.begin('b');
  assert.throws(() => busy.begin('c'), /Too many/);
  assert.equal(busy.stats().jobs, 2);
});

test('hung jobs expire, finished jobs are removed, and late frames cannot resurrect them', () => {
  let time = 0, cancelled = 0;
  const store = createChatJobStore({ now: () => time, limits: { maxRunMs: 100, retentionMs: 50 } });
  store.begin('hung');
  store.attach('hung', { abort: () => cancelled++ });
  time = 101; store.prune();
  assert.equal(cancelled, 1);
  assert.equal(store.read('hung').finished, true);
  time = 152; store.prune();
  assert.equal(store.read('hung'), null);
  store.appendFrame('hung', { message: { content: 'late' } });
  assert.deepEqual(store.stats(), { jobs: 0, bytes: 0 });
});

test('object and string frames replay as valid NDJSON', () => {
  const store = createChatJobStore();
  store.begin('object');
  store.appendFrame('object', { message: { content: '한글' } });
  store.stop('object');
  const frames = replayChatJob(store.read('object')).trim().split('\n').map(JSON.parse);
  assert.equal(frames[0].message.content, '한글');
  assert.equal(frames.at(-1).done, true);
});

test('oversized request stops buffering immediately, even if sender keeps writing', async () => {
  const req = new PassThrough();
  const reading = readRequestBody(req, 4);
  req.write('12345');
  await assert.rejects(reading, { statusCode: 413 });
  assert.equal(req.listenerCount('data'), 0);
  for (let i = 0; i < 100; i++) req.write(Buffer.alloc(4096));
  req.end();
});

test('request body is byte limited and aborts or times out cleanly', async () => {
  const req = new PassThrough();
  const reading = readRequestBody(req, 16);
  req.end('한글');
  assert.equal((await reading).toString(), '한글');
  const aborted = new PassThrough();
  const pending = readRequestBody(aborted);
  aborted.emit('aborted');
  await assert.rejects(pending, /aborted/);
  const slow = new PassThrough();
  // Keep an ordinary timer alive; the body deadline intentionally uses unref.
  const hold = setTimeout(() => {}, 100);
  await assert.rejects(readRequestBody(slow, 16, 10), { statusCode: 408 });
  clearTimeout(hold);
  assert.equal(slow.listenerCount('data'), 0);
});

test('RAM headroom scales with total memory and distinguishes critical pressure', () => {
  const gb = 1024 ** 3;
  assert.equal(memoryPressure(false, { total: 64 * gb, free: 6 * gb }), true);
  assert.equal(memoryPressure(false, { total: 64 * gb, free: 8 * gb }), false);
  assert.equal(memoryPressure(true, { total: 64 * gb, free: 1.5 * gb }), true);
  assert.equal(memoryPressure(true, { total: 64 * gb, free: 3 * gb }), false);
});

const listen = async server => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
};
const close = async server => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
};
const until = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition did not become true');
};

test('HTTP: split UTF-8, failures, duplicate jobs, cancellation and admission limits', async () => {
  let received = 0;
  const upstream = http.createServer((req, res) => {
    received++;
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      if (body.model === 'hang') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write('{"message":{"content":"started"}}\n');
      } else if (body.model === 'fail') {
        res.destroy();
      } else {
        const value = Buffer.from('{"message":{"content":"한글"},"done":true}\n');
        const split = value.indexOf(Buffer.from('한')) + 1;
        res.write(value.subarray(0, split));
        setTimeout(() => res.end(value.subarray(split)), 5);
      }
    });
  });
  const target = await listen(upstream);
  const hook = inferenceHook({ OLLAMA_URL: target }, { fetchImpl: async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  } });
  const app = http.createServer((req, res) => hook(req, res, () => res.end()));
  const base = await listen(app);
  const ask = (id, model = 'ok') => fetch(base + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Chat-Job-Id': id },
    body: JSON.stringify({ model }),
  });
  try {
    assert.match(await (await ask('safety-utf8')).text(), /한글/);
    assert.match(replayChatJob(readChatJob('safety-utf8')), /한글/);
    assert.equal(readChatJob('safety-utf8').controller, undefined);
    assert.equal((await ask('safety-utf8')).status, 409);
    assert.equal((await ask('safety-fail', 'fail')).status, 502);
    assert.equal(readChatJob('safety-fail').finished, true);
    assert.match(replayChatJob(readChatJob('safety-fail')), /"done":true/);
    const a = await ask('safety-a', 'hang');
    const b = await ask('safety-b', 'hang');
    const readA = a.text(), readB = b.text();
    assert.equal((await ask('safety-third')).status, 503);
    cancelChatJob('safety-a');
    cancelChatJob('safety-b');
    await Promise.all([readA, readB]);
    await until(() => readChatJob('safety-a').finished);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await ask('safety-after')).status, 200);
    const savedFree = os.freemem;
    const before = received;
    try {
      os.freemem = () => 0;
      assert.equal((await ask('safety-low-ram')).status, 503);
      assert.equal(received, before);
    } finally { os.freemem = savedFree; }
  } finally { await close(app); await close(upstream); }
});

test('GPU release failures refuse the next model instead of assuming memory is free', async () => {
  const { createVramGuard } = await import('../server/vram.js');
  const json = value => ({ ok: true, json: async () => value });
  const stuck = createVramGuard({}, { grace: 0, patience: 0, fetchImpl: async url => {
    if (url.endsWith('/api/ps')) return json({ models: [{ name: 'still-loaded', size_vram: 1 }] });
    return json({});
  } });
  await assert.rejects(stuck.releaseLlm(), /did not release/);
  const timeout = createVramGuard({}, { fetchImpl: async () => { throw new Error('Timeout'); } });
  await assert.rejects(timeout.releaseLlm(), /Timeout/);
  await assert.rejects(timeout.beforeInference(), /Timeout/);
});

test('external ComfyUI work and the handover window block inference after a restart', async () => {
  const { createVramGuard } = await import('../server/vram.js');
  let calls = 0;
  const guard = createVramGuard({}, { fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => ({ queue_running: ['external'], queue_pending: [] }) };
  } });
  assert.equal(await guard.beforeInference(), 'drawing');
  const release = guard.beginComfySubmission();
  calls = 0;
  assert.equal(await guard.beforeInference(), 'drawing');
  assert.equal(calls, 0);
  assert.equal(guard.isSwitching(), true);
  release(); release();
  assert.equal(guard.isSwitching(), false);
});

test('ComfyUI previews have a total byte cap and shutdown releases cached jobs', async () => {
  const { createComfyEvents } = await import('../server/comfyEvents.js');
  const events = createComfyEvents({ base: 'http://unused', clientId: 'test', WebSocketImpl: class {
    close() {}
  } });
  const frame = Buffer.alloc(20 * 1024 * 1024 + 8);
  frame.writeUInt32BE(1, 0); frame.writeUInt32BE(1, 4);
  for (let i = 0; i < 4; i++) {
    events.feed({ type: 'executing', data: { prompt_id: String(i), node: '1' } });
    events.feedBinary(frame);
  }
  const retained = [0,1,2,3].reduce((n, i) => n + (events.preview(String(i))?.body.byteLength || 0), 0);
  assert.ok(retained <= 32 * 1024 * 1024);
  events.close();
  assert.equal(events.get('3'), null);
  assert.equal(events.preview('3'), null);
});

test('browser replay terminates missing jobs and respects explicit abort', async () => {
  const { resumableChatReader } = await import('../src/chatStream.js');
  for (const status of [404, 410]) {
    let calls = 0;
    const reader = resumableChatReader(null, 'missing', new AbortController().signal,
      async () => { calls++; return new Response('', { status }); });
    await assert.rejects(reader.read(), error => error.status === status);
    assert.equal(calls, 1);
  }
  const controller = new AbortController();
  controller.abort();
  const reader = resumableChatReader(null, 'stopped', controller.signal,
    async () => { throw new Error('must not connect after stop'); });
  await assert.rejects(reader.read(), { name: 'AbortError' });
});

test('system monitor coalesces overlapping polls', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/SystemMonitor.jsx', import.meta.url), 'utf8');
  const start = source.indexOf('const poll = async');
  const end = source.indexOf('\n/**', start);
  const store = { controller: null, listeners: new Set([() => {}]), history: { cpu: [], ram: [], gpu: [], vram: [] } };
  let calls = 0, complete;
  const poll = new Function('store', 'fetch', 'emit', 'HISTORY', source.slice(start, end) + '\nreturn poll;')(
    store, () => { calls++; return new Promise(resolve => { complete = resolve; }); }, () => {}, 450);
  const pending = poll();
  await poll(); await poll();
  assert.equal(calls, 1);
  complete({ ok: true, json: async () => ({ ok: true, cpu: { usage: 10 } }) });
  await pending;
  assert.equal(store.controller, null);
  assert.deepEqual(store.history.cpu, [10]);
});

/* ComfyUI exited with 0xc0000005 loading MiniMax H3: 45GB of RAM free, and
   too little commit (RAM + page file) for the 40GB of weights Windows charges
   in full when a safetensors file is mapped. Free RAM said yes; commit is the
   number that decides. */
test('a model load is judged against commit, and refused before ComfyUI dies of it', async () => {
  const GB = 1024 ** 3;
  assert.equal(commitShortfall(50 * GB, 42 * GB), null);
  const short = commitShortfall(30 * GB, 42 * GB);
  assert.ok(short && /42GB/.test(short.message) && /30GB/.test(short.message) && /페이지 파일/.test(short.message));
  // A number that could not be read never refuses anything.
  assert.equal(commitShortfall(null, 42 * GB), null);

  forgetCommit();
  assert.equal(await commitAvailable({ platform: 'linux' }), null);
  const kb = await commitAvailable({ platform: 'win32', now: 1, run: (cmd, args, opts, done) => done(null, '1048576' + String.fromCharCode(13, 10)) });
  assert.equal(kb, GB);
  forgetCommit();
  assert.equal(await commitAvailable({ platform: 'win32', now: 2, run: (cmd, args, opts, done) => done(new Error('no powershell'), '') }), null);
  forgetCommit();

  assert.equal(isLocalAddress('http://127.0.0.1:8188'), true);
  assert.equal(isLocalAddress('http://localhost:8188'), true);
  assert.equal(isLocalAddress('http://192.168.0.20:8188'), false);

  const studio = fs.readFileSync(new URL('../server/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /if \(definition\.loadGB && isLocalAddress\(base\)\)/);
  assert.match(studio, /busy \? null : commitShortfall\(await commitAvailable\(\), definition\.loadGB \* 1024 \*\* 3\)/);
  assert.match(fs.readFileSync(new URL('../server/workflows.js', import.meta.url), 'utf8'), /loadGB: 42,/);
});
