// In a real browser: the conversation keeps what the reader was looking at
// when its width changes (src/viewAnchor.js), and the message box is as tall
// as its text after text arrives without typing or its width changes
// (src/fitTextarea.js).
import { readFileSync, mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const browser = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  .flatMap(p => [path.join(p, 'Microsoft/Edge/Application/msedge.exe'), path.join(p, 'Google/Chrome/Application/chrome.exe')]).find(existsSync);
if (!browser) { console.log('SKIP no Chromium browser'); process.exit(0); }
mkdirSync(path.join(root, 'native/artifacts'), { recursive: true });
const profile = mkdtempSync(path.join(root, 'native/artifacts/viewanchor-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
// The modules, as plain scripts: `export` taken off.
const source = f => readFileSync(path.join(root, f), 'utf8').replace(/^export /gm, '');
let ws; const pending = new Map(); let id = 0;
let pass = 0;
const check = (name, cond, detail = '') => { assert.ok(cond, `${name} ${detail}`); pass++; console.log('PASS  ' + name); };
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch { /* starting */ } await delay(100); }
  assert.ok(port, 'browser debugger started');
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); } };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const para = 'The answer goes on for a while, and wraps differently at every width it is given. ';
  const html = `<style>body{margin:0;font:16px/1.5 sans-serif}#area{height:600px;width:1000px;overflow:auto}
    .message-row{padding:8px 16px}textarea{font:16px/1.5 sans-serif;padding:8px;box-sizing:border-box;resize:none;overflow-y:auto}</style>
    <div id="area">${Array.from({ length: 60 }, (_, i) => `<div class="message-row"><p id="p${i}">${i}. ${para.repeat(4 + (i % 5))}</p></div>`).join('')}</div>
    <textarea id="box" rows="1" style="width:900px"></textarea>`;
  await run(`document.open();document.write(${JSON.stringify(html)});document.close();true`);
  await run(`${source('src/viewAnchor.js')};${source('src/fitTextarea.js')};window.T={noteAnchor,restoreAnchor,fitTextarea};true`);

  // --- the view, across a width change
  const result = await run(`(async () => {
    const area = document.getElementById('area');
    area.scrollTop = 4000;
    const anchor = T.noteAnchor(area);
    const id = anchor && anchor.el.id;
    const before = anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top;
    area.style.width = '520px';            // the code panel opens
    const drifted = anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top;
    T.restoreAnchor(area, anchor);
    const after = anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top;
    area.style.width = '1000px';           // and closes
    T.restoreAnchor(area, anchor);
    const back = anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top;
    return { id, before, drifted, after, back };
  })()`);
  check('the block at the top of the view is found', /^p\d+$/.test(result.id || ''), JSON.stringify(result));
  check('narrowing alone moves it (what was reported)', Math.abs(result.drifted - result.before) > 50, JSON.stringify(result));
  check('it is put back where it was when the panel opens', Math.abs(result.after - result.before) < 2, JSON.stringify(result));
  check('... and when it closes', Math.abs(result.back - result.before) < 2, JSON.stringify(result));
  check('a missing anchor is nothing', await run(`T.restoreAnchor(document.getElementById('area'), null) === 0 && T.noteAnchor(null) === null`));

  // The same through a ResizeObserver on the width, as App.jsx watches it.
  const observed = await run(`(async () => {
    const area = document.getElementById('area');
    area.scrollTop = 2500;
    const anchor = T.noteAnchor(area);
    const before = anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top;
    let width = area.clientWidth, calls = 0;
    const ro = new ResizeObserver(() => { if (area.clientWidth === width) return; width = area.clientWidth; calls++; T.restoreAnchor(area, anchor); });
    ro.observe(area);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    area.style.width = '600px';
    for (let i = 0; i < 5; i++) await new Promise(r => requestAnimationFrame(r));
    ro.disconnect();
    return { calls, moved: anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top - before };
  })()`);
  if (observed.calls === 0) console.log('NOTE  ResizeObserver did not fire in this headless browser; the restore itself is checked above');
  else check('through the width observer, it stays put', Math.abs(observed.moved) < 2, JSON.stringify(observed));

  // --- the message box
  const box = await run(`(() => {
    const box = document.getElementById('box');
    T.fitTextarea(box);
    const empty = box.offsetHeight;
    box.value = 'line one\\nline two\\nline three\\nline four';   // a starter clicked: no typing
    T.fitTextarea(box);
    const four = box.offsetHeight;
    box.value = 'word '.repeat(60);
    T.fitTextarea(box);
    const wide = box.offsetHeight;
    box.style.width = '400px'; T.fitTextarea(box);
    const narrow = box.offsetHeight;
    box.style.width = '900px'; T.fitTextarea(box);
    const widened = box.offsetHeight;
    box.value = 'x\\n'.repeat(40); T.fitTextarea(box);
    const capped = box.offsetHeight;
    box.value = ''; T.fitTextarea(box);
    return { empty, four, wide, narrow, widened, capped, cleared: box.offsetHeight };
  })()`);
  check('text put in without typing gets its height', box.four > box.empty * 2.5, JSON.stringify(box));
  check('a narrower box grows', box.narrow > box.wide, JSON.stringify(box));
  check('widened again, it comes back down (the panel closed)', box.widened === box.wide, JSON.stringify(box));
  check('it stops at 200px', box.capped === 200, JSON.stringify(box));
  check('emptied, it is one line again', box.cleared === box.empty, JSON.stringify(box));

  console.log(`\n${pass} passed`);
  await send('Browser.close');
} finally {
  ws?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
