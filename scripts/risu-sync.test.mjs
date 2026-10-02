import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRisuSyncHandler } from '../server/risuSync.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeRisu, mergeRisuAutomatically } from '../integrations/risuai/sync-merge.js';
import { syncSettings, applySyncSettings } from '../integrations/risuai/sync-settings.js';
import { syncAssetTasks } from '../integrations/risuai/sync-assets.js';
import { createDelta, applyDelta } from '../integrations/risuai/sync-delta.js';
import { createAssetIndex } from '../integrations/risuai/sync-asset-index.js';

test('message append and settings edits transfer only changed values and round trip', () => {
  const before = { characters: [{ chaId: 'a', chats: [{ message: [{ data: 'old'.repeat(10000) }] }] }], assets: { image: 'digest' }, settings: { temperature: 50 } };
  const after = structuredClone(before);
  after.characters[0].chats[0].message.push({ data: 'new reply' });
  after.settings.temperature = 70;
  const delta = createDelta(before, after);
  assert.ok(JSON.stringify(delta).length < 250);
  assert.deepEqual(applyDelta(before, delta), after);
  assert.deepEqual(applyDelta(after, createDelta(after, before)), before);
  assert.throws(() => applyDelta(before, [{ path: ['__proto__', 'polluted'], value: true }]), /Invalid/);
});

test('asset index reads existing binaries once and tracks edits, deletions and other tabs', async () => {
  const values = new Map([['assets/a', new Uint8Array([1])]]);
  let reads = 0;
  const storage = { keys: async () => [...values.keys()], getItem: async key => { reads++; return values.get(key); },
    setItem: async (key, bytes) => values.set(key, bytes), removeItem: async key => values.delete(key) };
  const index = createAssetIndex(storage, key => key.startsWith('assets/'), bytes => String(bytes[0]), () => {});
  assert.deepEqual(await index.read(), { 'assets/a': '1' });
  await index.read(); assert.equal(reads, 1);
  await storage.setItem('assets/a', new Uint8Array([2]));
  assert.deepEqual(await index.read(), { 'assets/a': '2' }); assert.equal(reads, 1);
  values.set('assets/a', new Uint8Array([3])); index.invalidate('assets/a');
  assert.deepEqual(await index.read(), { 'assets/a': '3' }); assert.equal(reads, 2);
  await storage.removeItem('assets/a'); assert.deepEqual(await index.read(), {});
});

test('large asset libraries transfer concurrently with bounded memory and complete progress', async () => {
  let active = 0, maximum = 0, finished = 0;
  const progress = [];
  await syncAssetTasks(Array.from({ length: 100 }, (_, i) => i), async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve));
    active--; finished++;
  }, (done, total) => progress.push([done, total]));
  assert.equal(maximum, 8);
  assert.equal(finished, 100);
  assert.deepEqual(progress.at(-1), [100, 100]);
});

test('failed transfer drains existing workers before permitting retry', async () => {
  let active = 0, started = 0;
  await assert.rejects(syncAssetTasks([0, 1, 2, 3, 4], async value => {
    started++; active++;
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (value === 0) throw new Error('offline');
  }, () => {}, 2), /offline/);
  assert.equal(active, 0);
  assert.equal(started, 2);
});

test('active settings round trip across different preset ordering without sharing endpoints', () => {
  const desktop = { botPresets: [{ name: 'Default' }, { name: 'Roleplay' }], botPresetsId: 1,
    temperature: 72, maxContext: 8192, promptTemplate: [{ type: 'plain', text: 'shared prompt' }],
    enabledModules: ['module'], personas: [{ name: 'User' }], ollamaModel: 'local',
    openAIKey: 'private', ollamaURL: 'http://desktop', zoomsize: 120 };
  const mobile = { botPresets: [{ name: 'Roleplay' }, { name: 'Default' }], botPresetsId: 1,
    temperature: 10, ollamaURL: 'http://mobile', zoomsize: 80 };
  applySyncSettings(mobile, syncSettings(desktop));
  assert.equal(mobile.botPresetsId, 0);
  assert.equal(mobile.temperature, 72);
  assert.deepEqual(mobile.promptTemplate, desktop.promptTemplate);
  assert.deepEqual(mobile.enabledModules, ['module']);
  assert.equal(mobile.ollamaModel, 'local');
  assert.equal(mobile.ollamaURL, 'http://mobile');
  assert.equal(mobile.zoomsize, 80);
  assert.equal(mobile.openAIKey, undefined);
});

