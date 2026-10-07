// How a reply streams into a long conversation on a phone.
//
// Reported: once a chat is long, the mobile app stops showing the answer as it
// arrives -- it appears all at once at the end, and the app stutters. This
// opens the app at phone size with the CPU slowed to a phone's, puts a long
// conversation in storage, has a fake model answer at 40 tokens a second, and
// measures two things while it streams:
//
//   updates  how many times the answer on screen changed (sampled every 50 ms)
//   blocked  how long the main thread was busy in tasks over 50 ms
//
// `node scripts/stream-perf.mjs [messages] [cpu-slowdown]`
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, process.env.PERF_DIST || 'dist');
const HTTP_PORT = 8197;
const CDP_PORT = 9497;
const MESSAGES = Number(process.argv[2]) || 80;
const SLOWDOWN = Number(process.argv[3]) || 4;
const TOKENS = 400, RATE = 40;

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) { console.log('SKIP  no Chrome or Edge'); process.exit(0); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const MODELS = [{ name: 'qwen3.6:35b-a3b', size: 22_621_314_381, details: { parameter_size: '35.5B', quantization_level: 'Q4_K_M' } }];

const WORDS = '이 문장은 스트리밍 성능을 재기 위한 답변의 일부입니다. 모델이 토큰을 하나씩 보냅니다. '.split(' ');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/tags') return json({ models: MODELS });
  if (url.pathname === '/api/ps') return json({ models: [] });
  if (url.pathname === '/api/auth/session') return json({ success: true, user: null, sessionId: null, csrfToken: null, state: null, anyAccounts: false, accounts: [], session: null });
  if (url.pathname === '/api/config') return json({ success: true, canonicalOrigin: '' });
  if (req.method === 'POST') console.log('POST', url.pathname);
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d); req.on('end', () => { try { const b = JSON.parse(body); console.log('chat body', JSON.stringify({ ...b, messages: b.messages.length })); } catch (e) { console.log('chat body?', body.slice(0, 200)); } });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= TOKENS) {
        clearInterval(timer);
        res.end(JSON.stringify({ model: MODELS[0].name, message: { role: 'assistant', content: '' }, done: true, total_duration: 1e9, eval_count: TOKENS, eval_duration: 1e9 }) + '\n');
        return;
      }
      const word = WORDS[i % WORDS.length] + (i % 37 === 36 ? '\n\n' : ' ');
      res.write(JSON.stringify({ model: MODELS[0].name, message: { role: 'assistant', content: word }, done: false }) + '\n');
      i++;
    }, 1000 / RATE);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (/^\/(api|mcp|localfs|system|studio|music|tts-api|kakao|cli)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"not here"}'); return;
  }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

