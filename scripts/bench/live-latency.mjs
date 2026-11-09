// Real-data bench: how fast one device's message reaches another's SCREEN.
//
//   node scripts/bench/live-latency.mjs --origin http://127.0.0.1:8292 --token <A> --token2 <B>
//
// Two separate browsers (two devices), each with its own session, both fully
// synced first. Then:
//   1. A starts a new chat           -> ms until it is in B's sidebar (B visible)
//   2. B opens it; A sends 3 times   -> ms until each is on B's screen (B visible)
//   3. B is hidden (another tab in front); A sends; B is brought back
//                                    -> ms from becoming visible to on screen
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ORIGIN = arg('origin', 'http://127.0.0.1:8292');
const TOKENS = [arg('token', ''), arg('token2', '')];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[live]', ...a);
const out = {};
const browser = [process.env.SMOKE_BROWSER, `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`].find(p => p && fs.existsSync(p));
const { launchChrome } = await import(pathToFileURL(path.join(HERE, '../chromeProfile.mjs')).href);
const host = new URL(ORIGIN).hostname;

const connect = async (wsUrl) => {
  const ws = new WebSocket(wsUrl); await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const thrown = []; const logs = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`${m.params.type}: ${m.params.args.map(x => x.value ?? x.description ?? '').join(' ')}`.slice(0, 220));
    if (m.method === 'Runtime.exceptionThrown') thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0].slice(0, 200));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  return { ws, send, ev, thrown, logs };
};
const device = async (name, port, token) => {
  const chrome = launchChrome(browser, `webui-sync-live-${name}-`, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-extensions',
    `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--js-flags=--max-old-space-size=8192']);
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(250); }
  const page = await connect(wsUrl);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send('Network.setCookie', { name: 'webui_session', value: token, domain: host, path: '/', httpOnly: true });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__syncLog = []; const f = window.fetch;
    window.fetch = async function (input, init) { const url = String(input?.url || input); const res = await f.apply(this, arguments);
      if (url.includes('/api/auth/sync') && !url.includes('/blob')) { let since = null; try { since = init?.body ? JSON.parse(init.body).since : Number(new URL(url, location.href).searchParams.get('since')); } catch {}
        res.clone().json().then(j => window.__syncLog.push({ t: Date.now(), m: init?.method || 'GET', since, rev: j.rev, reset: !!j.resetRequired, floor: j.floor, n: (j.records || []).length, complete: j.complete })).catch(() => {}); }
      return res; }; })();` });
  return { name, port, chrome, ...page };
};
const synced = async (d) => {
  await d.send('Page.navigate', { url: `${ORIGIN}/` });
  for (let i = 0; i < 600; i++) {
    await sleep(2000);
    try {
      const ok = await d.ev(`(() => { const k = Object.keys(localStorage); const p = k.filter(x => x.startsWith('initialSyncPending@')).map(x => localStorage.getItem(x));
        return p.length > 0 && p.every(v => v === '0') && document.querySelectorAll('.history-item').length > 0; })()`);
      if (ok) return true;
    } catch {}
  }
  return false;
};
const say = (d, text) => d.ev(`(async () => { const box = document.querySelector('.chat-input'); if (!box) return 'no box';
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  box.focus(); set.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150)); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 600));
  return JSON.stringify({ left: box.value.slice(0, 30), disabled: box.disabled, queued: (document.querySelector('[class*="queue"]')?.textContent || '').slice(0, 60),
    toast: (document.querySelector('[class*="toast"], [role="alert"], [role="status"]')?.textContent || '').slice(0, 100),
    stop: [...document.querySelectorAll('button')].filter(b => /stop|중지|정지/i.test((b.getAttribute('aria-label') || '') + b.title + b.className)).map(b => b.className).slice(0, 3) }); })()`);
/* Polls B's screen; returns ms from `t0` until `test` is true, or null. */
const until = async (d, test, t0, limitMs = 30000) => {
  while (Date.now() - t0 < limitMs) {
    try { if (await d.ev(test)) return Date.now() - t0; } catch {}
    await sleep(100);
  }
  return null;
};
/* The sidebar row of the chat that holds `text`, found by the chat's stored
   title -- its title is generated after the first reply, so the text the chat
   was started with is not what the row says. */
const rowOf = (text) => `(async () => { const db = await new Promise(r => { const q = indexedDB.open('ollama-webui-chats'); q.onsuccess = () => r(q.result); });
  let title = null; if (db.objectStoreNames.contains('chats')) await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor();
    q.onsuccess = () => { const c = q.result; if (!c) return r(); if (title == null && String(c.key).includes('\u0001') && JSON.stringify(c.value).includes(${JSON.stringify('__T__')})) title = c.value.title; c.continue(); }; });
  db.close(); if (title == null) return null;
  return [...document.querySelectorAll('.history-item')].find(r => r.querySelector('.history-title')?.textContent === title) || null; })()`.replace('"__T__"', JSON.stringify(text));
