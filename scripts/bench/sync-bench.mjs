// Real-data bench: the account sync against a real server (run on a snapshot).
//
//   node scripts/bench/sync-bench.mjs --origin http://127.0.0.1:8290 --token <session> [--label x] [--mobile] [--second]
//
// A fresh browser profile signs in with the session cookie and does a first
// sync of the whole account. Reports time to completion, chats stored, heap,
// worst main-thread stall and exceptions. Then sends a message (an upload),
// and with --second opens another fresh profile that must receive it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const ORIGIN = arg('origin', 'http://127.0.0.1:8290');
const TOKEN = arg('token', '');
// Each device its own sign-in, as in real use: a device ignores account events
// stamped with its own session, so two devices on one session never hear each other.
const TOKEN2 = arg('token2', TOKEN);
const LABEL = arg('label', 'sync');
const MOBILE = flag('mobile');
const BASE_PORT = Number(arg('cdp', 9600));
const LIMIT_MIN = Number(arg('minutes', 30));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${LABEL}]`, ...a);
const out = { label: LABEL, mobile: MOBILE };

const browser = [process.env.SMOKE_BROWSER, `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`].find(p => p && fs.existsSync(p));
const { launchChrome } = await import(pathToFileURL(path.join(HERE, '../chromeProfile.mjs')).href);
const host = new URL(ORIGIN).hostname;

const INSTRUMENT = `(() => {
  window.__m = { lagMax: 0, puts: 0, putBytes: 0 };
  let last = performance.now();
  setInterval(() => { const now = performance.now(), lag = now - last - 50; last = now; if (lag > window.__m.lagMax) window.__m.lagMax = lag; }, 50);
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { window.__m.puts++; try { const s = JSON.stringify(v); const n = s ? s.length : 0; window.__m.putBytes += n; const key = this.transaction.db.name + '/' + this.name + '/' + String(k).replace(/[\u0001].*$/, '*').slice(0, 40); (window.__m.by ||= {})[key] = ((window.__m.by[key] || 0) + n); } catch {} return put.apply(this, arguments); };
})();`;

const openDevice = async (name, port, token = TOKEN) => {
  const chrome = launchChrome(browser, `webui-sync-${LABEL}-${name}-`, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`,
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--js-flags=--max-old-space-size=${process.env.BENCH_HEAP_MB || 8192}`]);
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(250); }
  const ws = new WebSocket(wsUrl); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const thrown = []; const consoleErr = []; const crashes = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    // Like the Android app (MainActivity onRenderProcessGone): a dead page is opened again.
    if (m.method === 'Inspector.targetCrashed') { crashes.push(Date.now()); setTimeout(() => send('Page.reload').catch(() => {}), 500); }
    if (m.method === 'Runtime.exceptionThrown') thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0].slice(0, 200));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErr.push(m.params.args.map(a => a.value || a.description).join(' ').slice(0, 200));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable'); await send('Network.enable'); await send('Inspector.enable');
  await send('Emulation.setDeviceMetricsOverride', MOBILE ? { width: 412, height: 915, deviceScaleFactor: 2, mobile: true } : { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  if (MOBILE) { await send('Emulation.setCPUThrottlingRate', { rate: 4 }); await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }); }
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await send('Network.setCookie', { name: 'webui_session', value: token, domain: host, path: '/', httpOnly: true });
  const heap = async () => Math.round((await send('Performance.getMetrics')).result.metrics.find(m => m.name === 'JSHeapUsedSize').value / 1e6);
  return { name, send, ev, thrown, consoleErr, crashes, heap, close: () => { try { ws.close(); } catch {} chrome.close(); } };
};

/* Where the first sync stands, from the app's own bookkeeping. */
const STATE = `(() => { const keys = Object.keys(localStorage);
  const pend = keys.filter(k => k.startsWith('initialSyncPending@')).map(k => [k.slice(19), localStorage.getItem(k)]);
  const rev = keys.filter(k => k.startsWith('syncRev@')).map(k => Number(localStorage.getItem(k)) || 0);
  const bar = document.querySelector('[class*="initial-sync"], [class*="boot-sync"], [class*="first-sync"]');
  return { pend, rev: Math.max(0, ...rev), bar: bar ? (bar.innerText || '').replace(/\\s+/g, ' ').slice(0, 120) : '', lag: Math.round(window.__m?.lagMax || 0), putMB: +((window.__m?.putBytes || 0) / 1e6).toFixed(0) }; })()`;
const COUNT = `(async () => { const open = n => new Promise(r => { const q = indexedDB.open(n); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
  const db = await open('ollama-webui-chats'); let split = 0;
  if (db && db.objectStoreNames.contains('chats')) await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor(); q.onsuccess = () => { const c = q.result; if (!c) return r(); if (String(c.key).includes('\\u0001')) split++; c.continue(); }; });
  db?.close(); let legacy = 0; const lf = await open('localforage');
  if (lf && lf.objectStoreNames.contains('keyvaluepairs')) await new Promise(r => { const q = lf.transaction('keyvaluepairs').objectStore('keyvaluepairs').openCursor(); q.onsuccess = () => { const c = q.result; if (!c) return r(); if (/^ollama-sessions/.test(String(c.key)) && Array.isArray(c.value)) legacy += c.value.length; c.continue(); }; });
  lf?.close(); return { split, legacy }; })()`;

const firstSync = async (dev) => {
  const t0 = Date.now(); let maxHeap = 0, last = '', done = false, stage = [];
  await dev.send('Page.navigate', { url: `${ORIGIN}/` });
  while (Date.now() - t0 < LIMIT_MIN * 60000) {
    await sleep(2000);
    let s; try { s = await dev.ev(STATE); maxHeap = Math.max(maxHeap, await dev.heap()); } catch (e) { s = { err: String(e).slice(0, 80) }; }
    const line = JSON.stringify(s);
    if (line !== last) { last = line; stage.push(`${Math.round((Date.now() - t0) / 1000)}s ${line}`); }
    if (s.pend?.length && s.pend.every(([, v]) => v === '0') && s.rev > 0) { done = true; break; }
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  await sleep(8000);
  const counts = await dev.ev(COUNT).catch(e => ({ err: String(e) }));
  const final = await dev.ev(STATE).catch(() => ({}));
  const by = await dev.ev(`Object.entries(window.__m.by || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => k + ' ' + Math.round(n / 1e6) + 'MB')`).catch(() => []);
  log(dev.name, 'writes by target', JSON.stringify(by));
  return { done, secs, crashes: dev.crashes.length, maxHeapMB: maxHeap, worstStallMs: final.lag, putMB: final.putMB, counts, timeline: stage.slice(-12) };
};

const sendMessage = (dev, text) => dev.ev(`(async () => { const box = document.querySelector('.chat-input textarea, textarea'); if (!box) return 'no box';
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  box.focus(); set.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200)); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); return 'sent'; })()`);

let a, b;
try {
  a = await openDevice('A', BASE_PORT);
  out.first = await firstSync(a);
  log('first sync', JSON.stringify(out.first, null, 1));

  const marker = `SyncProbe ${LABEL} ${Date.now()}`;
  out.sent = await sendMessage(a, marker);
  await sleep(15000);
  const res = await fetch(`${ORIGIN}/api/auth/records/search?q=${encodeURIComponent(marker.split(' ').slice(0, 3).join(' '))}`, { headers: { Cookie: `webui_session=${TOKEN}` } }).then(r => r.json()).catch(e => ({ error: String(e) }));
  out.uploaded = JSON.stringify(res).includes(marker);
  log('message uploaded to server', out.uploaded);

  if (flag('second')) {
    b = await openDevice('B', BASE_PORT + 1, TOKEN2);
    out.second = await firstSync(b);
    log('second device first sync', JSON.stringify({ ...out.second, timeline: undefined }));
    // In storage, not by the sidebar's text: the chat's title is generated
    // after its first reply and no longer says what it was started with.
    out.secondHasIt = await b.ev(`(async () => { const db = await new Promise(r => { const q = indexedDB.open('ollama-webui-chats'); q.onsuccess = () => r(q.result); });
      let hit = false; if (db.objectStoreNames.contains('chats')) await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return r(); if (JSON.stringify(c.value).includes(${JSON.stringify(marker)})) hit = true; c.continue(); }; });
      db.close(); return hit; })()`);
    log('second device has the message', out.secondHasIt);
    // And live: A sends again, B must get it without a reload.
    const live = `LiveProbe ${Date.now()}`;
    await sendMessage(a, live);
    let got = false;
    for (let i = 0; i < 30 && !got; i++) { await sleep(2000); got = await b.ev(`(async () => { const db = await new Promise(r => { const q = indexedDB.open('ollama-webui-chats'); q.onsuccess = () => r(q.result); });
      let hit = false; if (db.objectStoreNames.contains('chats')) await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return r(); if (JSON.stringify(c.value).includes('LiveProbe')) hit = true; c.continue(); }; });
      db.close(); return hit; })()`); }
    // On screen, not just stored: scripts/bench/live-latency.mjs measures that,
    // finding the row by the chat's stored title.
    out.liveToSecond = got;
    log('live update reached the second device', got);
  }
  out.exceptions = [...a.thrown, ...(b?.thrown || [])].slice(0, 6);
  out.consoleErrors = [...a.consoleErr, ...(b?.consoleErr || [])].filter(x => /sync|storage|quota|memory/i.test(x)).slice(0, 6);
  log('exceptions', out.exceptions.length, JSON.stringify(out.exceptions), 'sync-related console errors', JSON.stringify(out.consoleErrors));
} catch (e) { out.error = String(e.stack || e); log('ERROR', out.error); }
a?.close(); b?.close();
console.log('RESULT ' + JSON.stringify({ ...out, first: out.first && { ...out.first, timeline: undefined }, second: out.second && { ...out.second, timeline: undefined } }));
process.exit(out.error ? 1 : 0);