test('prompt toggle choices travel with the settings, other global variables do not', () => {
  const desktop = { botPresets: [{ name: 'P' }], botPresetsId: 0,
    globalChatVariables: { toggle_nsfw: '1', toggle_style: '2', score: '99' } };
  const mobile = { botPresets: [{ name: 'P' }], botPresetsId: 0,
    globalChatVariables: { toggle_nsfw: '0', toggle_old: '1', score: '3' } };
  const settings = syncSettings(desktop);
  assert.deepEqual(settings.promptToggles, { toggle_nsfw: '1', toggle_style: '2' });
  applySyncSettings(mobile, settings);
  assert.deepEqual(mobile.globalChatVariables, { score: '3', toggle_nsfw: '1', toggle_style: '2' });
  assert.equal(syncSettings({ globalChatVariables: { score: '1' } }).promptToggles, undefined);
});

test('chat conflicts preserve shared settings and independent setting edits', () => {
  const base = { characters: [{ chaId: 'a', chats: ['old'] }], assets: {}, settings: { temperature: 50, maxContext: 4000, globalNote: 'old' } };
  const local = structuredClone(base), remote = structuredClone(base);
  local.characters[0].chats.push('PC'); remote.characters[0].chats.push('mobile');
  local.settings.temperature = 70; remote.settings.maxContext = 8192;
  local.settings.globalNote = 'PC note'; remote.settings.globalNote = 'mobile note';
  const merged = mergeRisuAutomatically(base, local, remote);
  assert.deepEqual(merged.settings, { temperature: 70, maxContext: 8192, globalNote: 'mobile note' });
  assert.equal(merged.characters.length, 1);
  assert.deepEqual(merged.characters[0].chats, ['old', 'mobile', 'PC']);
});

test('automatic conflict resolution keeps both replies in one character, with no copy', () => {
  const base = { characters: [{ chaId: 'a', name: '캐릭터', chats: [{ id: 'c', message: ['hello'] }] }], assets: {} };
  const local = structuredClone(base), remote = structuredClone(base);
  local.characters[0].chats[0].message.push('PC reply');
  remote.characters[0].chats[0].message.push('mobile reply');
  const merged = mergeRisuAutomatically(base, local, remote);
  assert.equal(merged.characters.length, 1);
  assert.equal(merged.characters[0].chaId, 'a');
  assert.deepEqual(merged.characters[0].chats[0].message, ['hello', 'mobile reply', 'PC reply']);
  assert.doesNotMatch(JSON.stringify(merged), /동시 수정 사본/);
  // Syncing again is stable: nothing is appended twice, nothing is copied.
  const again = mergeRisuAutomatically(base, local, merged);
  assert.equal(again.characters.length, 1);
  assert.deepEqual(again.characters[0].chats[0].message, ['hello', 'mobile reply', 'PC reply']);
});

test('a conflicting plain value takes the committed one instead of copying the character', () => {
  const base = { characters: [{ chaId: 'a', name: 'A', desc: 'old' }], assets: {} };
  const local = structuredClone(base), remote = structuredClone(base);
  local.characters[0].desc = 'PC'; remote.characters[0].desc = 'mobile';
  const merged = mergeRisuAutomatically(base, local, remote);
  assert.deepEqual(merged.characters, [{ chaId: 'a', name: 'A', desc: 'mobile' }]);
});

test('conflicting asset paths keep the committed file and reference, with no copy', () => {
  const base = { characters: [{ chaId: 'a', image: 'assets/a', name: 'A' }], assets: { 'assets/a': 'old' } };
  const local = { characters: [{ chaId: 'a', image: 'assets/a', name: 'PC' }], assets: { 'assets/a': 'localhash' } };
  const remote = { characters: [{ chaId: 'a', image: 'assets/a', name: 'Phone' }], assets: { 'assets/a': 'remotehash' } };
  const merged = mergeRisuAutomatically(base, local, remote);
  assert.equal(merged.characters.length, 1);
  assert.equal(merged.characters[0].image, 'assets/a');
  assert.equal(merged.characters[0].name, 'Phone');
  assert.equal(merged.assets['assets/a'], 'remotehash');
});

