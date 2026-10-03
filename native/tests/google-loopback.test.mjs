import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import {
  parseGoogleHandoff, googleAuthorizeUrl, startGoogleLoopback, CALLBACK_PAGE, CALLBACK_SCRIPT,
  GOOGLE_LOOPBACK_REDIRECT,
} from '../desktop/googleLoopback.mjs';
import { GOOGLE_LOOPBACK_REDIRECT as SERVER_REDIRECT } from '../../server/nativeGoogleDirect.js';
import { GOOGLE_LOOPBACK_REDIRECT as GUIDE_REDIRECT } from '../../server/socialSetup.mjs';

const id = 'a'.repeat(64);
const clientId = '123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com';

test('app, server and setup guide agree on the one redirect URI', () => {
  assert.equal(GOOGLE_LOOPBACK_REDIRECT, 'http://127.0.0.1:47615/api/auth/native/google/callback');
  assert.equal(SERVER_REDIRECT, GOOGLE_LOOPBACK_REDIRECT);
  assert.equal(GUIDE_REDIRECT, GOOGLE_LOOPBACK_REDIRECT);
});

test('handoff fragment is parsed strictly', () => {
  assert.deepEqual(parseGoogleHandoff('#google:' + id + ':' + clientId), { id, clientId });
  for (const bad of ['#' + id, '#google:' + id, '#google:zz:' + clientId, '#google:' + id + ':evil.example',
    '#google:' + id + ':' + clientId + '&x=1', '#kakao:' + id])
    assert.equal(parseGoogleHandoff(bad), null, bad);
});

test('authorize URL goes straight to Google with nonce and state bound to the handoff', () => {
  const u = new URL(googleAuthorizeUrl({ id, clientId }));
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('redirect_uri'), GOOGLE_LOOPBACK_REDIRECT);
  assert.equal(u.searchParams.get('response_type'), 'id_token');
  assert.equal(u.searchParams.get('nonce'), id);
  assert.equal(u.searchParams.get('state'), id);
  assert.equal(u.searchParams.get('prompt'), 'select_account');
});

async function serverStub(t, status = 200) {
  const posts = [];
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    posts.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { success: true } : { error: 'Invalid Google token.' }));
  });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { finishUrl: `http://127.0.0.1:${srv.address().port}/api/auth/native/finish`, posts };
}
const port = 47000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}/api/auth/native/google/callback`;
const post = (body, origin = `http://127.0.0.1:${port}`) => fetch(base + '/finish', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });

test('loopback page hands the token to the server once, and refuses anything else', async (t) => {
  const stub = await serverStub(t);
  let done = 0;
  const handle = await startGoogleLoopback({ id, finishUrl: stub.finishUrl, port, onDone: () => done++ });
  t.after(() => handle.close());
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(await page.text(), CALLBACK_PAGE);
  assert.equal(await (await fetch(base + '.js')).text(), CALLBACK_SCRIPT);
  assert.equal((await fetch(`http://localhost:${port}/api/auth/native/google/callback`)).status, 403, 'other Host');
  assert.equal((await post({ state: id, credential: 'x' }, 'https://evil.example')).status, 403, 'other Origin');
  assert.equal((await post({ state: 'b'.repeat(64), credential: 'x' })).status, 400, 'other state');
  assert.equal((await post({ state: id, credential: '' })).status, 400, 'no token');
  assert.equal(stub.posts.length, 0);
  const ok = await post({ state: id, credential: 'id-token' });
  assert.equal(ok.status, 200);
  assert.deepEqual(stub.posts, [{ url: '/api/auth/native/finish', body: { id, credential: 'id-token' } }]);
  assert.equal(done, 1);
  assert.equal((await post({ state: id, credential: 'again' })).status, 409);
  assert.equal(stub.posts.length, 1);
});

test('a token the server rejects is reported, not swallowed', async (t) => {
  const stub = await serverStub(t, 400);
  const handle = await startGoogleLoopback({ id, finishUrl: stub.finishUrl, port: port + 1 });
  t.after(() => handle.close());
  const r = await fetch(`http://127.0.0.1:${port + 1}/api/auth/native/google/callback/finish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port + 1}` },
    body: JSON.stringify({ state: id, credential: 't' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Invalid Google token/);
});

test('a second sign-in replaces the first; a taken port rejects so the app can fall back', async (t) => {
  const stub = await serverStub(t);
  const first = await startGoogleLoopback({ id, finishUrl: stub.finishUrl, port: port + 2 });
  const second = await startGoogleLoopback({ id: 'c'.repeat(64), finishUrl: stub.finishUrl, port: port + 2 });
  t.after(() => second.close());
  await first.close();
  const r = await fetch(`http://127.0.0.1:${port + 2}/api/auth/native/google/callback/finish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port + 2}` },
    body: JSON.stringify({ state: id, credential: 't' }) });
  assert.equal(r.status, 400, 'the old handoff no longer counts');
  const blocker = http.createServer(); blocker.listen(port + 3, '127.0.0.1'); await once(blocker, 'listening');
  t.after(() => blocker.close());
  await assert.rejects(startGoogleLoopback({ id, finishUrl: stub.finishUrl, port: port + 3 }));
});

test('callback script posts state and token from the fragment and never on an error', async () => {
  const run = async (hash) => {
    const sent = [];
    const el = () => ({ textContent: '', hidden: true });
    const nodes = { title: el(), status: el(), back: el() };
    const context = {
      location: { hash, pathname: '/cb', replace: () => {} }, history: { replaceState: () => {} },
      document: { getElementById: (k) => nodes[k] }, URLSearchParams, JSON, setTimeout: () => {}, window: { close: () => {} },
      fetch: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true }) }; },
    };
    await vm.runInNewContext(CALLBACK_SCRIPT, context);
    await new Promise(r => setImmediate(r));
    return { sent, nodes };
  };
  const good = await run('#' + new URLSearchParams({ state: id, id_token: 'tok' }));
  assert.deepEqual(good.sent, [{ url: '/api/auth/native/google/callback/finish', body: { state: id, credential: 'tok' } }]);
  assert.equal(good.nodes.title.textContent, '로그인되었습니다');
  const denied = await run('#' + new URLSearchParams({ state: id, error: 'access_denied' }));
  assert.equal(denied.sent.length, 0);
  assert.match(denied.nodes.status.textContent, /취소/);
});
