import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { socialGuide, registrationValues, socialLoginSetup, suggestedOrigin } from '../server/socialSetup.mjs';
import { createRedirectProbe, googleAcceptsRedirect, googleAuthorizeUrl } from '../server/nativeGoogleDirect.js';
import { readEnvValue, writeEnvValue } from '../server/envFile.js';

test('guide carries this server\'s exact values for both consoles', () => {
  const text = socialGuide({ origin: 'http://10.0.0.5.nip.io:5173', port: '5173' }).join('\n');
  for (const value of ['http://10.0.0.5.nip.io:5173', 'http://localhost:5173',
    'http://127.0.0.1:47615/api/auth/native/google/callback',
    'http://10.0.0.5.nip.io:5173/kakao/callback', 'http://localhost:5173/kakao/callback',
    'VITE_GOOGLE_CLIENT_ID', 'VITE_KAKAO_REST_KEY', 'KAKAO_CLIENT_SECRET', 'KOE006', 'KOE010', '테스트 사용자'])
    assert.ok(text.includes(value), value);
  assert.deepEqual(registrationValues({ origin: '', port: '8080' }).kakaoRedirects, ['http://localhost:8080/kakao/callback']);
});

test('the shipped doc is the generated guide', () => {
  const doc = readFileSync(new URL('../docs/SOCIAL_LOGIN.ko.md', import.meta.url), 'utf8');
  for (const line of socialGuide({ origin: 'http://<내 PC IP>.nip.io:5173' }).slice(2)) assert.ok(doc.includes(line), line);
});

test('nip.io address from a LAN interface, never loopback or link-local', () => {
  assert.equal(suggestedOrigin('5173', { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    a: [{ family: 'IPv4', internal: false, address: '169.254.1.1' }, { family: 'IPv4', internal: false, address: '192.168.0.9' }] }),
  'http://192.168.0.9.nip.io:5173');
  assert.equal(suggestedOrigin('5173', {}), '');
});

test('first-run step: validates and saves keys, writes the guide, reports', async () => {
  let env = 'PORT=5173\nPUBLIC_ORIGIN=http://10.0.0.5.nip.io:5173\n';
  const answers = ['y', 'y', 'n', 'not-a-client-id', '123456789012-abcdefghij0123456789.apps.googleusercontent.com',
    'y', 'n', 'bad key!', 'abcdef0123456789abcdef0123456789', 'secret123'];
  const asked = [], opened = [], logs = [];
  let written = '';
  const note = await socialLoginSetup({
    env: () => env, save: (k, v) => { env = writeEnvValue(env, k, v); }, readEnvValue,
    ask: async (q) => { asked.push(q); return answers.shift(); },
    yes: async (q) => { asked.push(q); return /^y/.test(answers.shift()); },
    openUrl: (u) => opened.push(u), writeGuide: (text) => { written = text; return 'C:/x/SOCIAL_LOGIN_SETUP.ko.txt'; },
    log: (l) => logs.push(l),
  });
  assert.equal(answers.length, 0);
  assert.equal(readEnvValue(env, 'VITE_GOOGLE_CLIENT_ID'), '123456789012-abcdefghij0123456789.apps.googleusercontent.com');
  assert.equal(readEnvValue(env, 'VITE_KAKAO_REST_KEY'), 'abcdef0123456789abcdef0123456789');
  assert.equal(readEnvValue(env, 'KAKAO_CLIENT_SECRET'), 'secret123');
  assert.deepEqual(opened, []);
  assert.match(written, /47615/);
  assert.ok(logs.some(l => l.includes('① https://console.cloud.google.com')), 'step-by-step Google guide printed');
  assert.ok(logs.some(l => l.includes('KOE010')), 'Kakao guide printed');
  assert.match(note, /Google·카카오 키 있음/);
});

test('first-run step sets PUBLIC_ORIGIN when missing and skips when keys exist', async () => {
  let env = 'VITE_GOOGLE_CLIENT_ID=x\nVITE_KAKAO_REST_KEY=y\n';
  const note = await socialLoginSetup({ env: () => env, save: (k, v) => { env = writeEnvValue(env, k, v); }, readEnvValue,
    ask: async () => { throw new Error('no question expected'); }, yes: async () => { throw new Error('no question expected'); },
    openUrl: () => {}, writeGuide: () => '', log: () => {} });
  assert.match(note, /키 있음/);
});

test('redirect probe: Google error page means no, a sign-in redirect means yes, answers are cached', async () => {
  assert.equal(googleAcceptsRedirect(302, 'https://accounts.google.com/signin/oauth/error?authError=Cg&client_id=x'), false);
  assert.equal(googleAcceptsRedirect(302, 'https://accounts.google.com/v3/signin/identifier?continue=x'), true);
  assert.equal(googleAcceptsRedirect(400, ''), false);
  let calls = 0, answer = 'https://accounts.google.com/signin/oauth/error?authError=x';
  let now = 0;
  const probe = createRedirectProbe({ now: () => now, fetcher: async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.equal(new URL(url).searchParams.get('redirect_uri'), 'http://127.0.0.1:47615/api/auth/native/google/callback');
    return { status: 302, headers: { get: () => answer } };
  } });
  assert.equal(await probe('cid', 'http://127.0.0.1:47615/api/auth/native/google/callback'), false);
  assert.equal(await probe('cid', 'http://127.0.0.1:47615/api/auth/native/google/callback'), false);
  assert.equal(calls, 1, 'a no is cached for a minute');
  answer = 'https://accounts.google.com/v3/signin/identifier'; now += 61e3;
  assert.equal(await probe('cid', 'http://127.0.0.1:47615/api/auth/native/google/callback'), true);
  now += 3600e3;
  assert.equal(await probe('cid', 'http://127.0.0.1:47615/api/auth/native/google/callback'), true);
  assert.equal(calls, 2, 'a yes is cached for hours');
  const failing = createRedirectProbe({ fetcher: async () => { throw new Error('offline'); } });
  assert.equal(await failing('cid', 'x'), false);
  assert.match(googleAuthorizeUrl({ clientId: 'c', redirectUri: 'r', nonce: 'n', state: 's' }), /response_type=id_token/);
});
