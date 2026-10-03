import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('closing a login browser leaves retry available and invalidates the old poll', async () => {
  const source = readFileSync(new URL('../src/auth.jsx', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  if (native) {'), source.indexOf("    await loadScriptOnce('google-gsi'"));
  const body = block.slice(0, block.lastIndexOf('\n  try {'));
  const button = { isConnected: true };
  const timers = [], urls = [], credentials = [], errors = [];
  let starts = 0, polls = 0;
  const context = {
    native: true, loopback: false, googleClientId: 'cid', container: { replaceChildren() {}, appendChild() {} },
    document: { createElement: () => button },
    window: { location: { assign: url => urls.push(url) } },
    AbortSignal, Date, JSON, Promise,
    setTimeout: callback => timers.push(callback),
    onCredential: value => credentials.push(value), onError: value => errors.push(value),
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/start')
      ? { id: 'id-' + ++starts, secret: 'secret' }
      : (polls++, { credential: 'verified' }) }),
  };
  await vm.runInNewContext('(async () => {' + body + '})()', context);
  const first = button.onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(button.disabled, false);
  assert.equal(button.className, 'auth-social-btn native-google');
  assert.match(button.innerHTML, /Google 계정으로 계속하기/);
  assert.match(button.innerHTML, /<svg/);
  const second = button.onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(urls.length, 2);
  assert.equal(timers.length, 2);
  timers.shift()();
  await first;
  assert.equal(polls, 0);
  timers.shift()();
  await second;
  assert.equal(polls, 1);
  assert.deepEqual(credentials, ['verified']);
  assert.deepEqual(errors, []);
  assert.equal(button.disabled, false);
});

test('Google opens the account chooser directly only when the app and the server both can', async () => {
  const source = readFileSync(new URL('../src/auth.jsx', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  if (native) {'), source.indexOf("    await loadScriptOnce('google-gsi'"));
  const body = block.slice(0, block.lastIndexOf('\n  try {'));
  const run = async ({ loopback, ready }) => {
    const button = { isConnected: true };
    const urls = [], asked = [];
    const context = {
      native: true, loopback, googleClientId: 'cid.apps.googleusercontent.com', container: { replaceChildren() {}, appendChild() {} },
      document: { createElement: () => button }, window: { location: { assign: url => urls.push(url) } },
      AbortSignal, Date, JSON, Promise, setTimeout: () => {}, onCredential() {}, onError() {},
      fetch: async (url) => {
        asked.push(url);
        if (url.endsWith('/google/ready')) return ready;
        return { ok: true, json: async () => ({ id: 'id-1', secret: 's' }) };
      },
    };
    await vm.runInNewContext('(async () => {' + body + '})()', context);
    button.onclick();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return { urls, asked };
  };
  const yes = { ok: true, json: async () => ({ direct: true }) };
  assert.deepEqual((await run({ loopback: true, ready: yes })).urls, ['/__native/auth#google:id-1:cid.apps.googleusercontent.com']);
  assert.deepEqual((await run({ loopback: true, ready: { ok: true, json: async () => ({ direct: false }) } })).urls, ['/__native/auth#id-1']);
  assert.deepEqual((await run({ loopback: true, ready: { ok: false, json: async () => ({}) } })).urls, ['/__native/auth#id-1'], 'old server: 404');
  const old = await run({ loopback: false, ready: yes });
  assert.deepEqual(old.urls, ['/__native/auth#id-1'], 'old app');
  assert.ok(!old.asked.some(u => u.endsWith('/google/ready')));
});
