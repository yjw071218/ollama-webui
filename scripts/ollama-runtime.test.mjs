import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ensureManagedOllama } from '../server/ollamaRuntime.js';

const env = { OLLAMA_MANAGED: 'true', OLLAMA_URL: 'http://127.0.0.1:11435' };
test('disabled runtime does not probe or start a process', async () => {
  await ensureManagedOllama({}, { fetchImpl: () => assert.fail(), spawnImpl: () => assert.fail() });
});
test('remote and desktop-app endpoints cannot be managed', async () => {
  await assert.rejects(ensureManagedOllama({ OLLAMA_MANAGED: 'true' }), /explicit/);
  for (const url of ['http://example.com:11435', 'http://127.0.0.1:11434', 'http://127.0.0.1:11435/path']) {
    await assert.rejects(ensureManagedOllama({ ...env, OLLAMA_URL: url }), /dedicated/);
  }
});
test('existing server is reused without spawning', async () => {
  await ensureManagedOllama(env, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'test' }) }),
    spawnImpl: () => assert.fail(),
  });
});
test('cold start passes tuning only to the private child', async () => {
  let spawned = false;
  const before = process.env.LLAMA_ARG_FIT_TARGET;
  await ensureManagedOllama(env, {
    fetchImpl: async () => ({ ok: spawned, json: async () => ({ version: 'test' }) }),
    spawnImpl: (binary, args, options) => {
      assert.deepEqual(args, ['serve']);
      assert.equal(options.env.OLLAMA_HOST, '127.0.0.1:11435');
      assert.equal(options.env.LLAMA_ARG_FIT_TARGET, '2048,768');
      assert.equal(options.env.OLLAMA_KV_CACHE_TYPE, 'q8_0');
      assert.equal(options.windowsHide, true);
      spawned = true;
      const child = new EventEmitter(); child.unref = () => {}; return child;
    },
  });
  assert.equal(process.env.LLAMA_ARG_FIT_TARGET, before);
});
test('spawn failure surfaces rather than silently waiting', async () => {
  await assert.rejects(ensureManagedOllama(env, {
    fetchImpl: async () => ({ ok: false }),
    spawnImpl: () => {
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit('error', new Error('missing Ollama')));
      return child;
    },
  }), /missing Ollama/);
});
