import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { callServer } from '../../server/llamacpp.js';

test('zero deadline waits for response and caller cancellation still works', async t => {
  const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 80));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal(await (await callServer(base, '/', { timeout: 0 })).text(), 'ok');
  await assert.rejects(callServer(base, '/', { timeout: 5 }), { name: 'AbortError' });
  const controller = new AbortController();
  const pending = callServer(base, '/', { timeout: 0, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(callServer(base, '/', { timeout: 0, signal: controller.signal }), { name: 'AbortError' });
});
