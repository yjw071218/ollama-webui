// One model on the graphics card at a time.
//
// Reported as: asking the chat for a picture makes the whole computer lag. The
// chat model was still resident when ComfyUI loaded a checkpoint on top of it,
// and on a 16GB card both spilled into system RAM. Nothing about that shows up
// in a browser — the evidence is which calls the server made to Ollama and to
// ComfyUI, and in what order — so that is what is checked, against paper
// versions of both.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const V = await import(pathToFileURL(path.join(ROOT, 'server/vram.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'server/studio.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const GIB = 1024 ** 3;
const OLLAMA = 'http://127.0.0.1:11434';
const LLAMA = 'http://127.0.0.1:8080';
const COMFY = 'http://127.0.0.1:8188';

/**
 * Ollama, llama.cpp and ComfyUI, made of paper.
 *
 * `loaded` is what the language model server has in memory; an unload takes it
 * out. `comfyQueue` is what ComfyUI is doing, and `comfyHeld` what its torch
 * has reserved until a `/free` arrives.
 */
const fakeWorld = ({
  loaded = [], comfyQueue = { running: [], pending: [] }, comfyHeld = 8 * GIB, down = [],
  /* What `/free` can actually get down to, and how big the card is. Both
     default to what they were before this: everything releases, and ComfyUI
     does not say how big the card is. A real install reports both. */
  comfyFloor = 256 * 1024 * 1024,
  cardTotal = null,
} = {}) => {
  const calls = [];
  const state = { loaded: [...loaded], comfyHeld };
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method, body });
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (down.some(host => String(url).startsWith(host))) throw new Error('ECONNREFUSED');

    if (url === `${OLLAMA}/api/ps`) return json({ models: state.loaded.map(name => ({ name })) });
    if (url === `${OLLAMA}/api/generate`) {
      if (body?.keep_alive === 0) state.loaded = state.loaded.filter(n => n !== body.model);
      return json({ done: true, done_reason: 'unload' });
    }
    if (url === `${LLAMA}/models`) {
      // Two it knows but has not loaded, then whatever it has.
      return json({ data: ['on-disk-1', 'on-disk-2', ...state.loaded].map(id => ({
        id, status: { value: state.loaded.includes(id) ? 'loaded' : 'unloaded' },
      })) });
    }
    if (url === `${LLAMA}/models/unload`) {
      state.loaded = state.loaded.filter(n => n !== body.model);
      return json({ success: true });
    }
    if (url === `${COMFY}/queue` && method === 'GET') {
      return json({
        queue_running: comfyQueue.running.map(id => [0, id, {}, {}, []]),
        queue_pending: comfyQueue.pending.map((id, n) => [n + 1, id, {}, {}, []]),
      });
    }
    if (url === `${COMFY}/free`) { state.comfyHeld = Math.min(state.comfyHeld, comfyFloor); return json({}); }
    if (url === `${COMFY}/system_stats`) {
      return json({ devices: [{
        torch_vram_total: state.comfyHeld,
        ...(cardTotal ? { vram_total: cardTotal, vram_free: cardTotal - state.comfyHeld } : {}),
      }] });
    }
    if (url === `${COMFY}/prompt`) return json({ prompt_id: 'job-1' });
    return json({});
  };
  return { calls, state, fetchImpl };
};
const hits = (calls, suffix, method) => calls.filter(c => c.url.endsWith(suffix) && (!method || c.method === method));

/* ------------------------------------------------------------ the pieces */

check('a chat is inference', V.isInference('/api/chat'));
check('so is a completion and an embedding',
  V.isInference('/api/generate') && V.isInference('/api/embed') && V.isInference('/api/embeddings'));
check('the model list is not', !V.isInference('/api/tags') && !V.isInference('/api/ps'));
check('nor is a picture', !V.isInference('/studio/generate'));

check('on unless switched off', V.exclusiveEnabled({}) && V.exclusiveEnabled({ VRAM_EXCLUSIVE: 'true' }));
check('and switched off by saying false', !V.exclusiveEnabled({ VRAM_EXCLUSIVE: ' False ' }));

eq('what Ollama has loaded', V.loadedOllama({ models: [{ name: 'gemma3:27b' }, { model: 'bge-m3' }] }),
  ['gemma3:27b', 'bge-m3']);
eq('what llama.cpp has loaded, out of everything it knows',
  V.loadedLlama({ data: [{ id: 'x', status: { value: 'loaded' } }, { id: 'y', status: { value: 'unloaded' } }] }),
  ['x']);
