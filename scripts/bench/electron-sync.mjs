// Real-data bench: the Windows desktop client (Electron) against a server.
//
//   node scripts/bench/electron-sync.mjs --server http://127.0.0.1:8290 --token <session>
//
// Runs the repo's native/desktop app with its own profile (--user-data-dir) (so the installed
// client, its settings and its data are untouched), points it at the server,
// signs in with the session cookie, and measures the first account sync inside
// the real app: time, chats stored per-chat, heap, worst stall, exceptions.
// Then sends a message and checks the server received it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const SERVER = arg('server', 'http://127.0.0.1:8290');
const TOKEN = arg('token', '');
const CDP = Number(arg('cdp', 9720));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[electron]', ...a);
const out = {};

const desktop = path.resolve(HERE, '../../native/desktop');
const exe = path.join(desktop, 'node_modules/electron/dist/electron.exe');
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-electron-bench-'));
const userData = path.join(appData, 'ollama-webui-client');
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, 'connection.json'), JSON.stringify({ server: SERVER, ports: {}, recent: [SERVER], zoom: {}, alwaysOnTop: false, closeToTray: false, globalShortcut: false }));
// --user-data-dir, not APPDATA: Electron asks Windows for the Roaming folder
// directly, so APPDATA alone would open the installed client's own profile.
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, [desktop, `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP}`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
let stdout = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stdout += b; });
const finish = (code) => {
  try { child.kill(); } catch {}
  setTimeout(() => { try { fs.rmSync(appData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
    console.log('RESULT ' + JSON.stringify(out)); process.exit(code); }, 2500);
};

try {
  // The client window: the page served through the app's local gateway.
  let target;
  for (let i = 0; i < 160 && !target; i++) {
    await sleep(500);
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url) && !t.url.startsWith(SERVER)); } catch {}
  }
  if (!target) throw new Error('the client window never opened: ' + stdout.slice(-400));
  out.gateway = new URL(target.url).origin;
  log('client window at', out.gateway, '(proxied to', SERVER + ')');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const thrown = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0].slice(0, 200));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Network.enable'); await send('Performance.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__lag = 0; let last = performance.now();
    setInterval(() => { const now = performance.now(), lag = now - last - 50; last = now; if (lag > window.__lag) window.__lag = lag; }, 50); })();` });
  out.native = await ev(`window.ollamaNative?.platform || ''`);
  await send('Network.setCookie', { name: 'webui_session', value: TOKEN, domain: '127.0.0.1', path: '/', httpOnly: true });
  const t0 = Date.now();
  await send('Page.reload');
  let done = false, maxHeap = 0, last = '';
  while (Date.now() - t0 < 15 * 60000) {
    await sleep(2000);
    let s;
    try {
      s = await ev(`(() => { const k = Object.keys(localStorage); return { pend: k.filter(x => x.startsWith('initialSyncPending@')).map(x => localStorage.getItem(x)),
        rev: Math.max(0, ...k.filter(x => x.startsWith('syncRev@')).map(x => Number(localStorage.getItem(x)) || 0)) }; })()`);
      maxHeap = Math.max(maxHeap, Math.round((await send('Performance.getMetrics')).result.metrics.find(m => m.name === 'JSHeapUsedSize').value / 1e6));
    } catch (e) { s = { err: String(e).slice(0, 60) }; }
    const line = JSON.stringify(s); if (line !== last) { last = line; log(Math.round((Date.now() - t0) / 1000) + 's', line); }
    if (s.pend?.length && s.pend.every(v => v === '0') && s.rev > 0) { done = true; break; }
  }
  out.firstSync = { done, secs: Math.round((Date.now() - t0) / 1000), maxHeapMB: maxHeap };
  await sleep(8000);
  out.firstSync.worstStallMs = Math.round(await ev('window.__lag'));
  out.stored = await ev(`(async () => { const db = await new Promise(r => { const q = indexedDB.open('ollama-webui-chats'); q.onsuccess = () => r(q.result); });
    let n = 0; if (db.objectStoreNames.contains('chats')) await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor();
      q.onsuccess = () => { const c = q.result; if (!c) return r(); if (String(c.key).includes('\\u0001')) n++; c.continue(); }; }); db.close(); return n; })()`);
  log('first sync', JSON.stringify(out.firstSync), 'chats stored per-chat', out.stored);

  const marker = `ElectronProbe ${Date.now()}`;
  await ev(`(async () => { const box = document.querySelector('.chat-input textarea, textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    box.focus(); set.call(box, ${JSON.stringify(marker)}); box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200)); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); })()`);
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    await sleep(2000);
    const page = await fetch(`${SERVER}/api/auth/sync?since=${(await ev(`Math.max(0, ...Object.keys(localStorage).filter(x => x.startsWith('syncRev@')).map(x => Number(localStorage.getItem(x)) || 0))`)) - 20}`, { headers: { Cookie: `webui_session=${TOKEN}` } }).then(r => r.text()).catch(() => '');
    up = page.includes('ElectronProbe');
  }
  out.uploaded = up;
  log('message from the desktop app reached the server', up);
  out.exceptions = thrown.slice(0, 5);
  log('exceptions', thrown.length, JSON.stringify(out.exceptions));
  ws.close();
  finish(0);
} catch (e) { out.error = String(e.stack || e); log('ERROR', out.error); finish(1); }
