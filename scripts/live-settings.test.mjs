import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyLiveSettings } from '../src/liveSettings.js';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('remote preferences update typed state without reloading or writing storage', () => {
  const values = { temperature: '0.3', autoTitle: 'false', systemPrompt: '', theme: 'dark', lib: '[1]' };
  const seen = {};
  const types = { temperature: 'number', autoTitle: 'boolean', lib: 'json' };
  const bindings = Object.fromEntries(Object.keys(values).map(k => [k, [v => { seen[k] = v; }, types[k] || 'string']]));
  assert.deepEqual(applyLiveSettings(Object.keys(values), k => values[k], bindings), []);
  assert.deepEqual(seen, { temperature: 0.3, autoTitle: false, systemPrompt: '', theme: 'dark', lib: [1] });
});

test('a setting reset on another device goes back to its default here', () => {
  let value = 'x';
  const bindings = { n: [v => { value = v; }, 'number', 7] };
  applyLiveSettings(['n'], () => null, bindings);
  assert.equal(value, 7);
  for (const bad of ['', 'NaN', 'Infinity']) { value = 'x'; applyLiveSettings(['n'], () => bad, bindings); assert.equal(value, 7); }
});

test('a parser shapes the stored text, and a broken one falls back', () => {
  let value;
  const bindings = { p: [v => { value = v; }, 'json', ['d'], raw => { const v = JSON.parse(raw); return Array.isArray(v) ? v : ['d']; }] };
  applyLiveSettings(['p'], () => '{"a":1}', bindings); assert.deepEqual(value, ['d']);
  applyLiveSettings(['p'], () => '{broken', bindings); assert.deepEqual(value, ['d']);
});

test('unknown keys are returned, not reloaded for', () => {
  assert.deepEqual(applyLiveSettings(['unknown', 'unknown'], () => 'x', {}), ['unknown']);
  assert.doesNotMatch(app.slice(app.indexOf('  const applySyncedSettings ='), app.indexOf('  const rereadSyncedLists =')), /location\.reload/);
});

test('every setting App reads at mount is applied live, with a setter that exists', () => {
  const block = app.slice(app.indexOf('  const applySyncedSettings ='), app.indexOf('  const rereadSyncedLists ='));
  for (const [, setter] of block.matchAll(/\[(set\w+), '/g))
    assert.ok(new RegExp('\\b' + setter + '\\]\\s*=\\s*useState').test(app), setter);
  const read = new Set([...app.matchAll(/getSetting\('([\w.:-]+)'\)/g)].map(m => m[1]));
  const bound = new Set([...block.matchAll(/^\s+(\w+): \[set/gm)].map(m => m[1]));
  // Not settings shown in the app: a one-time intro flag.
  for (const key of ['authIntroSeen']) read.delete(key);
  for (const key of read) assert.ok(bound.has(key), `${key} is read at mount but not applied when it syncs`);
});

test('sync never reloads the page, and the app waits for it at launch', () => {
  assert.doesNotMatch(app, /reloadForRev/);
  assert.match(app, /const \[bootSync, setBootSync\]/);
  assert.match(app, /catchUp\(Date\.now\(\) \+ BOOT_SYNC_MAX_MS\)/);
  assert.match(app, /\{bootSync && !initialSync && \(/);
});