test('three-way merge keeps independent device edits and refuses conflicting replies', () => {
  const base = { characters: [{ chaId: 'one', chats: [{ id: 'chat', message: ['hello'] }] }] };
  const a = structuredClone(base), b = structuredClone(base);
  a.characters.push({ chaId: 'two', chats: [] });
  b.characters[0].chats[0].message.push('mobile reply');
  const merged = mergeRisu(base, a, b);
  assert.equal(merged.characters.length, 2);
  assert.deepEqual(merged.characters[0].chats[0].message, ['hello', 'mobile reply']);
  a.characters[0].chats[0].message.push('desktop reply');
  assert.throws(() => mergeRisu(base, a, b), /두 기기/);
  assert.deepEqual(mergeRisu(base, { characters: [] }, base), { characters: [] });
  assert.equal(mergeRisu({ lastInteraction: 1 }, { lastInteraction: 2 }, { lastInteraction: 3 }).lastInteraction, 3);
});

test('account snapshots are isolated, atomic, versioned and asset-complete', async t => {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('a'),('b');");
  const guard = (req, res) => {
    const user = req.headers['x-test-user'];
    if (!['a', 'b'].includes(user)) { res.writeHead(401); res.end(); return null; }
    return { user: { id: user } };
  };
  const server = http.createServer(createRisuSyncHandler({ assetDir: mkdtempSync(join(tmpdir(), 'risu-assets-')),  guard, db: () => db }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const origin = `http://127.0.0.1:${server.address().port}/api/risu/sync`;
  const call = (user, suffix = '', options = {}) => fetch(origin + suffix, { ...options, headers: { 'x-test-user': user, ...options.headers } });
  assert.equal((await fetch(origin)).status, 401);
  const bytes = Buffer.from('에셋 bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const data = { characters: [{ chaId: 'one', chats: [] }], assets: { 'assets/image.png': hash } };
  const save = revision => call('a', '', { method: 'POST', body: JSON.stringify({ revision, data }) });
  assert.equal((await save(0)).status, 400);
  assert.equal((await call('a', '?asset=' + hash, { method: 'PUT', body: bytes })).status, 200);
  const races = await Promise.all([save(0), save(0)]);
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual((await (await call('a')).json()).data, data);
  const changed = structuredClone(data);
  changed.characters[0].chats.push({ id: 'new', message: ['incremental reply'] });
  const patch = createDelta(data, changed);
  const commit = await call('a', '', { method: 'POST', body: JSON.stringify({ revision: 1, delta: patch }) });
  assert.equal(commit.status, 200);
  const incremental = await (await call('a', '?revision=1&delta=1')).json();
  assert.equal(incremental.fromRevision, 1);
  assert.equal(incremental.data, undefined);
  assert.deepEqual(applyDelta(data, incremental.delta), changed);
  assert.equal((await call('a', '', { method: 'POST', body: JSON.stringify({ revision: 1, delta: patch }) })).status, 409);
  assert.equal((await (await call('a', '?revision=2&delta=1')).json()).unchanged, true);
  assert.equal((await (await call('b', '?revision=1&delta=1')).json()).data, null);
  assert.deepEqual(Buffer.from(await (await call('a', '?asset=' + hash)).arrayBuffer()), bytes);
  assert.equal((await call('b', '?asset=' + hash)).status, 404);
  assert.equal((await (await call('b')).json()).revision, 0);
  assert.equal((await call('a', '?asset=../outside')).status, 400);
  assert.equal((await call('a', '?asset=' + hash, { method: 'PUT', body: 'wrong' })).status, 400);
  db.prepare('DELETE FROM users WHERE id=?').run('a');
  assert.equal(db.prepare('SELECT count(*) AS n FROM risu_assets').get().n, 0);
});
