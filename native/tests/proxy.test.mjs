import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { startProxy, normalizeServer, probeServer } from '../desktop/proxy.mjs';

/* Only the form the server hands out, <IPv4>.nip.io:<port>: "naver.com" was
   taken, opened Naver as the app, and was saved as the server. */
const ACCEPTED = [
  [' http://192.168.0.5.nip.io:5173/ ', 'http://192.168.0.5.nip.io:5173'],
  ['192.168.0.5.nip.io:5173', 'http://192.168.0.5.nip.io:5173'],
  ['192.168.0.5:5173', 'http://192.168.0.5.nip.io:5173'],
  ['HTTPS://8.8.8.8.NIP.IO:443', 'https://8.8.8.8.nip.io:443'],
];
const REJECTED = ['naver.com', 'https://naver.com', 'http://naver.com:80', 'localhost:5173', 'example.com:5173',
  '192.168.0.5', '192.168.0.5.nip.io', '256.1.1.1:5173', '1.2.3.4:0', '1.2.3.4:70000', '01.2.3.4:5173',
  '192.168.0.5.nip.io:5173/path', '192.168.0.5.nip.io:5173/?q=1', 'http://u:p@1.2.3.4.nip.io:5173', 'ftp://1.2.3.4.nip.io:21',
  'file:///secret', 'javascript:alert(1)', '1.2.3.4.evil.com:5173', 'evil.1.2.3.4.nip.io:5173'];
