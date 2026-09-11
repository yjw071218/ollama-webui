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
const fakeWorld = ({ loaded = [], comfyQueue = { running: [], pending: [] }, comfyHeld = 8 * GIB, down = [] } = {}) => {
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
    if (url === `${COMFY}/free`) { state.comfyHeld = 256 * 1024 * 1024; return json({}); }
    if (url === `${COMFY}/system_stats`) return json({ devices: [{ torch_vram_total: state.comfyHeld }] });
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
  eq('a ComfyUI we never used is left alone', world.calls.length, 0);
}

{
  const world = fakeWorld();
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  check('after one of our jobs, it is freed', await guard.beforeInference() === true);
  eq('asked to unload, not just to tidy', hits(world.calls, '/free')[0]?.body,
    { unload_models: true, free_memory: true });
  check('and measured, because Ollama sizes its share from what is free', hits(world.calls, '/system_stats').length >= 2);

  world.calls.length = 0;
  await guard.beforeInference();
  eq('the next question costs nothing', world.calls.length, 0);
}

{
  const world = fakeWorld({ comfyQueue: { running: ['drawing'], pending: [] } });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  check('a picture being drawn is not pulled out from under itself', await guard.beforeInference() === false);
  eq('no free is sent', hits(world.calls, '/free').length, 0);

  world.calls.length = 0;
  await guard.beforeInference();
  check('and it is tried again on the next request', hits(world.calls, '/queue').length === 1);
}

{
  const world = fakeWorld({ down: [COMFY] });
  const guard = V.createVramGuard({}, { fetchImpl: world.fetchImpl });
  guard.comfyUsed();
  check('a ComfyUI that has gone away does not hold up the chat', await guard.beforeInference() === false);
  world.calls.length = 0;
  await guard.beforeInference();
  eq('nor keep being asked', world.calls.length, 0);
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
check('the dev server waits for ComfyUI before an inference request',
  /isInference\([\s\S]{0,80}\)\) return next\(\);\s*\n\s*vram\.beforeInference\(\)/.test(vite));
check('ahead of the API routes, so llama.cpp\'s are covered too',
  vite.indexOf('vram.beforeInference') < vite.indexOf('createApiRoutes(env)'));
check('and so does the production server',
  /if \(isInference\(url\.pathname\)\) \{\s*\n\s*vram\.beforeInference\(\)[\s\S]{0,80}dispatch\(req, res, url\)/.test(index));
check('.env.example documents the switch',
  /^VRAM_EXCLUSIVE=true$/m.test(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
