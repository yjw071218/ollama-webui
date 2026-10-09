// Exercise terminal layout, tail following and stopped preview cleanup in Chromium.
import { readFileSync, mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const browser = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  .flatMap(p => [path.join(p, 'Microsoft/Edge/Application/msedge.exe'), path.join(p, 'Google/Chrome/Application/chrome.exe')]).find(existsSync);
if (!browser) { console.log('SKIP no Chromium browser'); process.exit(0); }
mkdirSync(path.join(root, 'native/artifacts'), { recursive: true });
const profile = mkdtempSync(path.join(root, 'native/artifacts/runner-layout-'));
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
  const css = readFileSync(path.join(root, 'src/runner.css'), 'utf8');
  const html = '<style>html,body{margin:0;height:100%}' + css + '</style><div class="runner"><aside class="runner-side" style="height:100px">Processes</aside><div class="runner-split"></div><section class="runner-main"><header class="runner-bar">CLI</header><pre class="runner-output"></pre><div class="runner-stdin">Input</div></section></div>';
  await send('Emulation.setDeviceMetricsOverride', {width:800,height:600,deviceScaleFactor:1,mobile:false});
  await run('document.body.innerHTML=' + JSON.stringify(html) + ';true');
  const source = ['runnerOutput', 'runnerFrames'].map(name=>readFileSync(path.join(root,'src',name+'.js'),'utf8').replace(/^export /gm,'')).join('\n');
  await run(source + ';window.el=document.querySelector("pre");el.textContent=("A long line of CLI output that wraps as the viewport narrows. ".repeat(5)+"\\n").repeat(100);window.follow=followRunnerOutput(el);true');
  await run('document.querySelector(".runner").classList.add("has-preview");document.querySelector(".runner").insertAdjacentHTML("beforeend", "<div class=runner-split></div><section class=runner-preview>Program</section>");true');
  await delay(100);
  check('CLI keeps its original flexible height', await run('getComputedStyle(document.querySelector(".runner-main")).minHeight === "0px"')); 

  await send('Emulation.setDeviceMetricsOverride', {width:1200,height:700,deviceScaleFactor:1,mobile:false});
  await delay(300);
  check('width change follows rewrapped output', await run('el.scrollHeight-el.scrollTop-el.clientHeight < 2'));
  await run('el.scrollTop=0'); await delay(50);
  await run('el.textContent+="More output";follow.update();true');
  check('reading earlier output is not interrupted', await run('el.scrollTop===0'));
  await run('el.scrollTop=el.scrollHeight'); await delay(50);
  await run('el.textContent+="More output".repeat(500);follow.update();true');
  check('returning to bottom resumes following', await run('el.scrollHeight-el.scrollTop-el.clientHeight < 2'));
  await run('window.pool=createFramePool();window.a=document.createElement("div");window.b=document.createElement("div");document.body.append(a,b);window.release=pool.attach(a,"about:blank#one",0,{});pool.attach(b,"about:blank#two",0,{});release();pool.retain(new Set(["about:blank#two"]));true');
  check('stopped parked preview is removed, other process stays open', await run('document.querySelectorAll("iframe").length===1 && b.querySelector("iframe").src==="about:blank#two"'));
  await run('pool.destroy();follow.destroy();true');
  console.log(`\n${pass} passed`);
  await send('Browser.close');
} finally {
  ws?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
