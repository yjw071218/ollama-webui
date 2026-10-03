import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loadTrustedPage, kakaoAuthURL } from '../desktop/navigation.mjs';
function fixture(load, target = 'http://127.0.0.1:1234/') {
  const wc = new EventEmitter(); wc.getURL = () => target;
  return {webContents:wc, loadURL:() => load(wc)};
}
test('aborted initial load waits for actual trusted completion', async () => {
  const win = fixture(wc => {
    setTimeout(() => wc.emit('did-finish-load'), 10);
    return Promise.reject(Object.assign(new Error('cancelled'), {code:'ERR_ABORTED', errno:-3}));
  });
  await loadTrustedPage(win, 'http://127.0.0.1:1234/', 'http://127.0.0.1:1234', 200);
  assert.equal(win.webContents.listenerCount('did-finish-load'), 0);
});
test('aborted without replacement never reports success', async () => {
  const win = fixture(() => Promise.reject(Object.assign(new Error('cancelled'), {errno:-3})));
  await assert.rejects(loadTrustedPage(win, 'x', 'http://127.0.0.1:1234', 20), /완료하지/);
});
test('untrusted completion and main-frame network errors fail', async () => {
  await assert.rejects(loadTrustedPage(fixture(wc => {queueMicrotask(() => wc.emit('did-finish-load'));}, 'https://evil.example/'), 'x', 'http://127.0.0.1:1234', 200), /신뢰하지/);
  await assert.rejects(loadTrustedPage(fixture(wc => {queueMicrotask(() => wc.emit('did-fail-load', {}, -102, 'refused', 'x', true));}), 'x', 'http://127.0.0.1:1234', 200), /-102/);
});
test('only Kakao sign-in pages stay in the app window', () => {
  for (const ok of ['https://kauth.kakao.com/oauth/authorize?x=1', 'https://accounts.kakao.com/login']) assert.equal(kakaoAuthURL(ok), true, ok);
  for (const bad of ['http://kauth.kakao.com/', 'https://kauth.kakao.com:8443/', 'https://evil.kakao.com.example/',
    'https://kauth.kakao.com.evil.example/', 'https://user@kauth.kakao.com/', 'https://kakao.com/', 'kakaotalk://x', 'nonsense'])
    assert.equal(kakaoAuthURL(bad), false, bad);
});