test('server addresses must be <IPv4>.nip.io:<port>', () => {
  for (const [given, want] of ACCEPTED) assert.equal(normalizeServer(given), want, given);
  for (const value of [...REJECTED, '']) assert.throws(() => normalizeServer(value), /nip\.io/, value);
});
const whoami = (req, res) => {
  if (req.url !== '/api/whoami') return false;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ youAppearAs: '127.0.0.1', tokenRequired: false, servingPort: 1 }));
  return true;
};
test('desktop: an address is opened only if an Ollama WebUI server answers there', async () => {
  const ours = http.createServer((req, res) => { if (!whoami(req, res)) res.end('page'); });
  const other = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html>NAVER</html>'); });
  for (const s of [ours, other]) { s.listen(0, '127.0.0.1'); await once(s, 'listening'); }
  try {
    // Resolved without DNS: the name says what the address is (nipLookup).
    assert.equal((await probeServer('http://127.0.0.1.nip.io:' + ours.address().port)).servingPort, 1);
    await assert.rejects(probeServer('http://127.0.0.1.nip.io:' + other.address().port), e => e.notServer === true);
    const spare = net.createServer(); spare.listen(0, '127.0.0.1'); await once(spare, 'listening');
    const dead = spare.address().port; await new Promise(resolve => spare.close(resolve));
    await assert.rejects(probeServer('http://127.0.0.1.nip.io:' + dead), e => !e.notServer);
  } finally { for (const s of [ours, other]) s.close(); }
});
const root = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.JAVA_HOME || path.join(root, '.tools/jdk');
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
async function javaProxy(url) {
  const out = path.join(root, 'artifacts/java-tests'); mkdirSync(out, { recursive: true });
  const result = spawnSync(javac, ['-encoding', 'UTF-8', '-d', out, path.join(root, 'android/app/src/main/java/io/github/yjw071218/ollamawebui/client/LoopbackProxy.java'), path.join(root, 'android/app/src/main/java/io/github/yjw071218/ollamawebui/client/L.java'), path.join(root, 'tests/ProxyHarness.java')], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const child = spawn(java, ['-cp', out, 'ProxyHarness', url], { stdio: ['pipe','pipe','pipe'] });
  /* A harness that dies before printing its address must fail the test, not
     wait for a line that never comes (CI sat on this for six hours). */
  const buffer = await Promise.race([
    once(child.stdout, 'data').then(([b]) => b),
    once(child, 'exit').then(([code]) => { throw new Error('ProxyHarness exited early with code ' + code); }),
    new Promise((_, reject) => setTimeout(() => { child.kill(); reject(new Error('ProxyHarness did not start in 20s')); }, 20000).unref()),
  ]);
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
test('android gateway: an unreachable server gets a page with a way out', { skip: !existsSync(javac), timeout: 30000 }, async () => {
  const spare = net.createServer(); spare.listen(0, '127.0.0.1'); await once(spare, 'listening');
  const dead = 'http://127.0.0.1:' + spare.address().port; await new Promise(resolve => spare.close(resolve));
  const gateway = await javaProxy(dead);
  try {
    const auth = { cookie: '__ollama_native_gate=' + gateway.token };
    const page = await request(gateway.origin + '/', { ...auth, accept: 'text/html', 'sec-fetch-dest': 'document' });
    assert.equal(page.status, 502);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /다시 시도/); assert.match(page.body, /서버 변경/);
    assert.doesNotMatch(page.body, /상단 새로고침/);
    const api = await request(gateway.origin + '/api/x', auth);
    assert.equal(JSON.parse(api.body).code, 'offline');
  } finally { await gateway.close(); }
});
for (const kind of ['desktop', 'android']) test(kind + ' gateway integration', { skip: kind === 'android' && !existsSync(javac), timeout: 30000 }, async t => {
  const served = new WeakMap();
  const backend = http.createServer(async (req, res) => {
    const before = served.get(req.socket) || 0; served.set(req.socket, before + 1);
    // A kept connection the server has just given up on: the request gets no answer.
    if (req.url === '/flaky' && before > 0) { req.socket.destroy(); return; }
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
  const target = 'http://127.0.0.1.nip.io:' + backend.address().port;
  const closeBackend = async () => { for (const socket of backendSockets) socket.destroy(); await new Promise(resolve => backend.close(resolve)); };
  let gateway;
  // If the gateway cannot start, the backend still closes; a listening server kept the run alive for hours.
  try { gateway = await (kind === 'desktop' ? startProxy : javaProxy)(target); }
  catch (error) { await closeBackend(); throw error; }
  const auth = kind === 'desktop' ? { 'x-native-gateway': gateway.token } : { cookie: '__ollama_native_gate=' + gateway.token + '; session=abc' };
  t.after(async () => { await gateway.close(); await closeBackend(); });
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
  await t.test('keeps the server connection between requests, including chunked uploads', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    let connections = 0;
    const count = () => { connections++; };
    backend.on('connection', count);
    try {
      const send = (pathname, body = null, headers = {}) => new Promise((resolve, reject) => {
        const req = http.request(gateway.origin + pathname, { agent, method: body === null ? 'GET' : 'POST', headers: { ...auth, ...headers } }, res => {
          const chunks = []; res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        if (body !== null && headers['transfer-encoding']) { req.write(body.subarray(0, 10)); req.end(body.subarray(10)); }
        else req.end(body);
      });
      for (let i = 0; i < 3; i++) assert.equal((await send('/n' + i)).status, 200);
      assert.equal(JSON.parse((await send('/up', Buffer.alloc(70000, 1), { 'transfer-encoding': 'chunked' })).body).length, 70000);
      const stream = await send('/stream');
      assert.match(stream.body, /first[\s\S]*last/);
      assert.equal(JSON.parse((await send('/after')).body).url, '/after');
      // One at most: a connection kept from the requests above may be handed on.
      assert.ok(connections <= 1, 'server connections opened: ' + connections);
      // The server closed the kept connection as it was reused: a GET is sent again on a new one.
      const flaky = await send('/flaky');
      assert.equal(flaky.status, 200);
      assert.equal(JSON.parse(flaky.body).url, '/flaky');
    } finally { backend.off('connection', count); agent.destroy(); }
  });
  if (kind === 'android') await t.test('takes only <IPv4>.nip.io:<port>, as the desktop does, and asks the server', async () => {
    const out = path.join(root, 'artifacts/java-tests');
    const probe = path.join(out, 'NormalizeProbe.java');
    const P = 'io.github.yjw071218.ollamawebui.client.LoopbackProxy';
    (await import('node:fs')).writeFileSync(probe, 'public class NormalizeProbe { public static void main(String[] a) throws Exception {'
      + ' if (a[0].equals("probe")) { try { ' + P + '.probe(a[1]); System.out.println("server"); }'
      + ' catch (' + P + '.NotServerException e) { System.out.println("not-server"); } catch (java.io.IOException e) { System.out.println("unreachable"); } return; }'
      + ' for (String s : a) { try { System.out.println(' + P + '.normalize(s)); } catch (IllegalArgumentException e) { System.out.println("REJECTED"); } } } }');
    assert.equal(spawnSync(javac, ['-encoding', 'UTF-8', '-cp', out, '-d', out, probe]).status, 0);
    const run = spawnSync(java, ['-cp', out, 'NormalizeProbe', ...ACCEPTED.map(([given]) => given), ...REJECTED], { encoding: 'utf8' });
    assert.deepEqual(run.stdout.trim().split(/\r?\n/), [...ACCEPTED.map(([, want]) => want), ...REJECTED.map(() => 'REJECTED')]);
    const ours = http.createServer((req, res) => { if (!whoami(req, res)) res.end('page'); });
    const other = http.createServer((_req, res) => { res.end('<html>NAVER</html>'); });
    for (const s of [ours, other]) { s.listen(0, '127.0.0.1'); await once(s, 'listening'); }
    try {
      const ask = async port => {
        const child = spawn(java, ['-cp', out, 'NormalizeProbe', 'probe', 'http://127.0.0.1.nip.io:' + port]);
        let text = ''; child.stdout.on('data', c => { text += c; });
        await once(child, 'exit');
        return text.trim();
      };
      assert.equal(await ask(ours.address().port), 'server');
      assert.equal(await ask(other.address().port), 'not-server');
    } finally { for (const s of [ours, other]) s.close(); }
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
