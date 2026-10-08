import http from 'node:http';
import { tr } from './i18n.mjs';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/*
 * The server address, and only in the form this server hands out:
 * `<IPv4>.nip.io:<port>` (server/networkSetup.mjs), as on Android
 * (LoopbackProxy.normalize).
 *
 * Any address used to be taken. "naver.com" opened Naver inside the app and was
 * saved as the server -- and a page that is not this server has no menu to
 * change the server from, so the app was stuck on it. A bare IPv4 address is
 * written the same way for you ("192.168.0.5:5173" is what people type), and
 * nothing else is accepted.
 */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const SERVER_FORM = new RegExp(`^(?:(https?)://)?(${OCTET}(?:\\.${OCTET}){3})(?:\\.nip\\.io)?:(\\d{1,5})/?$`, 'i');
export const SERVER_EXAMPLE = '192.168.0.5.nip.io:5173';
export function normalizeServer(value) {
  const m = SERVER_FORM.exec(String(value ?? '').trim());
  const port = m ? Number(m[3]) : 0;
  if (!m || port < 1 || port > 65535)
    throw new Error(tr('서버 주소는 0.0.0.0.nip.io:0000 형식으로 입력하세요. 예: ' + SERVER_EXAMPLE,
      'Enter the server address as 0.0.0.0.nip.io:0000, e.g. ' + SERVER_EXAMPLE));
  return `${(m[1] || 'http').toLowerCase()}://${m[2]}.nip.io:${port}`;
}
/** The same server as it was saved before addresses had to be nip.io ones, so its storage carries over. */
export const legacyServer = server => server.replace(/\.nip\.io(?=:\d+$)/i, '');

/*
 * Whether the address is an Ollama WebUI server at all, asked before it is
 * opened or saved. `/api/whoami` answers in front of the access-token gate
 * (server/index.js), so a server that wants a token is still recognised.
 * Rejects with `notServer` when something answered and it was not this.
 */
export async function probeServer(server, { timeoutMs = 6000 } = {}) {
  const target = new URL(server);
  const body = await new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).get(new URL('/api/whoami', target), {
      lookup: nipLookup, timeout: timeoutMs, headers: { Accept: 'application/json' },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; if (text.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', error => reject(new Error(tr('서버에 연결할 수 없습니다: ', 'The server is not answering: ') + (error.code || error.message))));
  });
  if (!body || typeof body !== 'object' || !('servingPort' in body) || !('tokenRequired' in body)) {
    const error = new Error(tr('이 주소는 Ollama WebUI 서버가 아닙니다. PC에서 서버를 켰을 때 표시되는 주소를 입력하세요.',
      'This address is not an Ollama WebUI server. Enter the address shown when the server starts on your PC.'));
    error.notServer = true;
    throw error;
  }
  return body;
}

/* `192.168.0.5.nip.io` is that address by definition, so it is answered
   here rather than by asking nip.io's DNS: a home network without internet,
   or a DNS that will not answer for private addresses, still connects. The
   name itself is what the server is sent (its PUBLIC_ORIGIN is that name). */
export function nipLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const m = new RegExp(`^(${OCTET}(?:\\.${OCTET}){3})\\.nip\\.io$`, 'i').exec(String(hostname || ''));
  if (!m) return dns.lookup(hostname, options, callback);
  if (options?.all) return process.nextTick(callback, null, [{ address: m[1], family: 4 }]);
  return process.nextTick(callback, null, m[1], 4);
}