check('a busy ComfyUI is busy', V.comfyBusy({ queue_running: [[0, 'a']] }) && V.comfyBusy({ queue_pending: [[0, 'b']] }));
check('an idle one is not', !V.comfyBusy({ queue_running: [], queue_pending: [] }) && !V.comfyBusy(null));

/* ---------------------------------------------- before a picture: the LLM off */

{
  const world = fakeWorld({ loaded: ['qwen3:30b', 'bge-m3'] });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  const unloaded = await guard.releaseLlm();
  eq('every loaded model is unloaded', unloaded, ['qwen3:30b', 'bge-m3']);
  eq('with keep_alive 0, which is Ollama\'s "now"',
    hits(world.calls, '/api/generate').map(c => c.body), [
      { model: 'qwen3:30b', keep_alive: 0 },
      { model: 'bge-m3', keep_alive: 0 },
    ]);
  eq('and it waits until they are actually gone', world.state.loaded, []);
  check('which it checks rather than assumes', hits(world.calls, '/api/ps').length >= 2);
}

{
  const world = fakeWorld({ loaded: [] });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  eq('nothing loaded, nothing unloaded', await guard.releaseLlm(), []);
  eq('and nothing asked to unload', hits(world.calls, '/api/generate').length, 0);
}

{
  const world = fakeWorld({ down: [OLLAMA] });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  eq('an Ollama that is not running holds nothing, and is no reason to fail', await guard.releaseLlm(), []);
}

{
  const world = fakeWorld({ loaded: ['a'] });
  const guard = V.createVramGuard({ LLM_BACKEND: 'llamacpp' }, { fetchImpl: world.fetchImpl });
  eq('under llama.cpp, the resident one is unloaded', await guard.releaseLlm(), ['a']);
  eq('through its own unload call', hits(world.calls, '/models/unload').map(c => c.body), [{ model: 'a' }]);
  eq('and Ollama is never asked', world.calls.filter(c => c.url.startsWith(OLLAMA)).length, 0);
}

{
  const world = fakeWorld({ loaded: ['a'] });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  const [one, two, three] = await Promise.all([guard.releaseLlm(), guard.releaseLlm(), guard.releaseLlm()]);
  eq('three at once cause one unload, not three', hits(world.calls, '/api/generate').length, 1);
  check('and all three hear how it went', one === two && two === three);
}

{
  const world = fakeWorld({ loaded: ['a'] });
  const guard = V.createVramGuard({ VRAM_EXCLUSIVE: 'false' }, { fetchImpl: world.fetchImpl });
  eq('switched off, nothing is touched', await guard.releaseLlm(), []);
  eq('not even asked about', world.calls.length, 0);
}

/* ------------------------------------------ before a chat: ComfyUI lets go */

{
  const world = fakeWorld();
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  await guard.beforeInference();
  eq('cached models from before a restart are freed', hits(world.calls, '/free').length, 1);
}

{
  const world = fakeWorld();
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  check('after one of our jobs, it is freed', await guard.beforeInference() === 'freed');
  eq('asked to unload, not just to tidy', hits(world.calls, '/free')[0]?.body,
    { unload_models: true, free_memory: true });
  check('and measured, because Ollama sizes its share from what is free', hits(world.calls, '/system_stats').length >= 2);

  world.calls.length = 0;
  await guard.beforeInference();
  eq('an empty card is checked without another unload', hits(world.calls, '/free').length, 0);
}

/* ------------------------------ a floor `/free` cannot get below

   Reported as: every chat after any picture answered

     Ollama returned HTTP 502: ComfyUI did not release GPU memory;
     chat was not started.

   on a card that was almost entirely empty. `/free` returns 200, unloads what
   it can, and leaves `torch_vram_total` at exactly 0.600 GB -- a CUDA context
   and whatever a custom node pins -- while the card reports 15.1 of 17.1 GB
   free. Asked again a second later it is still 0.600 GB, because there is
   nothing left to release.

   Against a fixed 512 MB line that install can never succeed. The line is now
   also a share of the card, because what the caller needs to know is whether
   ComfyUI is in the language model's way, and six hundred megabytes of a
   seventeen gigabyte card is not in anybody's way. */
{
  const HELD = 600 * 1000 * 1000;          // what this machine sits at
  const CARD = 17.09 * 1000 * 1000 * 1000;
  const world = fakeWorld({ comfyHeld: HELD, comfyFloor: HELD, cardTotal: CARD });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();

  check('a floor ComfyUI cannot go below does not refuse the chat',
    await guard.beforeInference() === 'freed');
  check('and it was asked to let go first', hits(world.calls, '/free').length === 1);
  /* Without this it polls for the whole five seconds before failing, so the
     refusal also cost five seconds of the reader's time. */
  check('it stops asking once the number has stopped moving',
    hits(world.calls, '/system_stats').length <= 6,
    String(hits(world.calls, '/system_stats').length));
}

