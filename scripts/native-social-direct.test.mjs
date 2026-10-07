import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { googleNativeRedirect, nativeGoogleDirectPage, nativeGoogleCallbackPage } from '../server/nativeGoogleDirect.js';

const id = 'a'.repeat(64);
const callback = 'https://example.com/api/auth/native/google/callback';
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
function browser(hash, origin = 'https://example.com') {
  const storage = new Map(), posted = [], navigations = [], status = {};
  const context = {
    URL, URLSearchParams, Uint8Array, crypto: webcrypto, Date, JSON, AbortSignal,
    location: { hash, origin, pathname: '/api/auth/native/page', replace: url => navigations.push(url) },
    history: { replaceState() {} }, document: { getElementById: () => status },
    sessionStorage: { setItem: (k,v) => storage.set(k,v), getItem: k => storage.get(k), removeItem: k => storage.delete(k) },
    fetch: async (url, options) => { posted.push({url, ...options}); return {ok:true}; },
    window: { close() {} },
  };
  return {context, storage, posted, navigations, status};
}
test('direct Google config is opt-in, secure, and has an exact callback path', () => {
  assert.equal(googleNativeRedirect({}), '');
  assert.equal(googleNativeRedirect({GOOGLE_NATIVE_REDIRECT_URI:callback}), callback);
  for (const uri of ['http://example.com/api/auth/native/google/callback', callback+'?x=1',
    callback+'#x', 'https://user@example.com/api/auth/native/google/callback', 'https://example.com/other']) {
    assert.throws(() => googleNativeRedirect({GOOGLE_NATIVE_REDIRECT_URI:uri}));
  }
});
test('one navigation opens Google directly with nonce and independent browser state', () => {
  const b = browser('#' + id + '&app=android');
  const html = nativeGoogleDirectPage('client', callback);
  assert.ok(!html.includes('renderButton'));
  vm.runInNewContext(script(html), b.context);
  const url = new URL(b.navigations[0]);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('nonce'), id);
  assert.equal(url.searchParams.get('redirect_uri'), callback);
  assert.equal(url.searchParams.get('response_type'), 'id_token');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.notEqual(url.searchParams.get('state'), id);
  assert.equal(b.storage.size, 1);
});
test('invalid ID or mismatched origin never navigates to Google', () => {
  for (const b of [browser('#bad'), browser('#'+id, 'https://other.example')]) {
    vm.runInNewContext(script(nativeGoogleDirectPage('client', callback)), b.context);
    assert.equal(b.navigations.length, 0);
    assert.ok(b.status.textContent);
  }
});
test('callback posts token only after browser state check and cannot be replayed', async () => {
  const b = browser('#'+id);
  vm.runInNewContext(script(nativeGoogleDirectPage('client', callback)), b.context);
  const state = new URL(b.navigations[0]).searchParams.get('state');
  b.context.location.hash = '#'+new URLSearchParams({state, id_token:'verified-on-server'});
  await vm.runInNewContext(script(nativeGoogleCallbackPage()), b.context);
  assert.equal(b.posted.length, 1);
  assert.deepEqual(JSON.parse(b.posted[0].body), {id, credential:'verified-on-server'});
  await vm.runInNewContext(script(nativeGoogleCallbackPage()), b.context);
  assert.equal(b.posted.length, 1);
});
test('expired, foreign or denied callback cannot submit credentials', async () => {
  for (const kind of ['expired','foreign','denied']) {
    const b = browser('#'+id);
    vm.runInNewContext(script(nativeGoogleDirectPage('client', callback)), b.context);
    const state = new URL(b.navigations[0]).searchParams.get('state');
    if (kind === 'expired') b.storage.set('native-google:'+state, JSON.stringify({id, expires:0}));
    if (kind === 'foreign') b.storage.clear();
    b.context.location.hash = '#'+new URLSearchParams({state,id_token:'token',...(kind === 'denied' ? {error:'access_denied'} : {})});
    await vm.runInNewContext(script(nativeGoogleCallbackPage()), b.context);
    assert.equal(b.posted.length, 0);
  }
});
test('direct page config cannot terminate the inline script', () => {
  assert.ok(!nativeGoogleDirectPage('</script><script>bad()', callback).includes('</script><script>bad()'));
});

test('Kakao sign-in is gone from the client', () => {
  const source = readFileSync(new URL('../src/auth.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /signInWithKakao|kakaoRedirectUri|readKakaoOutcome/);
});
