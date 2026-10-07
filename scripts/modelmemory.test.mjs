// Language models making room for each other (server/modelMemory.js), and
// the one retry after Ollama refuses a load for lack of memory.
import http from 'node:http';
import {
  planUnload, isOutOfMemory, requestedModel, createModelMemory, BIG_MODEL_BYTES,
} from '../server/modelMemory.js';
import { inferenceHook } from '../server/vram.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const GB = 1024 ** 3;

// ---------------------------------------------------------------- the plan
eq('a resident model needs nothing unloaded',
  planUnload({ requested: 'qwen3:14b', resident: [{ name: 'qwen3:14b', size: 9 * GB }], size: 9 * GB, freeRam: 1 }), []);
eq('":latest" names the same model',
  planUnload({ requested: 'llama3', resident: [{ name: 'llama3:latest', size: 5 * GB }], size: 5 * GB, freeRam: 1 }), []);
eq('a large model coming in pushes out the other large idle one, not the embedder',
  planUnload({
    requested: 'gemma3:27b',
    resident: [{ name: 'qwen3:14b', size: 9 * GB }, { name: 'nomic-embed-text', size: 0.3 * GB }],
    size: 17 * GB, freeRam: 64 * GB,
  }), ['qwen3:14b']);
eq('a model answering something is never unloaded',
  planUnload({
    requested: 'gemma3:27b', resident: [{ name: 'qwen3:14b', size: 9 * GB }],
    busy: ['qwen3:14b'], size: 17 * GB, freeRam: 1,
  }), []);
eq('a small model with plenty of RAM disturbs nothing',
  planUnload({
    requested: 'qwen3:0.6b', resident: [{ name: 'qwen3:14b', size: 9 * GB }],
    size: 0.5 * GB, freeRam: 32 * GB,
  }), []);
eq('short of RAM, idle models go largest first until it fits',
  planUnload({
    requested: 'qwen3:0.6b',
    resident: [{ name: 'a', size: 1 * GB }, { name: 'b', size: 1.2 * GB }],
    size: 0.5 * GB, freeRam: 1.5 * GB,
  }), ['b']);
eq('the retry takes every idle model',
  planUnload({
    requested: 'x', all: true,
    resident: [{ name: 'x', size: 1 * GB }, { name: 'y', size: 2 * GB }, { name: 'z', size: 3 * GB }],
    busy: ['y'],
  }), ['z']);
check('the large-model line sits between embedders and chat models', BIG_MODEL_BYTES > 0.5 * GB && BIG_MODEL_BYTES < 3 * GB);

// ------------------------------------------------------------- recognising
check('Ollama\'s system-memory refusal is an out-of-memory error',
  isOutOfMemory('{"error":"model requires more system memory (12.3 GiB) than is available (8.1 GiB)"}'));
check('so is a CUDA allocation failure', isOutOfMemory('CUDA error: out of memory'));
check('an ordinary error is not', !isOutOfMemory('{"error":"model \\"nope\\" not found, try pulling it first"}'));
eq('the model is read from the request body', requestedModel(Buffer.from('{"model":"qwen3:14b","messages":[]}')), 'qwen3:14b');
eq('and a body that is not JSON names none', requestedModel('nope'), '');

// ------------------------------------------------------- against paper Ollama
const fakeOllama = ({ resident, tags }) => {
  const calls = [];
  const state = { resident: [...resident] };
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    const json = (value) => ({ ok: true, status: 200, json: async () => value });
    if (String(url).endsWith('/api/ps')) return json({ models: state.resident });
    if (String(url).endsWith('/api/tags')) return json({ models: tags });
    if (String(url).endsWith('/api/generate') && body?.keep_alive === 0) {
      state.resident = state.resident.filter(m => m.name !== body.model);
      return json({ done: true });
    }
    return json({});
  };
  return { calls, state, fetchImpl };
};

{
  const world = fakeOllama({
    resident: [{ name: 'qwen3:14b', size: 9 * GB }],
    tags: [{ name: 'qwen3:14b', size: 9 * GB }, { name: 'gemma3:27b', size: 17 * GB }],
  });
  const memory = createModelMemory({}, { fetchImpl: world.fetchImpl, freemem: () => 64 * GB, log: () => {} });
  eq('switching chat models unloads the idle one first', await memory.makeRoom('gemma3:27b'), ['qwen3:14b']);
  check('and it is gone', world.state.resident.length === 0);

  const again = fakeOllama({ resident: [{ name: 'qwen3:14b', size: 9 * GB }], tags: [{ name: 'gemma3:27b', size: 17 * GB }] });
  const held = createModelMemory({}, { fetchImpl: again.fetchImpl, freemem: () => 1, log: () => {} });
  const done = held.hold('qwen3:14b');
  eq('a model in use stays, however short memory is', await held.makeRoom('gemma3:27b'), []);
  done();
  eq('and goes once its request has ended', await held.makeRoom('gemma3:27b'), ['qwen3:14b']);

  const off = createModelMemory({ SMART_MODEL_MEMORY: 'false' }, { fetchImpl: world.fetchImpl, log: () => {} });
  eq('SMART_MODEL_MEMORY=false turns it off', await off.makeRoom('gemma3:27b'), []);
}

// ---------------------------------------------- the retry, through the proxy
{
  let attempts = 0;
  let unloaded = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/ps') { res.end(JSON.stringify({ models: unloaded.length ? [] : [{ name: 'other:7b', size: 5 * GB }] })); return; }
      if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [] })); return; }
      const parsed = JSON.parse(body || '{}');
      if (req.url === '/api/generate' && parsed.keep_alive === 0) { unloaded.push(parsed.model); res.end('{}'); return; }
      if (req.url === '/api/chat') {
        attempts++;
        if (!unloaded.length) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'model requires more system memory (12 GiB) than is available (6 GiB)' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(`${JSON.stringify({ message: { content: 'hi' }, done: true })}\n`);
        return;
      }
      res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const env = { OLLAMA_URL: base, VRAM_EXCLUSIVE: 'false', COMFYUI_URL: 'http://127.0.0.1:1' };
  // `connection: close` throughout: a kept-alive socket still closing at exit
  // trips a libuv assertion on Windows (see scripts/origin.test.mjs).
  const closing = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), connection: 'close' } });
  const hook = inferenceHook(env, { freemem: () => 64 * GB, fetchImpl: closing });
  const front = http.createServer((req, res) => hook(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const answer = await closing(`http://127.0.0.1:${front.address().port}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'big:14b', messages: [] }),
  });
  const text = await answer.text();
  eq('an out-of-memory refusal is retried once after making room', [answer.status, attempts], [200, 2]);
  check('the reader gets the answer, not the refusal', text.includes('"hi"'), text);
  eq('and the idle model was what made the room', unloaded, ['other:7b']);
  front.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([new Promise(r => front.close(r)), new Promise(r => upstream.close(r))]);
  // The proxy's own upstream socket, kept alive by Node's default agent.
  http.globalAgent.destroy();
}

console.log(`\n${pass} passed, ${fail} failed`);
// A beat for closing sockets to finish: exiting mid-close trips a libuv assertion on Windows.
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 100);