const { launchChrome } = await import('./chromeProfile.mjs');
const chrome = launchChrome(browser, 'webui-chrome-streamperf-', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP_PORT}`]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const finish = (code = 0) => { try { server.close(); } catch {} chrome.close(); process.exit(code); };

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const target = list.find(t => t.type === 'page');
    if (target?.webSocketDebuggerUrl) { ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; }); }
  } catch { /* not yet */ }
  if (!ws) await sleep(250);
}
let nextId = 1; const pending = new Map();
const traceEvents = []; let traceDone = null;
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === 'Tracing.dataCollected') traceEvents.push(...m.params.value); if (m.method === 'Tracing.tracingComplete') traceDone?.(); if (process.env.CONSOLE && (m.method === 'Runtime.exceptionThrown' || (m.method === 'Runtime.consoleAPICalled' && /error|warn/.test(m.params.type)))) console.log('page', JSON.stringify(m.params).slice(0, 400)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.result?.value;

const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
await send('Page.enable'); await send('Runtime.enable');
await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride', PHONE);
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__commits = { all: 0, big: 0 };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; }, onScheduleFiberRoot() {}, onPostCommitFiberRoot() {}, onCommitFiberUnmount() {},
    onCommitFiberRoot(id, root) {
      window.__commits.all++;
      // A commit that re-rendered the App component itself (its fiber has fresh props/state).
      if (!window.__appFiber || !window.__appFiber.alternate) {
        const st = [root.current]; let best = null, bestN = 0; let guard = 0;
        while (st.length && guard++ < 5000) { const f = st.pop(); if (typeof f.type === 'function') { let n = 0; for (let h = f.memoizedState; h && n < 2000; h = h.next) n++; if (n > bestN) { bestN = n; best = f; } } if (f.sibling) st.push(f.sibling); if (f.child) st.push(f.child); }
        window.__appFiber = best; window.__appHooks = bestN;
      }
      const app = window.__appFiber;
      if (app && app.alternate && window.__hookDiff) {
        const cur = app.memoizedState !== null && app.alternate.memoizedState !== null ? [app, app.alternate] : null;
        if (cur) { let a = cur[0].memoizedState, b = cur[1].memoizedState, i = 0;
          while (a && b) { if (a.memoizedState !== b.memoizedState && !(a.memoizedState && typeof a.memoizedState === 'object' && 'deps' in a.memoizedState) && !(a.memoizedState && typeof a.memoizedState === 'object' && 'current' in a.memoizedState)) { const v = a.memoizedState; const d = window.__hookDiff[i] ||= { n: 0, ex: '' }; d.n++; d.ex = (typeof v === 'object' ? (Array.isArray(v) ? 'array' + v.length : (v === null ? 'null' : 'obj:' + Object.keys(v).slice(0, 4).join(','))) : String(v)).slice(0, 60); } a = a.next; b = b.next; i++; } }
      }
      if (app && app.alternate && window.__ctxDiff) {
        for (let f = app.return; f; f = f.return) {
          const v = f.memoizedProps && f.memoizedProps.value, w = f.alternate && f.alternate.memoizedProps && f.alternate.memoizedProps.value;
          if (f.alternate && v !== undefined && v !== w && f.memoizedProps !== f.alternate.memoizedProps) {
            const keys = v && typeof v === 'object' ? Object.keys(v).slice(0, 8).join(',') : String(v);
            const changed = v && w && typeof v === 'object' ? Object.keys(v).filter(k => v[k] !== w[k]).join(',') : '';
            const k = keys + ' | changed: ' + changed; window.__ctxDiff[k] = (window.__ctxDiff[k] || 0) + 1;
          }
          if (f.alternate && typeof f.type === 'function' && f.memoizedState !== f.alternate.memoizedState) { const k = 'state of parent ' + (f.type.displayName || f.type.name || '?'); window.__ctxDiff[k] = (window.__ctxDiff[k] || 0) + 1; }
        }
      }
      let worked = 0; const stack = [root.current];
      while (stack.length) { const f = stack.pop(); if (f.flags & 1) worked++; if (f.sibling) stack.push(f.sibling); if (f.child) stack.push(f.child); }
      if (worked > 500) window.__commits.big++;
      window.__commits.worked = (window.__commits.worked || 0) + worked;
    } };` });
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(7000);
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || '')); b?.click(); })()`);
await sleep(3000);

// A long conversation, written where the app keeps it, then the app reloaded.
const md = (i) => [
  `## 답변 ${i}`, '', `이것은 ${i}번째 답변입니다. **굵은 글씨**와 \`코드\`, 그리고 목록이 있습니다.`, '',
  ...Array.from({ length: 6 }, (_, k) => `- 항목 ${k}: 설명 문장이 조금 길게 이어집니다. 마크다운 렌더링 비용을 만들기 위한 내용입니다.`), '',
  '```js', ...Array.from({ length: 12 }, (_, k) => `const value${k} = compute(${k}, "문자열 ${k}");`), '```', '',
  ...Array.from({ length: 4 }, () => '문단이 여러 개 이어집니다. '.repeat(12)),
].join('\n');
const seeded = await evaluate(`(async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('localforage'); r.onsuccess = () => ok(r.result); r.onerror = no; });
  const store = 'keyvaluepairs';
  const keys = await new Promise(ok => { const r = db.transaction(store).objectStore(store).getAllKeys(); r.onsuccess = () => ok(r.result); });
  const key = keys.find(k => /^ollama-sessions/.test(k)) || 'ollama-sessions';
  const now = Date.now();
  const messages = [];
  for (let i = 0; i < ${MESSAGES}; i++) messages.push(i % 2 === 0
    ? { role: 'user', content: '질문 ' + i + ': 이 주제에 대해 자세히 설명해 줘.', at: now - (${MESSAGES} - i) * 60000 }
    : { role: 'assistant', content: ${JSON.stringify(md('{{i}}'))}.replaceAll('{{i}}', i), model: '${MODELS[0].name}', at: now - (${MESSAGES} - i) * 60000 });
  const chat = { id: 'perf-' + now, title: '긴 대화', messages, createdAt: now - 1e7, updatedAt: now, lastModel: '${MODELS[0].name}' };
  await new Promise((ok, no) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put([chat], key); tx.oncomplete = ok; tx.onerror = no; });
  localStorage.setItem(key + ':last', chat.id);
  return key + ' | ' + JSON.stringify(keys);
})()`);
console.log('seeded', seeded);
await send('Page.reload');
await sleep(8000);
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /건너뛰기|Skip/.test(x.textContent || '')); b?.click(); })()`);
await sleep(1500);
console.log('open chat', await evaluate(`(async () => { const menu = document.querySelector('button[aria-label*="사이드바"], button[aria-label*="sidebar" i], .sidebar-toggle'); menu?.click(); await new Promise(r => setTimeout(r, 800)); const item = [...document.querySelectorAll('*')].filter(e => e.children.length === 0 && (e.textContent||'').trim() === '긴 대화').pop(); if (!item) return 'no item; menu=' + !!menu; item.click(); await new Promise(r => setTimeout(r, 1500)); return 'clicked'; })()`));
await send('Emulation.setDeviceMetricsOverride', PHONE);
const shown = await evaluate(`document.querySelectorAll('.message-row').length + ' ' + document.title + ' ' + (document.querySelector('.messages-wrapper') ? 'wrapper' : 'nowrapper')`);
console.log('rows on screen', shown);
if (process.env.SHOT) { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64')); }

if (process.env.SENTINEL) {
  const probe = async () => JSON.parse(await evaluate(`(() => { const rows = document.querySelectorAll('.message-row'); const first = rows[0]; const area = (() => { for (let n = first?.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n; } })(); return JSON.stringify({ rows: rows.length, first: first?.dataset.messageIndex, top: Math.round(area?.scrollTop || 0), height: area?.scrollHeight || 0, button: document.querySelector('.history-earlier button')?.textContent || null }); })()`));
  console.log('before', JSON.stringify(await probe()));
  // Scroll up step by step, as a reader would, until the button comes into view.
  for (let k = 0; k < 40; k++) { await evaluate(`(() => { const r = document.querySelector('.message-row'); for (let n = r?.parentElement; n; n = n.parentElement) { const o = getComputedStyle(n).overflowY; if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) { n.scrollTop = Math.max(0, n.scrollTop - 1500); return; } } })()`); await sleep(120); }
  await sleep(800);
  const anchor = await probe();
  console.log('after scrolling up', JSON.stringify(anchor));
  await evaluate("document.querySelector('.history-earlier button')?.click()");
  await sleep(800);
  console.log('after button', JSON.stringify(await probe()));
  finish(0);
}
await send('Page.bringToFront');
console.log('visibility', await evaluate('document.visibilityState + " " + document.hasFocus()'));
await send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
await evaluate(`(() => {
  window.__long = 0; window.__samples = []; window.__frames = [];
  let prev = performance.now(); const tick = (now) => { if (now - prev > 50) window.__long += now - prev; window.__frames.push(now - prev); prev = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  new PerformanceObserver(list => { for (const e of list.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask', buffered: false });
  const ta = document.querySelector('textarea');
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(ta, '마지막 질문입니다. 길게 답해 줘.');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await evaluate(`(() => { window.__chunks = []; const f = window.fetch; window.fetch = async (...a) => { const r = await f(...a); const u = String(a[0]?.url || a[0]); if (u.endsWith('/api/chat')) { const [x, y] = r.body.tee(); (async () => { const rd = y.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; window.__chunks.push([Math.round(performance.now()), value.length]); } })(); return new Response(x, { status: r.status, headers: r.headers }); } return r; }; })()`);
await sleep(500);
if (process.env.PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 }); await send('Profiler.start'); }
await send('Performance.enable');
const metric = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
const m0 = await metric();
await evaluate('window.__commits && (window.__commits.all = 0, window.__commits.big = 0, window.__commits.app = 0); window.__hookDiff = {}; window.__ctxDiff = {}; window.__appFiber = null;');
if (process.env.TRACE_STYLE) await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
const started = Date.now();
await evaluate(`(() => {
  const ta = document.querySelector('textarea');
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  let last = '';
  window.__sampler = setInterval(() => {
    const bubbles = document.querySelectorAll('.message-row.assistant');
    const text = bubbles.length ? bubbles[bubbles.length - 1].textContent : '';
    if (text !== last) { last = text; window.__samples.push([performance.now(), text.length]); }
  }, 50);
})()`);
await sleep(TOKENS / RATE * 1000 + 6000);
if (process.env.PROFILE) {
  const { result: { profile } } = await send('Profiler.stop');
  const { SourceMapConsumer } = await import('source-map-js');
  const maps = new Map();
  const consumer = (url) => {
    if (maps.has(url)) return maps.get(url);
    let c = null;
    try { const file = path.join(DIST, new URL(url).pathname) + '.map'; if (fs.existsSync(file)) c = new SourceMapConsumer(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    maps.set(url, c); return c;
  };
  const self = new Map(); const byId = new Map(profile.nodes.map(n => [n.id, n]));
  profile.samples.forEach((id, i) => { self.set(id, (self.get(id) || 0) + (profile.timeDeltas[i] || 0)); });
  const total = new Map(); const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const label = (n) => {
    const f = n.callFrame; const c = f.url ? consumer(f.url) : null;
    if (c) { const p = c.originalPositionFor({ line: f.lineNumber + 1, column: f.columnNumber }); if (p.source) return (p.name || f.functionName || '?') + ' ' + p.source.split('/').slice(-2).join('/') + ':' + p.line; }
    return (f.functionName || '(anon)') + ' ' + (f.url.split('/').pop() || f.url) + ':' + f.lineNumber;
  };
  const selfBy = new Map(), totalBy = new Map();
  for (const [id, t] of self) {
    const n = byId.get(id); const l = label(n); selfBy.set(l, (selfBy.get(l) || 0) + t);
    const seen = new Set();
    for (let cur = id; cur != null; cur = parent.get(cur)) { const ll = label(byId.get(cur)); if (seen.has(ll)) continue; seen.add(ll); totalBy.set(ll, (totalBy.get(ll) || 0) + t); }
  }
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, t]) => (t / 1000).toFixed(0).padStart(6) + 'ms  ' + l).join('\n');
  console.log('--- self\n' + top(selfBy, 25));
  console.log('--- total (inclusive)\n' + top(totalBy, 40));
}
if (process.env.SHOT) { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(process.env.SHOT.replace('.png','-end.png'), Buffer.from(shot.result.data, 'base64')); }
const m1 = await metric();
console.log('commits', await evaluate('JSON.stringify(window.__commits)'));
console.log('hooks changed', await evaluate('JSON.stringify(Object.entries(window.__hookDiff || {}).sort((a, b) => b[1].n - a[1].n).slice(0, 15))'), 'appHooks', await evaluate('window.__appHooks'));
console.log('outside', await evaluate('JSON.stringify(window.__ctxDiff)'));
if (process.env.TRACE_STYLE) {
  const done = new Promise(r => { traceDone = r; }); await send('Tracing.end'); await done;
  const sum = {};
  for (const e of traceEvents) {
    if (e.ph !== 'X' && e.ph !== 'B') continue;
    const k = e.name; sum[k] ??= { n: 0, ms: 0, elements: 0 };
    sum[k].n++; sum[k].ms += (e.dur || 0) / 1000; sum[k].elements += e.args?.elementCount || e.args?.data?.elementCount || 0;
  }
  console.log(Object.entries(sum).sort((a, b) => b[1].ms - a[1].ms).slice(0, 14).map(([k, v]) => k.padEnd(28) + ' n=' + v.n + ' ms=' + v.ms.toFixed(0) + (v.elements ? ' elements/each=' + Math.round(v.elements / v.n) : '')).join(String.fromCharCode(10)));
  const styles = traceEvents.filter(e => e.name === 'UpdateLayoutTree' && e.args?.elementCount);
  console.log('style recalcs', styles.length, 'avg elements', Math.round(styles.reduce((a, e) => a + e.args.elementCount, 0) / (styles.length || 1)), 'max', Math.max(0, ...styles.map(e => e.args.elementCount)));
  const layouts = traceEvents.filter(e => e.name === 'Layout' && e.args?.beginData);
  console.log('layouts', layouts.length, 'avg dirty', Math.round(layouts.reduce((a, e) => a + (e.args.beginData.dirtyObjects || 0), 0) / (layouts.length || 1)), 'avg total', Math.round(layouts.reduce((a, e) => a + (e.args.beginData.totalObjects || 0), 0) / (layouts.length || 1)));
}
console.log('metrics', JSON.stringify(Object.fromEntries(['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'Nodes'].map(k => [k, k === 'Nodes' ? m1[k] : +((m1[k] - m0[k]).toFixed(2))]))));
console.log('chunks', await evaluate('JSON.stringify(window.__chunks.slice(0,5)) + " n=" + window.__chunks.length'));
const result = JSON.parse(await evaluate(`JSON.stringify({ long: window.__long, samples: window.__samples, frames: window.__frames })`));
await evaluate('clearInterval(window.__sampler)');
const streamMs = TOKENS / RATE * 1000;
const t0 = result.samples[0]?.[0] || 0;
const during = result.samples.filter(([t]) => t - t0 <= streamMs);
console.log(JSON.stringify({
  messages: MESSAGES, slowdown: SLOWDOWN,
  updates: result.samples.length, updatesWhileStreaming: during.length,
  blockedMs: Math.round(result.long), worstFrames: result.frames.sort((a, b) => b - a).slice(0, 5).map(Math.round),
  firstAt: result.samples[0] ? Math.round(result.samples[0][0]) : null,
  lastLength: result.samples.at(-1)?.[1] || 0,
  gaps: result.samples.slice(1).map((s, i) => Math.round(s[0] - result.samples[i][0])).sort((a, b) => b - a).slice(0, 5),
  wall: Date.now() - started,
  trace: process.env.TRACE ? result.samples.map(([t, n]) => [Math.round(t - t0), n]) : undefined,
}));
finish(0);
