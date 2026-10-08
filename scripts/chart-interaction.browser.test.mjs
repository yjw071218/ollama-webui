import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { rolldown } from 'rolldown';

const root = process.cwd();
const browser = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
  .flatMap(p => [path.join(p, 'Google/Chrome/Application/chrome.exe'), path.join(p, 'Microsoft/Edge/Application/msedge.exe')]).find(existsSync);
assert.ok(browser, 'Chromium browser is installed');
const bundle = await rolldown({ input: 'chart-test-entry', platform: 'browser',
  transform: { jsx: { runtime: 'automatic' } },
  plugins: [{ name: 'fixture', resolveId(id) { if (id === 'chart-test-entry') return id; },
    load(id) { if (id === 'chart-test-entry') return `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Chart } from ${JSON.stringify(path.join(root, 'src/Chart.jsx'))};
      window.renderChart = (type) => {
        window.testRoot ||= createRoot(document.getElementById('mount'));
        window.testRoot.render(React.createElement(Chart, {key:type, source:JSON.stringify({type, title:'Test', labels:['A','B','C'], data:[10,20,30]})}));
      };
      window.renderFailure = (broken) => {
        window.testRoot.render(React.createElement(Chart, {source:JSON.stringify({data:[broken ? 1 : 2]}), t: () => { if (broken) throw new Error('test render failure'); return 'chart'; }}));
      };`; } }],
});
const { output } = await bundle.generate({ format: 'iife' });
await bundle.close();
mkdirSync(path.join(root, 'native/artifacts'), { recursive: true });
const profile = mkdtempSync(path.join(root, 'native/artifacts/chart-browser-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; } catch {} await delay(100); }
  assert.ok(port);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const run = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const css = readFileSync(path.join(root, 'src/index.css'), 'utf8') + '\n' + readFileSync(path.join(root, 'src/extras.css'), 'utf8');
  await run(`const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';document.head.append(viewport);true`);
  await run(`document.body.innerHTML = '<div id="mount" style="max-width:900px"></div>'; window.capsules=0; document.body.addEventListener('click',()=>window.capsules++); document.body.addEventListener('pointerup',()=>window.capsules++); const style=document.createElement('style'); style.textContent=${JSON.stringify(css)};document.head.append(style);true`);
  await run(output.find(o => o.type === 'chunk').code);
  for (const width of [390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    for (const type of ['bar', 'line', 'area', 'pie', 'donut', 'horizontalBar', 'radar', 'heatmap']) {
      await run(`renderChart(${JSON.stringify(type)});true`);
      await delay(50);
      const result = await run(`(() => {
        const mark=document.querySelector('.chart-svg [role="button"]');
        mark.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch'}));
        mark.dispatchEvent(new MouseEvent('click',{bubbles:true}));
        return {marks:!!mark, overflow:document.documentElement.scrollWidth > innerWidth, capsules};
      })()`);
      assert.equal(result.capsules, 0, type + ' must isolate interaction');
      assert.equal(result.overflow, false, type + ' fits ' + width);
      await delay(20);
      assert.match(await run(`document.querySelector('.chart-readout').textContent`), /10/);
      await run(`document.querySelector('.chart-svg [role="button"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); document.querySelector('details').open=true;true`);
      assert.equal(await run(`document.querySelectorAll('.chart-data tbody tr').length`), 3);
      if (process.env.CHART_SCREENSHOTS && ['donut', 'heatmap'].includes(type)) {
        await run(`document.querySelector('details').open=false;document.body.style.overflow='auto';true`);
        for (const theme of ['light', 'dark']) {
          await run(`document.documentElement.setAttribute('data-theme', '${theme}');true`);
          await delay(300);
          const shot = await send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(path.join(root, 'native/artifacts', 'chart-' + type + '-' + width + '-' + theme + '.png'), Buffer.from(shot.data, 'base64'));
        }
      }
      console.log(`PASS ${type}: touch, keyboard, data table, event isolation (${width}px)`);
    }
  }
  // Exercise the app's actual completion predicates against stale saved flags.
  const app = readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
  const statusCode = ['isFetching', 'isThinkingOnly', 'isThinkingIncomplete', 'shouldOpenDropdown']
    .map(name => app.match(new RegExp(`const ${name} = [\\s\\S]*?;`))[0]).join('\n');
  const state = new Function('streamingNow', 'group', 'internalBlocks', statusCode + '\nreturn shouldOpenDropdown;');
  assert.equal(state(false, [{ content: '', isMcpFetching: true }], [{ type: 'think', isComplete: false }]), false);
  assert.equal(state(true, [{ content: '' }], [{ type: 'think', isComplete: false }]), true);
  const selector = app.match(/const IGNORE_TAP = '([^']+)'/)[1];
  assert.equal(await run(`document.querySelector('td').closest(${JSON.stringify(selector)}) !== null`), true);
  console.log('PASS completed reasoning and table toolbar guards');
  await run('renderFailure(true);true');
  await delay(50);
  assert.equal(await run('!!document.querySelector(".chart-fallback")'), true);
  await run('renderFailure(false);true');
  await delay(50);
  assert.equal(await run('!!document.querySelector(".chart-svg")'), true);
  console.log('PASS chart failure is isolated and recovers when content changes');
  await send('Browser.close');
} finally {
  ws?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
}