{
  // The other side of the same line: this really is a model, and loading on
  // top of it is how both end up half on the CPU.
  const CARD = 17.09 * 1000 * 1000 * 1000;
  const world = fakeWorld({ comfyHeld: 8 * GIB, comfyFloor: 8 * GIB, cardTotal: CARD });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  let thrown = null;
  try { await guard.beforeInference(); } catch (e) { thrown = e; }
  check('a card ComfyUI is genuinely sitting on still refuses', thrown !== null);
  // The old message named neither number, so an install stuck at a floor
  // looked exactly like one that was genuinely busy.
  check('and the refusal says how much of what', /8\.00 GB of a 15\.\d\d GB card/.test(thrown?.message || ''),
    thrown?.message);
}

{
  const world = fakeWorld({ comfyQueue: { running: ['drawing'], pending: [] } });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  check('a picture being drawn is not pulled out from under itself', await guard.beforeInference() === 'drawing');
  eq('no free is sent', hits(world.calls, '/free').length, 0);

  world.calls.length = 0;
  await guard.beforeInference();
  check('and it is tried again on the next request', hits(world.calls, '/queue').length === 1);
}

{
  const world = fakeWorld({ down: [COMFY] });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  check('a ComfyUI that has gone away does not hold up the chat', await guard.beforeInference() === 'idle');
  world.calls.length = 0;
  await guard.beforeInference();
  eq('the next question checks whether ComfyUI restarted', hits(world.calls, '/queue').length, 1);
}

/* ------------------------------ while a video is drawn: the chat on the CPU

   Reported as: the chat model sits on the card while a video renders, and the
   video is slow. Every question, title and summary asked meanwhile loaded it
   back onto the card the video was drawing on. */

eq('an Ollama request is sent with no layers on the card, and not kept',
  JSON.parse(V.offTheCard(JSON.stringify({ model: 'm', options: { temperature: 0.2 } }))),
  { model: 'm', options: { temperature: 0.2, num_gpu: 0 }, keep_alive: 0 });
check('a num_gpu somebody set is overridden', JSON.parse(V.offTheCard('{"options":{"num_gpu":99}}')).options.num_gpu === 0);
eq('anything that is not an object is left alone', [V.offTheCard('nope'), V.offTheCard('[1]'), V.offTheCard('null')], [null, null, null]);

{
  const http = await import('node:http');
  const realFetch = globalThis.fetch;
  // A paper Ollama that listens, so what reaches it can be read.
  const received = [];
  const ollama = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body), declared: Number(req.headers['content-length']), bytes: Buffer.byteLength(body) });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end('{"message":{"content":"안녕"},"done":true}\n');
    });
  });
  await new Promise(r => ollama.listen(0, '127.0.0.1', r));
  const env = { OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}` };
  const hook = V.inferenceHook(env);
  const app = http.createServer((req, res) => hook(req, res, () => { res.writeHead(200); res.end('passed on'); }));
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const ask = (body, headers = {}) => realFetch(`http://127.0.0.1:${app.address().port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }).then(r => r.text());

  const queue = { running: [], pending: [] };
  const world = fakeWorld({ comfyQueue: queue });
  globalThis.fetch = world.fetchImpl;
  try {
    check('with no job of ours, Ollama answers', (await ask({ model: 'm', options: { num_ctx: 4096 } })).includes('안녕'));
    eq('and the request reaches it untouched', received[0]?.body, { model: 'm', options: { num_ctx: 4096 } });
    received.length = 0;

    const durableBody = { model: 'm', keep_alive: '5m', options: { num_ctx: 4096, num_gpu: 20 } };
    check('a durable chat answers while ComfyUI is idle', (await ask(durableBody, { 'X-Chat-Job-Id': 'vram-idle-regression' })).includes('안녕'));
    eq('a job ID preserves GPU and keep-alive options', received[0]?.body, durableBody);
    received.length = 0;
    world.calls.length = 0;
    V.vramGuard(env).comfyUsed();
    queue.running.push('video');
    const answer = await ask({ model: 'gemma3:12b', messages: [{ role: 'user', content: '영상 어때?' }], options: { num_ctx: 8192 } });
    check('chat is refused while ComfyUI is drawing', answer.includes('ComfyUI is generating'), answer);
    eq('no CPU model is loaded alongside the video', received.length, 0);
    eq('and ComfyUI is not freed under it', hits(world.calls, '/free').length, 0);

    queue.running.length = 0;
    await ask({ model: 'm' });
    eq('once the video is done, ComfyUI is freed', hits(world.calls, '/free').length, 1);
    eq('and the request goes on as it was, so the model loads onto the card again', received[0]?.body, { model: 'm' });
  } finally {
    globalThis.fetch = realFetch;
    app.close();
    ollama.close();
  }
}

