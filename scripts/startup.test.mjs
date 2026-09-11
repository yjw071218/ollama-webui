// Where the app lands, and whether it stays there.
//
// Two behaviours, both easy to break from the other side of the file and both
// invisible in a unit test, because what they are about is what happens when
// the page boots and when the browser hands the tab back.
//
//   * Opening or refreshing starts a new chat. It used to reopen whatever was
//     last read, which is helpful exactly once: on the second visit you are
//     looking at a finished conversation and the thing you came to do is
//     behind a button.
//   * Leaving for another tab and coming back keeps you where you were. The
//     visibility handler re-reads storage — another tab may have written —
//     and storage knows nothing about drafts, so it used to answer "that chat
//     does not exist" and move you to the most recent conversation. You were
//     about to type into that blank chat.
//
// The second half of the same check matters as much: a *real* conversation
// must also survive the round trip, which is the part that already worked.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DIST = path.resolve('C:/Artificial_Intelligence/ollama-webui/dist');
const HTTP_PORT = 8241;
const CDP_PORT = 9541;
const browser = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
].find(p => p && fs.existsSync(p));


let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `
      ${detail}` : ''}`); }
};
const finish = (code) => {
  console.log(`
${pass} passed, ${fail} failed`);
  process.exit(code ?? (fail === 0 ? 0 : 1));
};
if (!browser) { console.log('SKIP  no Chrome or Edge found; the app was not started'); finish(0); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'testmodel:latest', size: 1e9, details: {} }] }));
    return;
  }
  if (/^\/(api|mcp|localfs|system|tts-api|kakao)\//.test(url.pathname)) { res.writeHead(503); res.end('{}'); return; }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-start-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
  if (!wsUrl) await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const res = (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result;
  if (res?.exceptionDetails) return 'THREW: ' + String(res.exceptionDetails.exception?.description || '').slice(0, 200);
  return res?.result?.value;
};

await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

// Two conversations already saved, one clearly more recent.
const sessions = [
  { id: 401, title: 'Older chat', createdAt: 1, updatedAt: 100, lastModel: 'm',
    messages: [{ role: 'user', content: 'old', at: 100 }] },
  { id: 402, title: 'Most recent chat', createdAt: 2, updatedAt: 900, lastModel: 'm',
    messages: [{ role: 'user', content: 'recent', at: 900 }] },
];
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    localStorage.setItem('ollama-sessions', ${JSON.stringify(JSON.stringify(sessions))});
    localStorage.setItem('ollama-sessions:last', '402');
  } catch (e) {}`,
});

const where = () => ev(`JSON.stringify({
  blank: !!document.querySelector('.claude-main.is-blank'),
  activeRow: (document.querySelector('.history-item.active .history-title')?.innerText || '').trim() || null,
  rows: [...document.querySelectorAll('.history-item .history-title')].map(r => r.innerText.trim()),
})`);

const settle = async () => { await sleep(6500);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent||'')); if (b) b.click(); })()`);
  await sleep(4500); };

const state = async () => JSON.parse(await where());

await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await settle();
let now = await state();
check('a first visit opens a new chat', now.blank, JSON.stringify(now));
check('and no conversation is selected', now.activeRow === null, String(now.activeRow));
check('while the saved ones are all still listed', now.rows.length === 2, JSON.stringify(now.rows));

await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(7000);
now = await state();
check('a refresh does the same', now.blank && now.activeRow === null, JSON.stringify(now));

/* The tab going away and coming back. Dispatched rather than simulated with a
   second window, because the listener under test is on `visibilitychange` and
   that is the event the browser sends. */
const leaveAndReturn = async () => {
  for (const value of ['hidden', 'visible']) {
    await ev(`(() => {
      Object.defineProperty(document, 'visibilityState', { value: '${value}', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    })()`);
    await sleep(value === 'hidden' ? 800 : 2500);
  }
};

await leaveAndReturn();
now = await state();
check('coming back from another tab keeps the blank chat', now.blank, JSON.stringify(now));
check('rather than jumping to the most recent conversation',
  now.activeRow === null, `landed on ${now.activeRow}`);

// The other half: a real conversation has to survive the same round trip, and
// it must be the one that was open rather than the newest.
await ev(`(() => {
  const row = [...document.querySelectorAll('.history-item')].find(r => (r.innerText||'').includes('Older chat'));
  (row.querySelector('.history-main') || row).click();
})()`);
await sleep(1500);
now = await state();
check('an older conversation opens', now.activeRow === 'Older chat', JSON.stringify(now));

await leaveAndReturn();
now = await state();
check('and coming back keeps it', now.activeRow === 'Older chat', `landed on ${now.activeRow}`);
check('not the most recent one', now.activeRow !== 'Most recent chat');

const stored = await ev(`new Promise(resolve => {
  const req = indexedDB.open('localforage');
  req.onerror = () => resolve('no db');
  req.onsuccess = () => {
    const db = req.result;
    const get = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get('ollama-sessions');
    get.onerror = () => resolve('no key');
    get.onsuccess = () => resolve(JSON.stringify((get.result || []).map(c => c.title)));
  };
})`);
check('and none of those visits wrote a chat', JSON.parse(stored).length === 2, stored);

try { child.kill(); } catch {}
try { server.close(); } catch {}
finish();
