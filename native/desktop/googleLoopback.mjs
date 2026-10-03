/*
 * Google sign-in straight to the account chooser.
 *
 * Google sends a plain-HTTP redirect only to loopback, so for the few minutes a
 * sign-in takes the app listens on 127.0.0.1:47615 (the one redirect URI
 * registered in the Google console, server/nativeGoogleDirect.js). The system
 * browser opens Google itself; Google returns the ID token in the URL fragment
 * to this listener's page, which hands it here, and the app passes it on to the
 * server's existing /api/auth/native/finish, where it is verified (audience,
 * nonce = the handoff id). The app's page, polling as before, then signs in.
 */
import http from 'node:http';

export const GOOGLE_LOOPBACK_PORT = 47615;
export const GOOGLE_LOOPBACK_ORIGIN = 'http://127.0.0.1:' + GOOGLE_LOOPBACK_PORT;
export const GOOGLE_LOOPBACK_REDIRECT = GOOGLE_LOOPBACK_ORIGIN + '/api/auth/native/google/callback';
const CALLBACK = '/api/auth/native/google/callback';

const CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
/** `#google:<handoff id>:<client id>` from the page, or null. */
export function parseGoogleHandoff(hash) {
  const m = /^#google:([a-f0-9]{64}):(.+)$/.exec(String(hash || ''));
  return m && CLIENT_ID.test(m[2]) ? { id: m[1], clientId: m[2] } : null;
}
export function googleAuthorizeUrl({ clientId, id }) {
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({ client_id: clientId, redirect_uri: GOOGLE_LOOPBACK_REDIRECT,
    response_type: 'id_token', response_mode: 'fragment', scope: 'openid email profile',
    nonce: id, state: id, prompt: 'select_account' });
  return target.href;
}

/* The same page and script are served by the Android app (GoogleLoopback.java). */
export const CALLBACK_PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Google 로그인</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1f1d1a;color:#eee9e0;font:16px system-ui,"Segoe UI","Malgun Gothic",sans-serif}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 10px}p{color:#b9ad9b;line-height:1.6;margin:0}
a{display:inline-block;margin-top:20px;padding:11px 20px;border-radius:10px;background:#dac5a5;color:#28231d;text-decoration:none;font-weight:600}</style>
<main><h1 id="title">로그인 확인 중…</h1><p id="status">잠시만 기다려 주세요.</p><a id="back" href="ollamawebui://auth" hidden>앱으로 돌아가기</a></main>
<script src="${CALLBACK}.js"></script></html>`;
export const CALLBACK_SCRIPT = `(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const title = document.getElementById('title'), status = document.getElementById('status');
  try {
    if (params.get('error')) throw new Error('로그인이 취소되었습니다. 앱에서 다시 시도하세요.');
    const response = await fetch('${CALLBACK}/finish', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: params.get('state') || '', credential: params.get('id_token') || '' }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '로그인 연결에 실패했습니다. 앱에서 다시 시도하세요.');
    title.textContent = '로그인되었습니다';
    status.textContent = result.android ? '앱으로 돌아갑니다…' : '이 탭을 닫고 앱으로 돌아가세요.';
    if (result.android) { document.getElementById('back').hidden = false; location.replace('ollamawebui://auth'); }
    else setTimeout(() => window.close(), 400);
  } catch (error) { title.textContent = '로그인하지 못했습니다'; status.textContent = error.message; }
})();`;

const headers = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'" });

let active = null;
/**
 * Listen for one sign-in. Resolves once listening; rejects when the port is
 * taken (the caller then falls back to the server's page). A new sign-in
 * replaces the previous one; it stops by itself after `ttl`.
 */
export async function startGoogleLoopback({ finishUrl, id, fetcher = fetch, onDone = () => {}, ttl = 300000, port = GOOGLE_LOOPBACK_PORT }) {
  await active?.close();
  const host = '127.0.0.1:' + port, origin = 'http://' + host;
  let finished = false;
  const send = (res, status, type, body) => { res.writeHead(status, headers(type)); res.end(body); };
  const srv = http.createServer(async (req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.headers.host !== host) return send(res, 403, 'text/plain', 'Forbidden');
    if (req.method === 'GET' && path === CALLBACK) return send(res, 200, 'text/html; charset=utf-8', CALLBACK_PAGE);
    if (req.method === 'GET' && path === CALLBACK + '.js') return send(res, 200, 'text/javascript; charset=utf-8', CALLBACK_SCRIPT);
    if (req.method !== 'POST' || path !== CALLBACK + '/finish') return send(res, 404, 'text/plain', 'Not found');
    const json = (status, value) => send(res, status, 'application/json', JSON.stringify(value));
    if (req.headers.origin !== origin || !String(req.headers['content-type'] || '').startsWith('application/json'))
      return json(403, { error: '잘못된 요청입니다.' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 16384) return json(413, { error: '요청이 너무 큽니다.' }); }
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    if (finished) return json(409, { error: '이미 처리된 로그인입니다.' });
    if (body.state !== id) return json(400, { error: '앱에서 시작한 로그인이 아닙니다. 앱에서 다시 시도하세요.' });
    if (typeof body.credential !== 'string' || !body.credential || body.credential.length > 8192)
      return json(400, { error: 'Google 인증 결과가 없습니다.' });
    try {
      // finishUrl goes through the app's own gateway and session (main.mjs), so an
      // access-token cookie the server asks for from outside the LAN comes along.
      const response = await fetcher(finishUrl, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, credential: body.credential }),
        signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        return json(400, { error: '서버가 로그인을 거부했습니다' + (detail.error ? ': ' + detail.error : '.') + ' 앱에서 다시 시도하세요.' });
      }
    } catch { return json(502, { error: '서버에 연결하지 못했습니다. 앱에서 다시 시도하세요.' }); }
    finished = true;
    json(200, { ok: true });
    try { onDone(); } catch {}
    setTimeout(() => handle.close(), 2000);
  });
  await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', resolve); });
  const timer = setTimeout(() => handle.close(), ttl);
  timer.unref?.();
  const handle = {
    close: () => new Promise(resolve => {
      clearTimeout(timer);
      if (active === handle) active = null;
      srv.closeAllConnections?.();
      srv.close(() => resolve());
    }),
  };
  active = handle;
  return handle;
}
