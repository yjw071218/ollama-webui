// The per-chat store (src/chatStore.js) in a real browser, real IndexedDB.
//
//   npm run build && node scripts/chatstore.browser.test.mjs
//
// Seeds a large account in the old single-value layout, boots the built app,
// and checks: migration, that a sent message writes one chat and not the
// account, that a reload keeps everything, and that a second tab sees it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.TEST_DIST ? path.resolve(process.env.TEST_DIST) : path.join(HERE, '..', 'dist');
const HTTP_PORT = 8257;
const CDP_PORT = 9492;
const CHATS = 400;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(fail ? 1 : 0); };

const browser = [
  process.env.SMOKE_BROWSER,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
].find(p => p && fs.existsSync(p));
if (!browser) { console.log('SKIP  no Chrome or Edge'); process.exit(0); }
if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.log('FAIL  run npm run build first'); process.exit(1); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__seed') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>seed</title>'); return; }
  if (/^\/(api|mcp|localfs|system|tts-api|kakao|studio|v1)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"not running in this test"}'); return;
  }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;

const { launchChrome } = await import('./chromeProfile.mjs');
const chrome = launchChrome(browser, 'webui-chrome-chatstore-', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`]);
function cleanup() { try { server.close(); } catch {} try { chrome.close(); } catch {} }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- a minimal CDP client per page ---- */
const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const thrown = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0]);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    return r.result?.result?.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  return { send, evaluate, thrown, close: () => ws.close() };
};
const pageTarget = async () => {
  for (let i = 0; i < 80; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(x => x.type === 'page'); if (t) return t.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error('no debugging port');
};

/* Raw IndexedDB from inside the page, independent of the app's own code. */
const IDB = `
  const openDb = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = async (name) => {
    const dbs = (await indexedDB.databases()).map(d => d.name);
    if (!dbs.includes(name)) return [];
    const db = await openDb(name); const out = [];
    for (const store of db.objectStoreNames) {
      await new Promise((res) => { const q = db.transaction(store).objectStore(store).openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return res(); out.push({ store, key: c.key, value: c.value }); c.continue(); }; });
    }
    db.close(); return out;
  };
  const put = async (name, store, key, value) => { const db = await openDb(name);
    await new Promise((res, rej) => { const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(value, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); db.close(); };
`;

/* Counts every IndexedDB put, per database, before the app runs. */
const COUNTER = `(() => {
  window.__puts = []; const orig = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    let bytes = 0; try { bytes = JSON.stringify(value)?.length || 0; } catch {}
    window.__puts.push({ db: this.transaction.db.name, key: String(key), bytes }); return orig.apply(this, arguments);
  };
})();`;

const enterAsGuest = (p) => p.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || '')); if (b) b.click(); return !!b; })()`);
const sidebarText = (p) => p.evaluate(`(document.querySelector('.claude-sidebar')?.textContent || '')`);