{
  const world = fakeWorld({ comfyQueue: { running: ['video'], pending: [] } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = world.fetchImpl;
  try {
    const env = { LLM_BACKEND: 'llamacpp', LLAMACPP_URL: 'http://127.0.0.1:8081' };
    V.vramGuard(env).comfyUsed();
    let passed = false;
    let status = 0;
    await V.inferenceHook(env)({ method: 'POST', url: '/api/chat' }, { writeHead(code) { status = code; }, end() {} }, () => { passed = true; });
    check('llama.cpp is also refused while ComfyUI is drawing', !passed && status === 503);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ------------------------ a model still answering is stopped, not waited out

   Reported as: a picture failed with "Input type (CUDABFloat16Type) and weight
   type (CPUBFloat16Type) should be the same". gemma4:31b was still answering a
   title or summary when the picture was asked for; Ollama unloads a model only
   once nothing is using it, so it stayed on the card for the whole fifteen
   seconds the unload was given, and the picture started with 0.7GB free. Every
   model was offloaded, and the PiD upscaler crashed on the half it had. */

check('a model answering from the CPU is not in the way',
  JSON.stringify(V.loadedOllama({ models: [{ name: 'on-card', size_vram: 8 * GIB }, { name: 'on-cpu', size_vram: 0 }, { name: 'old-ollama' }] }))
    === JSON.stringify(['on-card', 'old-ollama']));

{
  // An Ollama that will not unload a model while a request is using it.
  const state = { loaded: ['gemma4:31b'], busy: 0, unloadAsked: false };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (url.endsWith('/api/ps')) return json({ models: state.loaded.map(name => ({ name, size_vram: 8 * GIB })) });
    if (url.endsWith('/api/generate') && body?.keep_alive === 0) {
      state.unloadAsked = true;
      if (!state.busy) state.loaded = [];
      return json({ done: true });
    }
    return json({});
  };
  const guard = V.createVramGuard({}, { fetchImpl, grace: 400, patience: 2000 });
  let stoppedCount = 0;
  const hold = () => {
    state.busy += 1;
    const done = guard.track(() => {
      stoppedCount += 1;
      state.busy -= 1;
      done();
      if (!state.busy && state.unloadAsked) state.loaded = [];
    });
  };
  hold(); hold();
  const began = Date.now();
  const unloaded = await guard.releaseLlm();
  eq('a model still answering is unloaded anyway', [unloaded, state.loaded], [['gemma4:31b'], []]);
  eq('by stopping what was holding it', stoppedCount, 2);
  check('after the grace, not after the whole wait', Date.now() - began < 1800, `${Date.now() - began}ms`);

  stoppedCount = 0;
  state.loaded = ['gemma4:31b'];
  state.unloadAsked = false;
  await guard.releaseLlm();
  eq('with nothing under way, nothing is stopped', stoppedCount, 0);
}

{
  const http = await import('node:http');
  const realFetch = globalThis.fetch;
  // A paper Ollama that takes its time over an answer, as a 31B model does.
  let upstreamClosed = false;
  const ollama = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write('{"message":{"content":"One,"},"done":false}\n');
    // The response, not the request: a request "closes" once its body is read.
    // Like Ollama, an unload asked for while it is busy happens once it is not.
    res.on('close', () => { upstreamClosed = true; if (unloadAsked) loaded = []; });
  });
  await new Promise(r => ollama.listen(0, '127.0.0.1', r));
  const env = { OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, COMFYUI_PORT: '18188' };
  let loaded = ['gemma4:31b'];
  let unloadAsked = false;
  const world = {
    fetchImpl: async (url, options = {}) => {
      const json = (value) => ({ ok: true, status: 200, json: async () => value });
      if (String(url).endsWith('/system_stats')) return json({ devices: [{ torch_vram_total: 0 }] });
      if (String(url).endsWith('/api/ps')) return json({ models: loaded.map(name => ({ name })) });
      if (String(url).endsWith('/api/generate')) { unloadAsked = true; if (upstreamClosed) loaded = []; return json({}); }
      return json({});
    },
  };
  const hook = V.inferenceHook(env, { fetchImpl: world.fetchImpl, grace: 300, patience: 1500 });
  const app = http.createServer((req, res) => hook(req, res, () => { res.end('passed on'); }));
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  try {
    const answering = realFetch(`http://127.0.0.1:${app.address().port}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gemma4:31b', stream: true }),
    });
    const res = await answering;
    const reading = res.text();
    await new Promise(r => setTimeout(r, 100));
    await V.vramGuard(env).releaseLlm();
    await reading;
    check('a request through this server is stopped when the card is needed', upstreamClosed);
    eq('and the model it was holding comes off', loaded, []);
  } finally {
    globalThis.fetch = realFetch;
    app.close();
    ollama.close();
  }
}

check('one guard per set of addresses, shared by everything that asks',
  V.vramGuard({ OLLAMA_URL: 'x' }) === V.vramGuard({ OLLAMA_URL: 'x' })
  && V.vramGuard({ OLLAMA_URL: 'x' }) !== V.vramGuard({ OLLAMA_URL: 'y' }));

/* ---------------------------------------------------- through the Studio

   The whole order, as the server does it for a picture asked for in a chat:
   the chat model off, then the job queued. */

{
  const world = fakeWorld({ loaded: ['gemma3:27b'] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = world.fetchImpl;
  try {
    const routes = S.createStudioRoutes({ OLLAMA_URL: 'http://127.0.0.1:11434/' });
    const handler = routes.find(r => r.path === '/studio/generate').handler;
    const req = Readable.from([JSON.stringify({ model: 'krea2-turbo', prompt: 'a lighthouse', requestId: 'vram-1' })]);
    req.url = '/studio/generate';
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    let payload = null;
    const res = { statusCode: 200, setHeader() {}, end(text) { payload = JSON.parse(text); } };
    await handler(req, res);

    const order = world.calls.map(c => c.url);
    const unloadAt = order.findIndex(u => u.endsWith('/api/generate'));
    const queueAt = order.findIndex(u => u.endsWith('/prompt'));
    check('the job is accepted', payload?.success === true, JSON.stringify(payload));
    check('the chat model is unloaded before the picture is queued',
      unloadAt !== -1 && queueAt !== -1 && unloadAt < queueAt, JSON.stringify(order));
    eq('and the browser is told which', payload?.unloaded, ['gemma3:27b']);

    const guard = V.vramGuard({ OLLAMA_URL: 'http://127.0.0.1:11434/' });
    world.calls.length = 0;
    await guard.beforeInference();
    check('the next chat request frees ComfyUI first', hits(world.calls, '/free').length === 1);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ----------------------------------------------------------- the wiring */

const vite = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
const index = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
check('the dev server runs the inference hook before an inference request',
  /isInference\([\s\S]{0,80}\)\) return next\(\);\s*\n\s*inference\(req, res, next\);/.test(vite));
check('ahead of the API routes, so llama.cpp\'s are covered too',
  vite.indexOf('inference(req, res, next)') < vite.indexOf('createApiRoutes(env)'));
check('and so does the production server',
  /if \(isInference\(url\.pathname\)\) \{\s*\n\s*inference\(req, res, \(\) => dispatch\(req, res, url\)\);/.test(index));
check('.env.example documents the switch',
  /^VRAM_EXCLUSIVE=true$/m.test(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')));

/* Reported: Ollama logged `500 | 2m0s | POST /api/chat` with the model 427
   tokens into its answer. The proxy gave up on two minutes of silence -- a
   cold load, a long prompt, and a tool call Ollama holds back until it is
   complete are each most of that -- and the browser sent it all again. */
{
  const vramSource = fs.readFileSync(path.join(ROOT, 'server/vram.js'), 'utf8');
  check('Ollama generation has no default silence deadline',
    /export const OLLAMA_IDLE_MS = 0;/.test(vramSource)
    && /out\.setTimeout\(idleMs,/.test(vramSource)
    && !/out\.setTimeout\(120000/.test(vramSource));
  check('  and .env can say otherwise', /env\.OLLAMA_IDLE_TIMEOUT_MS/.test(vramSource));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
