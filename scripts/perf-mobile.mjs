// Mobile performance, measured without a phone: the built app in headless
// Chrome at a phone's size with its CPU slowed down (default 4x), talking to a
// fake Ollama that streams a reply with reasoning. Reports, per scenario, the
// long tasks (>50 ms), dropped frames and where the main thread went.
//
//   npm run build && node scripts/perf-mobile.mjs [--cpu 4] [--turns 12]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const CPU = arg('--cpu', 4);
const TURNS = arg('--turns', 12);
const HTTP_PORT = 8254;
const CDP_PORT = 9489;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
].find(p => fs.existsSync(p));
if (!browser) { console.log('no Chrome/Edge'); process.exit(1); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const MODEL = 'perf-model:latest';
const words = '모바일 환경에서 렌더링 성능을 측정하기 위한 긴 답변입니다. The quick brown fox jumps over the lazy dog, and **markdown** with `code` keeps the parser honest. '.split(/(?<= )/);

let inflight = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/tags') return json({ models: [{ name: MODEL, model: MODEL, size: 1e9, details: { family: 'llama', parameter_size: '8B' } }] });
  if (url.pathname === '/api/ps') return json({ models: [] });
  if (url.pathname === '/api/version') return json({ version: '0.12.0' });
  if (url.pathname === '/api/show') return json({ capabilities: ['completion', 'thinking'], model_info: { 'llama.context_length': 8192 }, details: { family: 'llama' } });
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    inflight++; res.on('close', () => inflight--);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const line = (o) => res.write(JSON.stringify({ model: MODEL, created_at: new Date().toISOString(), ...o }) + '\n');
    // ~60 tokens/s, like a mid-size local model: 80 of thinking, 400 of answer.
    for (let i = 0; i < (process.env.SHORT ? 0 : 80); i++) { line({ message: { role: 'assistant', content: '', thinking: words[i % words.length] }, done: false }); await sleep(16); }
    for (let i = 0; i < (process.env.SHORT ? 3 : 400); i++) {
      const w = words[i % words.length] + (i % 60 === 59 ? '\n\n' : '') + (i === 200 ? '\n\n```js\nconst x = [1,2,3].map(n => n * 2);\nconsole.log(x);\n```\n\n' : '');
      line({ message: { role: 'assistant', content: w }, done: false }); await sleep(16);
    }
    line({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: 480, eval_duration: 8e9, prompt_eval_count: 50 });
    return res.end();
  }
  if (/^\/(api|mcp|localfs|system|tts-api|kakao|studio)\//.test(url.pathname)) return json({ error: 'not in perf' }, 503);
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

const { launchChrome } = await import('./chromeProfile.mjs');
const chrome = launchChrome(browser, 'webui-perf-', ['--headless=new', '--no-sandbox', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-extensions', `--remote-debugging-port=${CDP_PORT}`]);
const cleanup = () => { try { server.close(); } catch {} chrome.close(); };

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const t = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(x => x.type === 'page');
    if (t) { ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; }); }
  } catch { ws = null; await sleep(250); }
}
let nid = 1; const pend = new Map(); const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method, params = {}) => new Promise(r => { const id = nid++; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.result?.value;

await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: arg('--dpr', 3), mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(6000);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || '')); b?.click(); return !!b; })()`);
await sleep(4000);
await ev(`(() => { [...document.querySelectorAll('button')].filter(b => /skip|건너|닫기|close|나중/i.test(b.textContent||'')).slice(0,3).forEach(b => b.click()); return true; })()`);
await sleep(1000);

// A frame meter: every rAF gap over 1.5 frames counts as a dropped frame.
const FRAME_METER = `(() => { if (window.__fm) return; const fm = window.__fm = { gaps: [], on: false };
  let last = performance.now(); const tick = (t) => { if (fm.on) fm.gaps.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`;
await ev(FRAME_METER);

const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
const scenario = async (name, body) => {
  await ev(`(globalThis.__webuiJank?.clear?.(), window.__fm.gaps = [], window.__fm.on = true, true)`);
  const m0 = await metrics(); const t0 = Date.now();
  await body();
  const m1 = await metrics(); const wall = Date.now() - t0;
  const r = await ev(`(() => { window.__fm.on = false; const g = window.__fm.gaps; const j = globalThis.__webuiJank ? globalThis.__webuiJank() : {};
    const sorted = [...g].sort((a,b)=>a-b); return { frames: g.length, dropped: g.filter(x => x > 25).length,
    p95: Math.round(sorted[Math.floor(sorted.length*0.95)] || 0), worstFrame: Math.round(sorted[sorted.length-1] || 0),
    longTasks: j.longTasks || 0, longMs: j.totalMs || 0, worstTask: j.worstMs || 0 }; })()`);
  const d = (k) => Math.round(((m1[k] || 0) - (m0[k] || 0)) * 1000);
  const row = { scenario: name, wallMs: wall, ...r, scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'), heapMB: Math.round((m1.JSHeapUsedSize || 0) / 1048576), dom: m1.Nodes };
  console.log(JSON.stringify(row));
  return row;
};

const pickModel = `(() => { try { localStorage.setItem('selectedModel', ${JSON.stringify(MODEL)}); } catch {} return true; })()`;
await ev(pickModel);
const ask = async (text) => {
  await ev(`(() => { const ta = document.querySelector('textarea.chat-input, .chat-input textarea, textarea'); ta.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const before = inflight;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: String.fromCharCode(13) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  for (let i = 0; i < 30 && inflight === before; i++) await sleep(100);
  if (inflight === before) { // a phone's composer sends with the button
    await ev(`(() => { const b = document.querySelector('button.send-btn, button.send-button, button[aria-label*="Send"], button[aria-label*="보내"], button[aria-label*="전송"]'); b?.click(); return !!b; })()`);
    for (let i = 0; i < 150 && inflight === before; i++) {
      await sleep(100);
      if (i % 10 === 9) await ev(`document.querySelector('button.send-btn')?.click()`);
    }
  }
  return inflight > before ? 'sent' : 'NOT SENT';
};
const waitIdle = async (max = 30000) => {
  const t = Date.now(); await sleep(500);
  while (inflight > 0 && Date.now() - t < max) await sleep(100);
  await sleep(1200); // the final render and save
};

const rafRate = () => ev(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })`);
console.log('rAF/s idle x1:', await rafRate());
const results = [];
// Build up a conversation first; measure the first and last turns' streaming.
await send('Emulation.setCPUThrottlingRate', { rate: CPU });
console.log(`CPU x${CPU}, 390x844 mobile, ${TURNS} turns`);
console.log('rAF/s idle x'+CPU+':', await rafRate());
console.log('send:', await ask('첫 질문입니다'));
if (!process.argv.includes('--shot')) { await sleep(3000); console.log('rAF/s streaming:', await rafRate()); }
const profileNow = async () => {
  await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 });
  await sleep(1500); await send('Profiler.start'); await sleep(6000);
  const { result } = await send('Profiler.stop');
  const nodes = new Map(result.profile.nodes.map(n => [n.id, n]));
  const dt = result.profile.timeDeltas; const self = new Map(); const total = new Map();
  const parent = new Map(); for (const n of nodes.values()) for (const c of n.children || []) parent.set(c, n.id);
  result.profile.samples.forEach((id, i) => {
    const d = dt[i] || 0; const n = nodes.get(id); const cf = n.callFrame;
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}:${cf.columnNumber + 1}`;
    self.set(key, (self.get(key) || 0) + d);
    const seen = new Set(); let cur = id;
    while (cur != null) { const c = nodes.get(cur).callFrame; const k = `${c.functionName || '(anon)'} ${c.url.split('/').pop()}:${c.lineNumber + 1}:${c.columnNumber + 1}`; if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) || 0) + d); } cur = parent.get(cur); }
  });
  const top = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${String(Math.round(v / 1000)).padStart(6)} ms  ${k}`).join('\n');
  console.log('--- self time ---\n' + top(self)); console.log('--- total time ---\n' + top(total));
};
if (process.argv.includes('--profile')) { await profileNow(); cleanup(); process.exit(0); }

if (process.argv.includes('--tapctl')) {
  await waitIdle(); await sleep(1500);
  const list = await ev(`(() => { const out = []; document.querySelectorAll('.message-row *').forEach(e => { if (getComputedStyle(e).cursor === 'pointer' && !e.closest('.msg-hover-actions') && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer')) { const b = e.getBoundingClientRect(); if (b.width && b.height) out.push((e.className || e.tagName).toString().slice(0, 40)); } }); return out; })()`);
  console.log('controls in messages:', list.length);
  for (let k = 0; k < list.length; k++) {
    const pt = await ev(`(() => { const all = [...document.querySelectorAll('.message-row *')].filter(e => getComputedStyle(e).cursor === 'pointer' && !e.closest('.msg-hover-actions') && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer')); const e = all[${k}]; e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, what: (e.className || e.tagName).toString().slice(0, 40) }; })()`);
    await sleep(150);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(400);
    console.log(pt.what, '-> capsule open:', await ev(`!!document.querySelector('.message-row.actions-open')`));
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(150);
  }
  cleanup(); process.exit(0);
}
if (process.argv.includes('--tapall')) {
  await waitIdle();
  await sleep(1500); await ev(`document.querySelectorAll('.message-row.is-entering').forEach(r => r.classList.remove('is-entering'))`);
  const rows = await ev(`document.querySelectorAll('.message-row').length`);
  await ev(`document.querySelectorAll('.toast').forEach(t => t.remove())`);
  if (process.env.XFORM) await ev(`document.querySelector('.messages-wrapper').style.transform = 'translateX(30px)'`);
  for (let k = 0; k < rows; k++) {
    const pt = await ev(`(() => { const r = document.querySelectorAll('.message-row')[${k}]; r.scrollIntoView({block:'center'}); const t = r.querySelector('.message-bubble, .message-content p, .message-content') || r; const b = t.getBoundingClientRect(); return { x: b.left + Math.min(20, b.width/2), y: b.top + b.height/2, cls: r.className, w: b.width, h: b.height }; })()`);
    await sleep(200);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
    if (process.env.SHIFT) await ev(`(() => { const w = document.querySelector('.messages-wrapper'); w.style.transform = 'translateY(220px)'; return true; })()`);
    await sleep(80);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    if (process.env.SHIFT) await ev(`document.querySelector('.messages-wrapper').style.transform = ''`);
    await sleep(500);
    const st = await ev(`(() => { const open = document.querySelector('.message-row.actions-open'); const bar = open?.querySelector('.msg-hover-actions'); const b = bar?.getBoundingClientRect(); const top = document.elementFromPoint(${pt.x}, ${pt.y}); return { open: !!open, bar: b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null, disp: bar ? getComputedStyle(bar).display : null, hit: top?.className?.toString().slice(0,60), barHit: b ? !!document.elementFromPoint(b.left + b.width/2, b.top + b.height/2)?.closest('.msg-hover-actions') : false }; })()`);
    console.log(k, pt.cls.trim().slice(0, 50), JSON.stringify(st));
    console.log('  centre:', JSON.stringify(await ev(`(() => { const b = document.querySelector('.message-row.actions-open .msg-hover-actions')?.getBoundingClientRect(); const f = document.querySelector('form.input-container').getBoundingClientRect(); return b && { barMidX: Math.round(b.left + b.width / 2), screenMidX: document.documentElement.clientWidth / 2, barMidY: Math.round(b.top + b.height / 2), composerMidY: Math.round(f.top + f.height / 2) }; })()`)));
    console.log('  ancestors:', JSON.stringify(await ev(`(() => { const out = []; let e = document.querySelector('.message-row.actions-open .msg-hover-actions')?.parentElement; while (e && e !== document.documentElement) { const c = getComputedStyle(e); const why = [c.transform !== 'none' && 'transform:' + c.transform, c.filter !== 'none' && 'filter', c.backdropFilter && c.backdropFilter !== 'none' && 'backdrop', /paint|layout|strict|content/.test(c.contain) && 'contain:' + c.contain, c.contentVisibility !== 'visible' && 'cv:' + c.contentVisibility, /transform|filter/.test(c.willChange) && 'will-change', c.perspective !== 'none' && 'persp'].filter(Boolean); if (why.length) out.push((e.className || e.tagName).toString().slice(0, 40) + ' => ' + why.join(',')); e = e.parentElement; } return out; })()`)));
    if (k === 0) { const a = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT,'native/artifacts/tap-open.png'), Buffer.from(a.result.data,'base64')); console.log('  top at bar:', await ev(`(() => { const b = document.querySelector('.message-row.actions-open .msg-hover-actions').getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2); return (e?.className || e?.tagName || '').toString().slice(0,60); })()`)); }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(200);
  }
  const a = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT,'native/artifacts/tapall.png'), Buffer.from(a.result.data,'base64'));
  cleanup(); process.exit(0);
}
if (process.argv.includes('--actions')) {
  await waitIdle();
  const before = await ev(`(() => { const a = document.querySelector('.messages-wrapper')?.closest('[class*=scroll], .chat-area, main') || document.scrollingElement; const el = [...document.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY)); window.__sa = el; return el ? el.scrollHeight : -1; })()`);
  await ev(`(() => { const rows = document.querySelectorAll('.message-row.assistant'); const r = rows[rows.length-1]; r.scrollIntoView({block:'center'}); const t = r.querySelector('.message-content p') || r.querySelector('.message-content'); t.click(); return true; })()`);
  await sleep(600);
  const after = await ev(`window.__sa ? window.__sa.scrollHeight : -1`);
  console.log('scrollHeight before/after open:', before, after, 'open rows:', await ev(`document.querySelectorAll('.actions-open').length`));
  const a = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT,'native/artifacts/actions-sheet.png'), Buffer.from(a.result.data,'base64'));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 150, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195, y: 150, button: 'left', clickCount: 1 });
  await sleep(300); console.log('open after outside tap:', await ev(`document.querySelectorAll('.actions-open').length`));
  cleanup(); process.exit(0);
}
if (process.argv.includes('--shot')) { await sleep(400); { const a = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT,'native/artifacts/perf-think-live.png'), Buffer.from(a.result.data,'base64')); } await waitIdle(); await ev(`document.querySelector('.message-row .think-summary')?.scrollIntoView({block:'start'})`); await sleep(300); { const a = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT,'native/artifacts/perf-think-done.png'), Buffer.from(a.result.data,'base64')); } console.log('ask2:', await ask('둘째')); await sleep(1500); console.log('dbg:', JSON.stringify(await ev(`(async()=>{ const g=[]; let l=performance.now(); await new Promise(r=>{let n=0; const f=t=>{g.push(t-l);l=t; if(++n<10) requestAnimationFrame(f); else r();}; requestAnimationFrame(f); setTimeout(r,2000);}); return {raf:g.length, fm: !!window.__fm, lt: PerformanceObserver.supportedEntryTypes, jank: typeof globalThis.__webuiJank, ta: [...document.querySelectorAll('textarea')].map(t=>t.className+'|'+t.value.slice(0,20)), rows: document.querySelectorAll('.message-row').length}; })()`))); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ROOT,'native/artifacts/perf-shot.png'), Buffer.from(s.result.data,'base64')); console.log('text:', (await ev('document.body.innerText')).slice(0,600)); cleanup(); process.exit(0); }
results.push(await scenario('stream (turn 1)', () => waitIdle()));
for (let i = 2; i < TURNS; i++) {
  const r = await ask(`질문 ${i}`);
  if (r !== 'sent') { console.log('turn', i, r, JSON.stringify(await ev(`({ ta: document.querySelector('textarea')?.value, btns: [...document.querySelectorAll('.chat-input-container button, form button, button')].slice(-6).map(b => (b.className||'') + '|' + (b.getAttribute('aria-label')||'') + '|' + b.disabled), toast: document.querySelector('.toast, [role=alert]')?.innerText })`))); break; }
  await waitIdle();
}
await ask('마지막 질문');
if (process.argv.includes('--profile-long')) { await profileNow(); cleanup(); process.exit(0); }
results.push(await scenario(`stream (turn ${TURNS}, long chat)`, () => waitIdle()));

