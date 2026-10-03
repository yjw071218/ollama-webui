import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newer, selectUpdate, checkUpdate } from '../desktop/updates.mjs';
const release = (tag_name, more = {}) => ({ tag_name, assets: [{ name: 'OllamaWebUI-Client-1.2.0-x64-Setup.exe', state: 'uploaded' }], ...more });
test('numeric stable versions only', () => {
  assert.ok(newer('native-v1.10.0', '1.9.0'));
  for (const v of ['native-v1.0.0', 'native-v0.9.9', 'native-v2.0.0-beta', 'oops', 'native-v01.2.0']) assert.equal(newer(v, '1.0.0'), false);
});
test('native release channel, asset, draft and prerelease checks', () => {
  const result = selectUpdate([release('v99.0.0'), release('native-v9.0.0', {draft:true}), release('native-v8.0.0', {prerelease:true}), release('native-v7.0.0', {assets:[]}), release('native-v1.2.0'), release('native-v1.10.0')], '1.0.0');
  assert.equal(result.version, '1.10.0');
  assert.equal(result.url, 'https://github.com/yjw071218/ollama-webui/releases/tag/native-v1.10.0');
  assert.equal(selectUpdate([], '1.0.0'), null);
  assert.equal(selectUpdate({}, '1.0.0'), null);
});
test('network failure is surfaced; request contains no app/server secrets', async () => {
  await assert.rejects(checkUpdate('1.0.0', async (url, options) => {
    assert.match(url, /releases\?per_page=100$/);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    return {ok:false, status:403};
  }), /403/);
});
