// Real-data bench, step 3: one build, one seeded account, a real browser.
//
//   node scripts/bench/browser-bench.mjs --dist <dir> --data <chats.json> [--label x]
//        [--profile out.cpuprofile] [--mobile] [--sends 3] [--port 8270]
//
// Seeds the chats in the old single-value layout (what every install has
// before the per-chat store), boots, reboots, then sends messages and reports
// per send: IndexedDB bytes written, main-thread busy time (CDP TaskDuration),
// script time, worst event-loop stall (a 50 ms probe; background throttling is
// switched off so the probe means something), and long tasks.
// --mobile emulates a phone viewport with 4x CPU slowdown.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const DIST = path.resolve(arg('dist', path.join(HERE, '../../dist')));
const DATA = path.resolve(arg('data', ''));
const LABEL = arg('label', 'build');
const PROFILE = arg('profile', '');
const MOBILE = flag('mobile');
const SENDS = Number(arg('sends', 3));
const HTTP_PORT = Number(arg('port', 8270)), CDP_PORT = HTTP_PORT + 1000;
const ORIGIN = `http://127.0.0.1:${HTTP_PORT}`;
const KEY = 'ollama-sessions';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = { label: LABEL, mobile: MOBILE };
const log = (...a) => console.log(`[${LABEL}]`, ...a);

const browser = [process.env.SMOKE_BROWSER, `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`].find(p => p && fs.existsSync(p));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__seed') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>seed</title>'); }
  if (url.pathname === '/__data') { res.writeHead(200, { 'Content-Type': 'application/json' }); return fs.createReadStream(DATA).pipe(res); }
  if (/^\/(api|mcp|localfs|system|tts-api|kakao|studio|v1)\//.test(url.pathname)) { res.writeHead(503); return res.end('{}'); }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));
const { launchChrome } = await import(pathToFileURL(path.join(HERE, '../chromeProfile.mjs')).href);
const chrome = launchChrome(browser, `webui-bench-${LABEL}-`, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`,
  '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  `--js-flags=--max-old-space-size=${process.env.BENCH_HEAP_MB || 8192}`]);
const finish = (code = 0) => { try { server.close(); } catch {} try { chrome.close(); } catch {} console.log('RESULT ' + JSON.stringify(out)); process.exit(code); };

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(250); }
const ws = new WebSocket(wsUrl); await new Promise(r => { ws.onopen = r; });
let id = 0; const pending = new Map(); const thrown = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0]);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
const metric = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable');
await send('Emulation.setDeviceMetricsOverride', MOBILE ? { width: 412, height: 915, deviceScaleFactor: 2, mobile: true } : { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  if (location.pathname === '/__seed') return;
  window.__m = { puts: 0, putBytes: 0, long: [], lagMax: 0, t0: performance.now() };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (v, k) { window.__m.puts++; try { const s = JSON.stringify(v); window.__m.putBytes += s ? s.length : 0; } catch {} return put.apply(this, arguments); };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__m.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let last = performance.now();
  setInterval(() => { const now = performance.now(), lag = now - last - 50; last = now; if (lag > window.__m.lagMax) window.__m.lagMax = lag; }, 50);
  window.__reset = () => { const m = window.__m; m.puts = 0; m.putBytes = 0; m.long = []; m.lagMax = 0; m.t0 = performance.now(); };
  window.__read = () => { const m = window.__m; const long = m.long.filter(([s]) => s >= m.t0);
    return { puts: m.puts, putMB: +(m.putBytes / 1e6).toFixed(2), longTasks: long.length, longMs: Math.round(long.reduce((n, [, d]) => n + d, 0)),
      worstStallMs: Math.round(m.lagMax) }; };
})();` });

const sidebarCount = `document.querySelectorAll('.history-item').length * 1000`;
const guest = `(() => { const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || '')); if (b) { b.click(); return true; } return false; })()`;