export async function startProxy(value, port = 0) {
  const target = new URL(normalizeServer(value));
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  /* Server connections are pooled and kept between requests, whichever page
     connection asks: a request does not pay for a new TCP (and TLS) handshake.
     lifo hands out the most recently used socket, the one least likely to have
     been closed by the server's keep-alive timeout in the meantime. */
  const agent = new (target.protocol === 'https:' ? https : http).Agent({ lookup: nipLookup, keepAlive: true, keepAliveMsecs: 30000, scheduling: 'lifo', maxFreeSockets: 16 });
  let origin;
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  const authorized = req => {
    const actual = Buffer.from(String(req.headers['x-native-gateway'] || ''));
    const expected = Buffer.from(token);
    return req.headers.host === new URL(origin).host &&
      actual.length === expected.length && timingSafeEqual(actual, expected) &&
      (!req.headers.origin || req.headers.origin === origin) &&
      !['cross-site'].includes(req.headers['sec-fetch-site']) &&
      req.url.startsWith('/') && !req.url.startsWith('//');
  };
  const headersFor = req => {
    const headers = { ...req.headers, host: target.host };
    delete headers['x-native-gateway'];
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    // Never let a client impersonate a reverse proxy.
    for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-')) delete headers[key];
    delete headers.forwarded;
    if (headers.origin === origin) headers.origin = target.origin;
    if (headers.referer?.startsWith(origin + '/')) headers.referer = target.origin + headers.referer.slice(origin.length);
    return headers;
  };
  const server = http.createServer((req, res) => {
    if (!authorized(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    if (req.url === '/__native/info' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      // googleLoopback: this app can take Google's answer on 127.0.0.1:47615 (googleLoopback.mjs).
      res.end(JSON.stringify({ nativeGoogle: true, googleLoopback: 47615 })); return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const headers = headersFor(req);
    // Nothing to send but the head: safe to send again if a kept connection was already closed.
    const bodyless = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !headers['transfer-encoding'] && !(Number(headers['content-length']) > 0);
    let current;
    const send = (retried) => {
    const upstream = current = transport.request(target, {
      path: req.url, method: req.method, headers, agent, lookup: nipLookup,
    }, response => {
      const headers = { ...response.headers };
      if (headers.location) {
        try { const u = new URL(headers.location, target); if (u.origin === target.origin) headers.location = origin + u.pathname + u.search + u.hash; } catch {}
      }
      if (headers['set-cookie']) headers['set-cookie'] = headers['set-cookie'].map(cookie => cookie.replace(/;\s*Domain=[^;]*/ig, ''));
      if (headers['access-control-allow-origin'] === target.origin) headers['access-control-allow-origin'] = origin;
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.setTimeout(0); // Generation may remain silent indefinitely; cancellation still destroys the request.
    // API calls parse JSON, so they get JSON; a page gets the sentence.
    upstream.on('error', error => {
      if (!retried && bodyless && upstream.reusedSocket && !res.headersSent && !res.destroyed && ['ECONNRESET', 'EPIPE'].includes(error.code)) { send(true); return; }
      const message = '서버에 연결할 수 없습니다. 서버 주소와 실행 상태를 확인하고 새로고침하세요.';
      const api = String(req.url || '').startsWith('/api/');
      if (!res.headersSent) res.writeHead(502, { 'content-type': `${api ? 'application/json' : 'text/plain'}; charset=utf-8` });
      res.end(api ? JSON.stringify({ error: message, code: 'offline' }) : message);
    });
    res.on('close', () => upstream.destroy());
    if (bodyless) upstream.end(); else req.pipe(upstream);
    };
    send(false);
    if (bodyless) req.resume();
    req.on('aborted', () => current.destroy());
  });
  server.on('connection', track);
  server.on('upgrade', (req, client, head) => {
    if (!authorized(req) || req.headers.upgrade?.toLowerCase() !== 'websocket') { client.destroy(); return; }
    const secure = target.protocol === 'https:';
    const options = { host: target.hostname, port: Number(target.port) || (secure ? 443 : 80), lookup: nipLookup };
    client.setNoDelay(true); // Small frames go out at once instead of waiting on Nagle.
    const connected = () => {
      upstream.setNoDelay(true);
      const headers = headersFor(req);
      upstream.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' + Object.entries(headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    };
    const upstream = track(secure ? tls.connect({...options, servername: net.isIP(target.hostname) ? undefined : target.hostname}, connected) : net.connect(options, connected));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, token, port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); agent.destroy(); }) };
}
