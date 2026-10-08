import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromeColors, DEFAULT_BACKGROUND, validColor } from '../desktop/theme.mjs';
import { clampZoom, zoomStep } from '../desktop/zoom.mjs';
import { addRecent, forgetRecent, MAX_RECENT } from '../desktop/recent.mjs';
import { setLanguage, tr, language } from '../desktop/i18n.mjs';
import { normalizeServer } from '../desktop/proxy.mjs';

const read = f => readFileSync(new URL('../desktop/' + f, import.meta.url), 'utf8');

test('the title bar takes the page colours, light or dark', () => {
  const dark = chromeColors('#1a1916');
  assert.equal(dark.bg, '#1a1916'); assert.equal(dark.light, false); assert.equal(dark.fg, '#ede8df');
  const light = chromeColors('#FAF9F5');
  assert.equal(light.bg, '#faf9f5'); assert.equal(light.light, true); assert.equal(light.fg, '#24211d');
  for (const c of [dark, light]) for (const k of ['muted', 'line', 'hover']) assert.match(c[k], /^#[0-9a-f]{6}$/);
  assert.equal(chromeColors('red').bg, DEFAULT_BACKGROUND);
  assert.equal(validColor('#12345'), null);
});

test('zoom moves in browser steps and stays in range', () => {
  assert.equal(zoomStep(1, 1), 1.1); assert.equal(zoomStep(1, -1), 0.9);
  assert.equal(zoomStep(2, 1), 2); assert.equal(zoomStep(0.5, -1), 0.5);
  assert.equal(zoomStep(1.05, 1), 1.1);
  assert.equal(clampZoom('x'), 1); assert.equal(clampZoom(9), 2);
});

test('recent servers: newest first, no repeats, a few at most', () => {
  let list = [];
  for (const s of ['http://a', 'http://b', 'http://a']) list = addRecent(list, s);
  assert.deepEqual(list, ['http://a', 'http://b']);
  for (let i = 0; i < 10; i++) list = addRecent(list, 'http://s' + i);
  assert.equal(list.length, MAX_RECENT);
  assert.deepEqual(forgetRecent(['http://a', 'http://b'], 'http://a'), ['http://b']);
  assert.deepEqual(addRecent('junk', 'http://a'), ['http://a']);
});

test('the app speaks Korean on a Korean system and English elsewhere', () => {
  assert.equal(setLanguage('ko-KR'), 'ko'); assert.equal(tr('새 대화', 'New chat'), '새 대화');
  assert.equal(setLanguage('en-US'), 'en'); assert.equal(tr('새 대화', 'New chat'), 'New chat');
  assert.equal(setLanguage('ja'), 'en'); assert.equal(language(), 'en');
  setLanguage('ko');
});

test('an address typed without http:// is accepted, as on Android', () => {
  assert.equal(normalizeServer('192.168.0.5:5173'), 'http://192.168.0.5.nip.io:5173');
  assert.throws(() => normalizeServer('https://example.com/'));
  for (const bad of ['javascript:alert(1)', 'host/path', 'file:///x', 'http://u:p@h']) assert.throws(() => normalizeServer(bad));
  assert.doesNotMatch(read('setup.html'), /type="url"/, 'the field no longer refuses an address without a scheme');
});

test('main wires the client features to the page, checked by origin', () => {
  const main = read('main.mjs');
  for (const channel of ['client:chrome', 'client:busy', 'client:changeServer', 'client:checkUpdates'])
    assert.ok(main.includes(`'${channel}'`), channel);
  assert.match(main, /function validClient\(event\)[\s\S]{0,300}sameOrigin\(event\.senderFrame\.url, gateway\.origin\)/);
  assert.match(main, /ipcMain\.on\('client:busy', \(event, value\) => \{ if \(validClient\(event\)\)/);
  assert.match(main, /lastFailure = \{ server, message: error\.message, invalid: !!error\.notServer \}/, 'a failed start is shown on the address screen');
  assert.match(main, /did-fail-load[\s\S]{0,600}tr\('다시 시도', 'Try again'\)/, 'a lost connection offers a retry');
  assert.match(main, /pickSource\(clientWindow, sources, server\)/, 'screens are chosen by their picture');
  assert.match(main, /new Tray\(/); assert.match(main, /globalShortcut\.register\(GLOBAL_KEY/); assert.match(main, /setUserTasks\(/);
  assert.match(main, /setProgressBar\(busy \? 2 : -1/); assert.match(main, /flashFrame\(true\)/);
  assert.match(read('chrome.mjs'), /preload: path\.join\(root, 'client-preload\.cjs'\)/);
  assert.match(read('client-preload.cjs'), /platform: 'desktop'/);
});
