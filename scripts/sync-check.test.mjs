import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/sync-check.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise(resolve => setImmediate(resolve));
async function page({ wrongOwner = false, login = true } = {}) {
  const elements = Object.fromEntries(['#result', '#check', '#repair'].map(id => [id, { textContent: '', disabled: false }]));
  const writes = [];
  const chats = [{ id: 'latest', updatedAt: 200, messages: [{ content: 'latest' }] }, { id: 'old', updatedAt: 100, messages: [] }];
  let readKey;
  const context = {
    document: { querySelector: id => elements[id] },
    sessionStorage: { getItem: () => 'existing-tab' },
    setTimeout, clearTimeout, URLSearchParams, TextEncoder, AbortSignal,
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        request.result = { close() {}, objectStoreNames: { contains: () => true }, transaction() { return { objectStore() { return { get(key) {
          readKey = key; const get = {}; queueMicrotask(() => { get.result = chats; get.onsuccess(); }); return get;
        } }; } }; } };
        request.onsuccess();
      }); return request;
    } },
    fetch: async (path, options) => {
      let data;
      if (path.endsWith('/session')) data = { user: login ? { id: 'owner', name: 'Test' } : null, sessionId: 'pinned', csrfToken: 'csrf' };
      else if (path.endsWith('/stats')) data = { ownerId: wrongOwner ? 'other' : 'owner', rev: 10, chats: 1 };
      else { writes.push({ body: JSON.parse(options.body), headers: options.headers }); data = { ownerId: 'owner', rev: 11, refusedCount: 0 }; }
      return { ok: true, status: 200, json: async () => data };
    },
  };
  vm.runInNewContext(script, context);
  await settle();
  return { elements, writes, readKey };
}

test('diagnostic reads only signed-in chats and repairs newest first with scoped auth', async () => {
  const p = await page();
  assert.equal(p.readKey, 'ollama-sessions:srv-owner');
  assert.match(p.elements['#result'].textContent, /PC 저장 대화: 2개/);
  assert.equal(p.elements['#repair'].disabled, false);
  await p.elements['#repair'].onclick();
  assert.deepEqual(p.writes.map(w => w.body.records[0].id), ['latest', 'old']);
  assert.ok(p.writes.every(w => w.body.ownerId === 'owner' && w.headers['X-Session-Id'] === 'pinned' && w.headers['X-CSRF-Token'] === 'csrf'));
  assert.ok(p.writes.every(w => !w.body.records[0].deleted));
  assert.match(p.elements['#result'].textContent, /완료: 2개/);
});

test('signed-out or mismatched account never enables repair', async () => {
  for (const options of [{ login: false }, { wrongOwner: true }]) {
    const p = await page(options);
    assert.equal(p.elements['#repair'].disabled, true);
    assert.match(p.elements['#result'].textContent, /오류:/);
    assert.equal(p.writes.length, 0);
  }
});
