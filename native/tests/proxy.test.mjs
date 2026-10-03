import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { startProxy, normalizeServer } from '../desktop/proxy.mjs';

test('server addresses are restricted to http(s) origins', () => {
  assert.equal(normalizeServer(' http://example.com:5173/ '), 'http://example.com:5173');
  for (const value of ['file:///secret', 'javascript:alert(1)', 'http://user:secret@example.com', 'https://example.com/path', 'https://example.com/?secret=1', 'https://example.com/#x']) assert.throws(() => normalizeServer(value));
});
const root = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.JAVA_HOME || path.join(root, '.tools/jdk');
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
async function javaProxy(url) {
  const out = path.join(root, 'artifacts/java-tests'); mkdirSync(out, { recursive: true });
  const result = spawnSync(javac, ['-d', out, path.join(root, 'android/app/src/main/java/io/github/yjw071218/ollamawebui/client/LoopbackProxy.java'), path.join(root, 'tests/ProxyHarness.java')], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const child = spawn(java, ['-cp', out, 'ProxyHarness', url], { stdio: ['pipe','pipe','pipe'] });
  const [buffer] = await once(child.stdout, 'data');
  const [origin, token] = buffer.toString().trim().split(' ');
  return { origin, token, close: async () => { child.stdin.end('x'); await once(child, 'exit'); } };
}
const request = (url, headers = {}, body = null) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: body === null ? 'GET' : 'POST', headers }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject); req.end(body);
});
for (const kind of ['desktop', 'android']) test(kind + ' gateway integration', { skip: kind === 'android' && !existsSync(javac), timeout: 30000 }, async t => {
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: target + '/next?q=1' }); res.end(); return; }
    if (req.url === '/cookie') { res.setHeader('set-cookie', ['session=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax']); res.end('ok'); return; }
    if (req.url === '/stream') { res.setHeader('content-type', 'text/event-stream'); res.write('data: first\n\n'); setTimeout(() => res.end('data: last\n\n'), 400); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url, headers: req.headers, length: Buffer.concat(chunks).length }));
  });
  const backendSockets = new Set();
  backend.on('connection', socket => { backendSockets.add(socket); socket.on('close', () => backendSockets.delete(socket)); });
  backend.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', bytes => socket.write(bytes));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const target = 'http://127.0.0.1:' + backend.address().port;
  const gateway = await (kind === 'desktop' ? startProxy : javaProxy)(target);
  const auth = kind === 'desktop' ? { 'x-native-gateway': gateway.token } : { cookie: '__ollama_native_gate=' + gateway.token + '; session=abc' };
  t.after(async () => { await gateway.close(); for (const socket of backendSockets) socket.destroy(); await new Promise(resolve => backend.close(resolve)); });
  await t.test('rejects unknown clients, foreign Origin, Host and cross-site fetch', async () => {
    assert.equal((await request(gateway.origin)).status, 403);
    assert.equal((await request(gateway.origin, { ...auth, origin: 'https://evil.example' })).status, 403);
    assert.equal((await request(gateway.origin, { ...auth, host: 'evil.example' })).status, 403);
    assert.equal((await request(gateway.origin, { ...auth, 'sec-fetch-site':'cross-site' })).status, 403);
  });
  await t.test('forwards uploads, path/query, auth, origin; removes local secret and spoofed forwarding headers', async () => {
    const response = await request(gateway.origin + '/api?q=%ED%95%9C', { ...auth, origin: gateway.origin, referer: gateway.origin + '/chat', authorization: 'Bearer test', 'x-forwarded-for':'evil' }, Buffer.alloc(2 * 1024 * 1024, 7));
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.length, 2 * 1024 * 1024);
    assert.equal(body.url, '/api?q=%ED%95%9C');
    assert.equal(body.headers.host, new URL(target).host);
    assert.equal(body.headers.origin, target);
    assert.equal(body.headers.referer, target + '/chat');
    assert.equal(body.headers.authorization, 'Bearer test');
    assert.equal(body.headers['x-native-gateway'], undefined);
    assert.equal(body.headers['x-forwarded-for'], undefined);
    assert.ok(!JSON.stringify(body.headers).includes(gateway.token));
  });
  await t.test('rewrites same-server redirects and cookie domains', async () => {
    assert.equal((await request(gateway.origin + '/redirect', auth)).headers.location, gateway.origin + '/next?q=1');
    const cookie = (await request(gateway.origin + '/cookie', auth)).headers['set-cookie'][0];
    assert.ok(!/domain=/i.test(cookie)); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  });
  await t.test('streams SSE before the response completes', async () => {
    const start = Date.now();
    await new Promise((resolve, reject) => {
      http.get(gateway.origin + '/stream', { headers: auth }, res => {
        let first = true, text = '';
        res.on('data', chunk => { if (first) { assert.ok(Date.now() - start < 350); first = false; } text += chunk; });
        res.on('end', () => { assert.match(text, /first/); assert.match(text, /last/); resolve(); });
      }).on('error', reject);
    });
  });
  await t.test('tunnels websocket upgrade and binary bytes', async () => {
    await new Promise((resolve, reject) => {
      const u = new URL(gateway.origin);
      const socket = net.connect(Number(u.port), '127.0.0.1');
      let upgraded = false, buffer = Buffer.alloc(0);
      socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('websocket timeout')); });
      socket.on('error', reject);
      socket.on('connect', () => socket.write('GET /ws HTTP/1.1\r\nHost: ' + u.host + '\r\nOrigin: ' + gateway.origin + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' + Object.entries(auth).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n'));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
          assert.match(buffer.toString(), /101 Switching/); buffer = buffer.subarray(end + 4);
          upgraded = true; socket.write(Buffer.from([0, 1, 255, 128, 10]));
        }
        if (upgraded && buffer.length >= 5) { assert.deepEqual(buffer, Buffer.from([0, 1, 255, 128, 10])); socket.destroy(); resolve(); }
      });
    });
  });
});