let A;
try {
  A = await connect(await pageTarget());
  await A.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTER });
  await A.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await A.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(6000);
  await enterAsGuest(A);
  await sleep(4000);

  /* Which list key is this guest's? Learn it by sending nothing: look for a
     session key the app has read. Fall back to the guest key. */
  const key = await A.evaluate(`(async () => { ${IDB}
    const keys = (await all('ollama-webui-chats')).map(r => String(r.key)).filter(k => k.endsWith('\\u0000index')).map(k => k.slice(0, -6));
    if (keys.length) return keys[0];
    const legacy = (await all('localforage')).filter(r => r.store === 'keyvaluepairs' && /^ollama-sessions(:|$)/.test(String(r.key)) && !String(r.key).endsWith(':last'));
    return legacy[0] ? String(legacy[0].key) : 'ollama-sessions';
  })()`);
  check('found the guest chat list key', typeof key === 'string' && key.startsWith('ollama-sessions'), key);

  /* ---- seed a large account in the OLD layout ---- */
  await A.send('Page.navigate', { url: `${ORIGIN}/__seed` });
  await sleep(1500);
  const wiped = await A.evaluate(`new Promise(r => { const q = indexedDB.deleteDatabase('ollama-webui-chats'); q.onsuccess = () => r('ok'); q.onerror = () => r('error'); q.onblocked = () => r('blocked'); })`);
  check('started from the old layout (new store wiped)', wiped === 'ok', wiped);
  const seeded = await A.evaluate(`(async () => { ${IDB}
    const pad = 'x'.repeat(2000); const now = Date.now(); const list = [];
    for (let i = 0; i < ${CHATS}; i++) {
      const messages = [];
      for (let m = 0; m < 20; m++) messages.push({ role: m % 2 ? 'assistant' : 'user', content: 'seed ' + i + ' msg ' + m + ' ' + pad });
      list.push({ id: 'seed-' + i, title: 'SeedChat ' + i, createdAt: now - i * 60000, updatedAt: now - i * 60000, messages });
    }
    await put('localforage', 'keyvaluepairs', ${JSON.stringify(key)}, list);
    return JSON.stringify(list).length;
  })()`);
  check('seeded the old single-value layout', seeded > 15e6, `${(seeded / 1e6).toFixed(1)} MB, ${CHATS} chats`);

  /* ---- reload: migration ---- */
  const t0 = Date.now();
  await A.send('Page.navigate', { url: `${ORIGIN}/` });
  await sleep(6000);
  await enterAsGuest(A);
  await sleep(6000);
  const bootMs = Date.now() - t0;
  const side = await sidebarText(A);
  check('the seeded chats appear in the sidebar', /SeedChat 0/.test(side) && /SeedChat 1/.test(side));

  const layout = await A.evaluate(`(async () => { ${IDB}
    const split = await all('ollama-webui-chats');
    const legacy = (await all('localforage')).find(r => r.store === 'keyvaluepairs' && r.key === ${JSON.stringify(key)});
    const index = split.find(r => String(r.key) === ${JSON.stringify(key)} + '\\u0000index');
    return { records: split.filter(r => String(r.key).startsWith(${JSON.stringify(key)} + '\\u0001')).length,
      indexed: index ? Object.keys(index.value.items).length : 0, legacyLeft: !!legacy };
  })()`);
  check('migrated: one record per chat', layout.records === CHATS, `${layout.records} records`);
  check('migrated: the index lists every chat', layout.indexed === CHATS, `${layout.indexed} in index`);
  check('migrated: the old single value is gone', layout.legacyLeft === false);
  console.log(`      (boot + migration of ${CHATS} chats finished within ~${Math.round(bootMs / 1000)} s of waiting)`);

  /* ---- send a message: count what is written ---- */
  await A.evaluate(`window.__puts.length = 0`);
  const typed = await A.evaluate(`(async () => {
    const box = document.querySelector('.chat-input textarea, textarea');
    if (!box) return 'no textarea';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    box.focus(); setter.call(box, 'ProbeMessage hello from the test'); box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'sent';
  })()`);
  check('a message was typed and sent', typed === 'sent', typed);
  await sleep(6000);
  const puts = await A.evaluate(`window.__puts`);
  const chatPuts = puts.filter(p => p.db === 'ollama-webui-chats');
  const wholeList = puts.filter(p => p.db === 'localforage' && p.key === key);
  const recordPuts = chatPuts.filter(p => !p.key.endsWith('\u0000index'));
  const touched = new Set(recordPuts.map(p => p.key));
  const bytes = chatPuts.reduce((n, p) => n + p.bytes, 0);
  check('sending wrote chat records, not the whole list', chatPuts.length > 0 && wholeList.length === 0,
    `${chatPuts.length} puts, whole-list puts ${wholeList.length}`);
  check('only the chat being written was touched', touched.size >= 1 && touched.size <= 2, `${touched.size} distinct chat(s): ${[...touched].map(k => k.split('\u0001')[1]).join(', ')}`);
  check('bytes written per save are small, not the account', bytes < 2e6, `${(bytes / 1e3).toFixed(0)} KB written vs ${(seeded / 1e6).toFixed(1)} MB account`);
  check('the new chat is in the sidebar', /ProbeMessage/.test(await sidebarText(A)));

  /* ---- reload keeps it ---- */
  await A.send('Page.reload');
  await sleep(6000); await enterAsGuest(A); await sleep(5000);
  const afterReload = await sidebarText(A);
  check('after reload the new chat is still there', /ProbeMessage/.test(afterReload));
  check('after reload the seeded chats are still there', /SeedChat 0/.test(afterReload));

  /* The sidebar draws its rows as it is scrolled (src/SidebarMore.jsx). */
  const rowsAtFirst = await A.evaluate(`document.querySelectorAll('.history-item').length`);
  check('the sidebar starts with a partial list', rowsAtFirst > 0 && rowsAtFirst < CHATS, `${rowsAtFirst} rows drawn of ${CHATS + 1}`);
  let rowsNow = rowsAtFirst;
  for (let i = 0; i < 20 && rowsNow < CHATS + 1; i++) {
    await A.evaluate(`(() => { const el = document.querySelector('.sidebar-content'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); })()`);
    await sleep(400);
    rowsNow = await A.evaluate(`document.querySelectorAll('.history-item').length`);
  }
  check('scrolling down draws every chat', rowsNow === CHATS + 1, `${rowsNow} rows`);
  check('including the oldest one', /SeedChat 399/.test(await sidebarText(A)));
  const count = await A.evaluate(`(async () => { ${IDB}
    return (await all('ollama-webui-chats')).filter(r => String(r.key).startsWith(${JSON.stringify(key)} + '\\u0001')).length; })()`);
  check('stored chats = seeded + the new one', count === CHATS + 1, `${count}`);

  /* ---- a second tab ---- */
  const created = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
  const B = await connect(created.webSocketDebuggerUrl);
  await sleep(6000); await enterAsGuest(B); await sleep(5000);
  check('the second tab sees the same chats', /ProbeMessage/.test(await sidebarText(B)) && /SeedChat 0/.test(await sidebarText(B)));

  // Tab B renames one seeded chat by the store's own protocol is not reachable
  // from outside, so B sends a message of its own -- the real path.
  await B.evaluate(`(async () => {
    const box = document.querySelector('.chat-input textarea, textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    box.focus(); setter.call(box, 'SecondTabMessage from tab B'); box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  })()`);
  await sleep(6000);
  // Back to tab A, which re-reads on becoming visible.
  await A.send('Page.bringToFront');
  await A.evaluate(`(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); })()`);
  await sleep(4000);
  check('tab A picks up the chat tab B wrote', /SecondTabMessage/.test(await sidebarText(A)));
  check('and still has its own', /ProbeMessage/.test(await sidebarText(A)));

  // Tab A writes again (another message) -- tab B's chat must survive it.
  await A.evaluate(`(async () => {
    const box = document.querySelector('.chat-input textarea, textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    box.focus(); setter.call(box, 'ThirdMessage from tab A'); box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  })()`);
  await sleep(6000);
  const final = await A.evaluate(`(async () => { ${IDB}
    const recs = (await all('ollama-webui-chats')).filter(r => String(r.key).startsWith(${JSON.stringify(key)} + '\\u0001')).map(r => JSON.stringify(r.value).slice(0, 4000));
    return { n: recs.length, b: recs.some(t => t.includes('SecondTabMessage')), a: recs.some(t => t.includes('ThirdMessage') || t.includes('ProbeMessage')) };
  })()`);
  check('tab B\'s chat survives tab A\'s later write', final.b === true);
  check('nothing was lost overall', final.n >= CHATS + 2, `${final.n} stored`);

  /* An old-version tab writing the single value after migration. */
  await A.evaluate(`(async () => { ${IDB}
    await put('localforage', 'keyvaluepairs', ${JSON.stringify(key)}, [{ id: 'oldtab-1', title: 'OldTabChat', createdAt: Date.now(), updatedAt: Date.now(), messages: [{ role: 'user', content: 'OldTabChat written by the previous version' }] }]);
  })()`);
  await A.evaluate(`(() => { document.dispatchEvent(new Event('visibilitychange')); })()`);
  await sleep(4000);
  check("an old-version tab's write shows up", /OldTabChat/.test(await sidebarText(A)));
  await A.send('Page.reload'); await sleep(6000); await enterAsGuest(A); await sleep(6000);
  const old = await A.evaluate(`(async () => { ${IDB}
    const split = await all('ollama-webui-chats');
    return { moved: split.some(r => String(r.key).endsWith('oldtab-1')), seeds: split.filter(r => String(r.key).includes('seed-')).length,
      legacyLeft: (await all('localforage')).some(r => r.key === ${JSON.stringify(key)}) };
  })()`);
  check("and is moved into the per-chat store", old.moved === true && old.legacyLeft === false, JSON.stringify(old));
  check('with the seeded chats untouched', old.seeds === CHATS, `${old.seeds}`);

  const errs = [...A.thrown, ...B.thrown];
  check('no uncaught exceptions in either tab', errs.length === 0, errs.slice(0, 3).join(' | '));
  B.close();
} catch (e) {
  check('the run completed', false, e.stack || e.message);
}
done();
