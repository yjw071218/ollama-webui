import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function normalizeServer(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('사용자 정보가 없는 http:// 또는 https:// 주소를 입력하세요.');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('서버의 기본 주소만 입력하세요. 경로·쿼리·해시는 지원하지 않습니다.');
  return url.origin;
}
export async function startProxy(value, port = 0) {
  const target = new URL(normalizeServer(value));
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
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
      res.end(JSON.stringify({ nativeGoogle: true, nativeKakao: true, googleLoopback: 47615 })); return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(target, {
      path: req.url, method: req.method, headers: headersFor(req),
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
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, {'content-type':'text/plain; charset=utf-8'}); res.end('서버에 연결할 수 없습니다. 서버 주소와 실행 상태를 확인하고 새로고침하세요.'); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', track);
  server.on('upgrade', (req, client, head) => {
    if (!authorized(req) || req.headers.upgrade?.toLowerCase() !== 'websocket') { client.destroy(); return; }
    const secure = target.protocol === 'https:';
    const options = { host: target.hostname, port: Number(target.port) || (secure ? 443 : 80) };
    const connected = () => {
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
  return { origin, token, port: server.address().port, close: () => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }) };
}