const inSidebarById = (text) => rowOf(text).replace(/return \[\.\.\.document[\s\S]*\| null; \}\)\(\)$/, "return [...document.querySelectorAll('.history-item')].some(r => r.querySelector('.history-title')?.textContent === title); })()");
const inSidebar = (text) => `[...document.querySelectorAll('.history-item')].some(r => r.textContent.includes(${JSON.stringify(text)}))`;
const onScreen = (text) => `!!document.querySelector('.messages-scroll-area') && document.querySelector('.messages-scroll-area').textContent.includes(${JSON.stringify(text)})`;

let A, B;
try {
  [A, B] = await Promise.all([device('A', 9741, TOKENS[0]), device('B', 9742, TOKENS[1])]);
  const [okA, okB] = await Promise.all([synced(A), synced(B)]);
  log('both synced', okA, okB);
  out.recoveryToast = { A: await A.ev(`document.body.textContent.includes('복구 사본')`), B: await B.ev(`document.body.textContent.includes('복구 사본')`) };
  log('recovery notice shown on a brand-new device:', JSON.stringify(out.recoveryToast));
  out.recoveryCopies = await A.ev(`(async () => { const db = await new Promise(r => { const q = indexedDB.open('localforage'); q.onsuccess = () => r(q.result); });
    const found = []; await new Promise(r => { const q = db.transaction('keyvaluepairs').objectStore('keyvaluepairs').openCursor();
      q.onsuccess = () => { const c = q.result; if (!c) return r(); if (String(c.key).startsWith('sync-recovery:')) found.push((c.value.records || []).map(x => x.kind + ':' + String(x.id).slice(0, 30) + '@' + x.updatedAt)); c.continue(); }; });
    db.close(); return found; })()`);
  log('recovery copies on A:', JSON.stringify(out.recoveryCopies).slice(0, 600));
  if (process.argv.includes('--recovery-only')) {
    const mark = Date.now();
    await say(A, `RecoverySeed${Date.now()}`);
    await sleep(15000);
    const logA = await A.ev(`JSON.stringify(window.__syncLog.filter(x => x.t >= ${mark} - 3000).slice(0, 12))`);
    log('A sync requests (last 30):', logA);
    out.recoveryAfterSend = await A.ev(`document.body.textContent.includes('복구 사본')`);
    log('recovery notice after the first send:', out.recoveryAfterSend, 'mark', mark);
    throw Object.assign(new Error('stop'), { stop: true });
  }
  out.visibility = { A: await A.ev('document.visibilityState'), B: await B.ev('document.visibilityState') };

  const seed = `LiveSeed${Date.now()}`;
  let t0 = Date.now(); await say(A, seed);
  out.newChatToSidebarMs = await until(B, inSidebarById(seed), t0);
  log('new chat in B sidebar after', out.newChatToSidebarMs, 'ms');

  out.opened = await B.ev(rowOf(seed).replace(/\|\| null; \}\)\(\)$/, '|| null; })().then(r => { r?.click(); return !!r; })'));
  log('B opened the chat:', out.opened);
  await sleep(1500);
  if (process.argv.includes('--debug-b')) {
    const probe = `DebugProbe${Date.now()}`;
    await say(A, probe); await sleep(6000);
    log('B stored seed chat:', await B.ev(`(async () => { const db = await new Promise(r => { const q = indexedDB.open('ollama-webui-chats'); q.onsuccess = () => r(q.result); });
      let hit = null; await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return r(); const v = c.value; if (!hit && JSON.stringify(v).includes(${JSON.stringify(seed)})) hit = { key: String(c.key).replace(//, ' | '), id: v.id, title: v.title, updatedAt: v.updatedAt, archived: v.archived, folderId: v.folderId, pinned: v.pinned, draft: v.draft, n: v.messages?.length, keys: Object.keys(v).join(',') }; c.continue(); }; });
      db.close(); return JSON.stringify(hit); })()`));
    log('A sidebar has seed', await A.ev(inSidebar(seed)), '| B group labels', await B.ev(`[...document.querySelectorAll('.recents-label, .folder-name')].map(x => x.textContent).join(' / ')`));
    log('B first rows', await B.ev(`[...document.querySelectorAll('.history-item .history-title')].slice(0, 6).map(x => x.textContent).join(' | ')`));
    log('B rows', await B.ev(`document.querySelectorAll('.history-item').length`), 'seed in sidebar', await B.ev(inSidebar(seed)), 'probe on screen', await B.ev(onScreen(probe)));
    await B.ev(`document.dispatchEvent(new Event('visibilitychange'))`); await sleep(2500);
    log('after visibilitychange: seed in sidebar', await B.ev(inSidebar(seed)), 'probe on screen', await B.ev(onScreen(probe)));
    log('B console (last 25):', JSON.stringify(B.logs.slice(-25), null, 1));
    throw Object.assign(new Error('stop'), { stop: true });
  }
  out.visibleMs = []; out.stages = [];
  const revNow = async () => (await fetch(`${ORIGIN}/api/auth/stats?rev=1`, { headers: { Cookie: `webui_session=${TOKENS[0]}` } }).then(r => r.json()).catch(() => ({}))).rev || 0;
  let rev0 = 0;
  const onServer = async (text) => (await fetch(`${ORIGIN}/api/auth/sync?since=${rev0}`, { headers: { Cookie: `webui_session=${TOKENS[0]}` } }).then(r => r.text()).catch(() => '')).includes(text);
  const inStore = (text) => `(async () => { const db = await new Promise(r => { const q = indexedDB.open('ollama-webui-chats'); q.onsuccess = () => r(q.result); });
    let hit = false; await new Promise(r => { const q = db.transaction('chats').objectStore('chats').openCursor();
      q.onsuccess = () => { const c = q.result; if (!c) return r(); if (!hit && JSON.stringify(c.value).includes(${JSON.stringify('__T__')})) hit = true; c.continue(); }; });
    db.close(); return hit; })()`.replace('"__T__"', JSON.stringify(text));
  for (let i = 0; i < 3; i++) {
    const probe = `LiveProbe${i}x${Date.now()}`;
    rev0 = await revNow();
    const aBusy = await A.ev(`!!document.querySelector('.stop-btn, .stop-button, button[aria-label*="중지"], button[aria-label*="Stop"]')`).catch(() => null);
    t0 = Date.now(); const said = await say(A, probe); log('A send ->', said);
    const st = { aBusyBefore: aBusy, aScreen: null, server: null, bStore: null, bScreen: null };
    while (Date.now() - t0 < 30000 && st.bScreen == null) {
      if (st.aScreen == null && await A.ev(onScreen(probe)).catch(() => false)) st.aScreen = Date.now() - t0;
      if (st.server == null && await onServer(probe)) st.server = Date.now() - t0;
      if (st.bStore == null && await B.ev(inStore(probe)).catch(() => false)) st.bStore = Date.now() - t0;
      if (await B.ev(onScreen(probe)).catch(() => false)) st.bScreen = Date.now() - t0;
      await sleep(150);
    }
    st.aGenerating = await A.ev(`!!document.querySelector('.stop-btn, [aria-label*="Stop"], .spin.row-generating')`).catch(() => null);
    st.bRev = await B.ev(`Math.max(0, ...Object.keys(localStorage).filter(x => x.startsWith('syncRev@')).map(x => Number(localStorage.getItem(x)) || 0))`).catch(() => null);
    st.serverRev = await revNow();
    out.stages.push(st); out.visibleMs.push(st.bScreen);
    log(`message ${i}: A screen ${st.aScreen} ms, server ${st.server} ms, B storage ${st.bStore} ms, B screen ${st.bScreen} ms | B rev ${st.bRev} / server ${st.serverRev}`);
    await sleep(3000);
  }

  // Hide B: another tab in its browser comes to the front.
  const other = await (await fetch(`http://127.0.0.1:${B.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const otherTab = await connect(other.webSocketDebuggerUrl); await otherTab.send('Page.bringToFront'); await sleep(800);
  out.hiddenState = await B.ev('document.visibilityState');
  const hidden = `HiddenProbe${Date.now()}`;
  await say(A, hidden);
  await sleep(10000);
  out.shownWhileHidden = await B.ev(onScreen(hidden));
  t0 = Date.now();
  await B.send('Page.bringToFront');
  out.afterShowMs = await until(B, onScreen(hidden), t0);
  log('B hidden:', out.hiddenState, '| already drawn while hidden:', out.shownWhileHidden, '| on screen', out.afterShowMs, 'ms after B was shown');
  otherTab.ws.close();
  out.exceptions = [...A.thrown, ...B.thrown].slice(0, 5);
  log('exceptions', out.exceptions.length, JSON.stringify(out.exceptions));
} catch (e) { if (!e.stop) { out.error = String(e.stack || e); log('ERROR', out.error); } }
for (const d of [A, B]) { try { d.ws.close(); d.chrome.close(); } catch {} }
console.log('RESULT ' + JSON.stringify(out));
process.exit(out.error ? 1 : 0);
