import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyLiveSettings } from '../src/liveSettings.js';
test('remote preferences update typed state without reloading or writing storage', () => {
  const values = {temperature:'0.3',autoTitle:'false',systemPrompt:'',theme:'dark'};
  const seen = {};
  const bindings = Object.fromEntries(Object.keys(values).map(k => [k, [v=>seen[k]=v,
    k==='temperature'?'number':k==='autoTitle'?'boolean':'string']]));
  assert.equal(applyLiveSettings(Object.keys(values), k=>values[k], bindings), true);
  assert.deepEqual(seen, {temperature:0.3,autoTitle:false,systemPrompt:'',theme:'dark'});
});
test('only changed keys apply; unknown, deleted and invalid values retain fallback', () => {
  let count=0;
  const bindings={x:[()=>count++,'number']};
  assert.equal(applyLiveSettings(['x','x'],()=> '4',bindings),true);
  assert.equal(count,1);
  for (const value of [null,'','NaN','Infinity']) assert.equal(applyLiveSettings(['x'],()=>value,bindings),false);
  assert.equal(applyLiveSettings(['unknown'],()=> 'x',bindings),false);
  assert.equal(count,1);
});
test('all live setting setters exist in App and match its state type', () => {
  const app=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
  const block=app.slice(app.indexOf('  const applySyncedSettings ='),app.indexOf('  const showRemoteChanges ='));
  for(const [,setter] of block.matchAll(/\[(set\w+), '/g))
    assert.ok(new RegExp('\\b'+setter+'\\]\\s*=\\s*useState').test(app),setter);
});
