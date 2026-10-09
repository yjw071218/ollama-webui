// Verify live activity animations against both OS and app motion preferences.
import { readFileSync, mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const browser = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  .flatMap(p => [path.join(p, 'Microsoft/Edge/Application/msedge.exe'), path.join(p, 'Google/Chrome/Application/chrome.exe')]).find(existsSync);
if (!browser) { console.log('SKIP no Chromium browser'); process.exit(0); }
mkdirSync(path.join(root, 'native/artifacts'), { recursive: true });
const profile = mkdtempSync(path.join(root, 'native/artifacts/activity-motion-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
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
  const css = ['index', 'extras', 'motion', 'polish'].map(name => readFileSync(path.join(root, 'src', name + '.css'), 'utf8')).join('\n');
  await run('document.head.innerHTML = ' + JSON.stringify('<style>' + css + '</style>') + ';document.body.innerHTML = ' + JSON.stringify('<span class="live-work-phase is-running">Running…</span><div class="claude-think"><span class="think-label is-live">Thinking…</span><span class="think-label">Finished</span></div>') + ';true');
  for (const os of ['reduce', 'no-preference']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: os }] });
    for (const mode of ['system', 'full', 'reduced']) {
      await run(mode === 'system' ? 'document.documentElement.removeAttribute("data-motion")' : 'document.documentElement.setAttribute("data-motion", ' + JSON.stringify(mode) + ')');
      const state = await run('Array.from(document.querySelectorAll(".live-work-phase,.think-label")).map(el => ({name:getComputedStyle(el).animationName, animations:el.getAnimations().map(a=>({state:a.playState,time:a.currentTime}))}))');
      check(os + '/' + mode + ': active indicators follow app preference', state.slice(0, 2).every(s => mode === 'reduced' ? s.name === 'none' : s.animations.some(a => a.state === 'running')), JSON.stringify(state));
      check(os + '/' + mode + ': completed reasoning stays still', state[2].name === 'none');
      if (mode !== 'reduced') {
        await delay(100);
        const later = await run('Array.from(document.querySelectorAll(".live-work-phase,.think-label.is-live")).map(el=>el.getAnimations()[0].currentTime)');
        check(os + '/' + mode + ': both animation clocks advance', later.every((t,i)=>t>state[i].animations[0].time));
      }
    }
  }
  console.log(`\n${pass} passed`);
  await send('Browser.close');
} finally {
  ws?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