try {
  await send('Page.navigate', { url: `${ORIGIN}/__seed` }); await sleep(1500);
  out.seeded = await ev(`(async () => {
    for (const n of ['ollama-webui-chats', 'localforage']) await new Promise(r => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = r; });
    const list = await (await fetch('/__data')).json();
    const db = await new Promise((res, rej) => { const q = indexedDB.open('localforage', 1); q.onupgradeneeded = () => { q.result.createObjectStore('keyvaluepairs'); q.result.createObjectStore('local-forage-detect-blob-support'); }; q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    await new Promise((res, rej) => { const t = db.transaction('keyvaluepairs', 'readwrite'); t.objectStore('keyvaluepairs').put(list, '${KEY}'); t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close(); return list.length;
  })()`);
  log('seeded chats', out.seeded);
  if (MOBILE) await send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const boot = async (name) => {
    const t = Date.now(); const before = await metric().catch(() => ({}));
    await send('Page.navigate', { url: `${ORIGIN}/` });
    let entered = false, shown = 0;
    for (let i = 0; i < 1200; i++) {
      await sleep(250);
      try { if (!entered) entered = await ev(guest); if ((await ev(sidebarCount)) > 5000) { shown = Date.now() - t; break; } } catch {}
    }
    await sleep(MOBILE ? 30000 : 15000);
    const after = await metric();
    out[name] = { chatsVisibleMs: shown, ...(await ev('window.__read()')), heapMB: Math.round(after.JSHeapUsedSize / 1e6) };
    log(name, JSON.stringify(out[name]));
  };
  await boot('firstBoot');
  await boot('secondBoot');

  if (flag('layout')) {
    out.layout = await ev(`(async () => {
      const t = () => { const a = performance.now(); document.documentElement.classList.toggle('__probe'); void document.body.offsetHeight; return performance.now() - a; };
      const avg = () => { let n = 0; for (let i = 0; i < 6; i++) n += t(); return Math.round(n / 6 * 10) / 10; };
      const side = document.querySelector('.claude-sidebar');
      const r = { nodes: document.getElementsByTagName('*').length, sidebarNodes: side ? side.getElementsByTagName('*').length : 0,
        rows: document.querySelectorAll('.history-item').length, msgNodes: (document.querySelector('.messages-wrapper') || document.body).getElementsByTagName('*').length };
      r.layoutMs = avg();
      if (side) { side.style.display = 'none'; r.layoutNoSidebarMs = avg(); side.style.display = ''; }
      return r; })()`);
    log('layout', JSON.stringify(out.layout));
  }
  if (PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 }); await send('Profiler.start'); }
  const sends = [];
  for (let i = 0; i < SENDS; i++) {
    await ev('window.__reset()');
    const before = await metric();
    await ev(`(async () => { const box = document.querySelector('.chat-input textarea, textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      box.focus(); set.call(box, 'Benchmark message ${i}'); box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200)); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); })()`);
    await sleep(MOBILE ? 20000 : 10000);
    const after = await metric();
    sends.push({ ...(await ev('window.__read()')), mainThreadMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
      scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000), heapMB: Math.round(after.JSHeapUsedSize / 1e6) });
    log('send', i, JSON.stringify(sends[i]));
  }
  out.sends = sends;
  if (PROFILE) { const { result } = await send('Profiler.stop'); fs.writeFileSync(PROFILE, JSON.stringify(result.profile)); log('profile ->', PROFILE); }

  out.stored = await ev(`(async () => {
    const open = n => new Promise(r => { const q = indexedDB.open(n); q.onsuccess = () => r(q.result); q.onerror = () => r(null); });
    const count = async (n, store, test) => { const db = await open(n); if (!db || !db.objectStoreNames.contains(store)) return 0; let c = 0;
      await new Promise(r => { const q = db.transaction(store).objectStore(store).openCursor(); q.onsuccess = () => { const x = q.result; if (!x) return r(); if (test(x.key)) c += Array.isArray(x.value) ? x.value.length : 1; x.continue(); }; });
      db.close(); return c; };
    return { split: await count('ollama-webui-chats', 'chats', k => String(k).startsWith('${KEY}\\u0001')), legacy: await count('localforage', 'keyvaluepairs', k => k === '${KEY}') };
  })()`);
  out.exceptions = thrown.slice(0, 5);
  log('stored', JSON.stringify(out.stored), 'exceptions', thrown.length);
  finish(0);
} catch (e) { out.error = String(e.stack || e); finish(1); }