const typing = async () => {
  await ev(`document.querySelector('.chat-input textarea, textarea')?.focus()`);
  for (const ch of '모바일에서 입력할 때 버벅이는지 확인하는 문장입니다 typing test') { await send('Input.insertText', { text: ch }); await sleep(60); }
};
results.push(await scenario('typing (long chat)', typing));
await ev(`(() => { const ta = document.querySelector('.chat-input textarea, textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; set.call(ta,''); ta.dispatchEvent(new Event('input',{bubbles:true})); })()`);

results.push(await scenario('scroll (long chat)', async () => {
  for (let k = 0; k < 4; k++) {
    await send('Input.synthesizeScrollGesture', { x: 195, y: 300, yDistance: 3000, speed: 2500, gestureSourceType: 'touch' });
    await send('Input.synthesizeScrollGesture', { x: 195, y: 300, yDistance: -3000, speed: 2500, gestureSourceType: 'touch' });
  }
}));
results.push(await scenario('idle 5s', () => sleep(5000)));

const thinkCheck = await ev(`(() => ({ messages: document.querySelectorAll('.message-row').length, thinkFolds: document.querySelectorAll('.claude-think').length,
  emptyFolds: [...document.querySelectorAll('.claude-think')].filter(f => !f.querySelector('.think-body')?.textContent.trim()).length }))()`);
console.log('\nthink folds:', JSON.stringify(thinkCheck));
if (errors.length) console.log('page errors:', errors.slice(0, 5));
console.table(results.map(({ scenario, wallMs, dropped, frames, p95, worstFrame, longTasks, longMs, worstTask, scriptMs, layoutMs, styleMs, dom }) =>
  ({ scenario, wallMs, dropped: `${dropped}/${frames}`, p95, worstFrame, longTasks, longMs, worstTask, scriptMs, layoutMs, styleMs, dom })));
fs.mkdirSync(path.join(ROOT, 'native/artifacts'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'native/artifacts/perf-mobile.json'), JSON.stringify({ cpu: CPU, turns: TURNS, results, thinkCheck }, null, 2));
cleanup();
process.exit(0);
