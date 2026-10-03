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
    native: true, container: { replaceChildren() {}, appendChild() {} },
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
  assert.equal(button.textContent, 'Google로 계속');
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
