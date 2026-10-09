// Verify delayed history layout and mobile timestamp containment in Chromium.
import { readFileSync, mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const browser = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  .flatMap(p => [path.join(p, 'Microsoft/Edge/Application/msedge.exe'), path.join(p, 'Google/Chrome/Application/chrome.exe')]).find(existsSync);
if (!browser) { console.log('SKIP no Chromium browser'); process.exit(0); }
mkdirSync(path.join(root, 'native/artifacts'), { recursive: true });
const profile = mkdtempSync(path.join(root, 'native/artifacts/conversation-tail-'));
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
  await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
  const css=['index','extras','motion','polish'].map(n=>readFileSync(path.join(root,'src',n+'.css'),'utf8')).join('\n');
  const html='<style>'+css+' .messages-scroll-area{height:500px;overflow:auto;display:block} .message-content{min-height:70px}</style><div class="messages-scroll-area"><div class="messages-wrapper"></div></div>';
  await run('document.body.innerHTML='+JSON.stringify(html)+';true');
  const source=readFileSync(path.join(root,'src/conversationTail.js'),'utf8').replace(/^export /gm,'');
  await run(source+`;window.area=document.querySelector(".messages-scroll-area");window.wrapper=area.firstElementChild;window.following=true;window.stop=observeConversationTail(area,()=>following,()=>{area.scrollTop=area.scrollHeight});window.rows=n=>Array.from({length:n},(_,i)=>'<div class="message-row assistant"><div class="message-content">Message '+i+'</div><div class="message-time">12:34</div></div>').join("");wrapper.innerHTML=rows(50);true`);
  await delay(300);
  check('long history opens at the bottom after lazy layout',await run('area.scrollHeight-area.scrollTop-area.clientHeight<2'));
  await run('wrapper.lastElementChild.querySelector(".message-content").style.height="800px";true');
  await delay(200);
  check('late media growth keeps the final message in view',await run('area.scrollHeight-area.scrollTop-area.clientHeight<2'));
  const timestamp=await run('(()=>{const row=wrapper.lastElementChild,t=row.querySelector(".message-time"),r=row.getBoundingClientRect(),b=t.getBoundingClientRect();return {inside:b.top>=r.top&&b.bottom<=r.bottom,visible:getComputedStyle(t).display!=="none",contained:getComputedStyle(row).contentVisibility};})()');
  check('mobile timestamp is visible inside the paint boundary without a tap',timestamp.inside&&timestamp.visible,JSON.stringify(timestamp));
  await run('wrapper.lastElementChild.classList.add("actions-open");true');
  check('opening mobile actions does not hide the time',await run('getComputedStyle(wrapper.lastElementChild.querySelector(".message-time")).display!=="none"'));
  await run('following=false;area.scrollTop=100;true'); await delay(100);
  await run('wrapper.lastElementChild.querySelector(".message-content").style.height="1200px";true'); await delay(200);
  check('manual reading is not pulled back to bottom',await run('area.scrollHeight-area.scrollTop-area.clientHeight>500'));
  await run('stop();following=true;wrapper.innerHTML=rows(3);area.scrollTop=area.scrollHeight;window.stop=observeConversationTail(area,()=>following,()=>{area.scrollTop=area.scrollHeight});true');await delay(200);
  check('switching to a short chat lands at its end',await run('area.scrollHeight-area.scrollTop-area.clientHeight<2'));
  await run('stop();wrapper.innerHTML=rows(70);area.scrollTop=area.scrollHeight;window.stop=observeConversationTail(area,()=>following,()=>{area.scrollTop=area.scrollHeight});true');await delay(300);
  check('switching back to a long chat settles at its new bottom',await run('area.scrollHeight-area.scrollTop-area.clientHeight<2'));
  await run('stop();true');
  const appSource=readFileSync(path.join(root,'src/App.jsx'),'utf8');
  const start=appSource.indexOf('    const place = scrollMemoryRef.current.get(currentSessionId);');
  const end=appSource.indexOf('  }, [currentSessionId, followTail]);',start);
  assert.ok(start>0&&end>start);
  const effect=appSource.slice(start,end);
  await run('window.scrollMemoryRef={current:new Map([["middle",{top:320,atBottom:false,from:0}],["bottom",{top:10,atBottom:true,from:0}]])};window.isAutoScrollRef={current:true};window.restoringPlaceRef={current:false};window.selfScrollRef={current:false};window.scrollGeometryRef={current:{}};window.scrollAreaRef={current:area};window.followTail=()=>{area.scrollTop=area.scrollHeight};window.currentSessionId="middle";true');
  await run('window.restore=()=>{'+effect+'};window.cancelRestore=restore();true');await delay(150);
  check('saved middle position is restored instead of jumping to bottom',await run('area.scrollTop===320&&!isAutoScrollRef.current'));
  await run('cancelRestore();currentSessionId="bottom";window.cancelRestore=restore();true');await delay(150);
  check('saved bottom follows the current end rather than an old offset',await run('area.scrollHeight-area.scrollTop-area.clientHeight<2&&isAutoScrollRef.current'));
  await run('cancelRestore();currentSessionId="middle";window.cancelRestore=restore();cancelRestore();area.scrollTop=700;true');await delay(150);
  check('cancelled chat restoration cannot overwrite a newer position',await run('area.scrollTop===700'));
  check('message rows do not use deferred paint clipping',await run('Array.from(wrapper.children).every(r=>getComputedStyle(r).contentVisibility==="visible"&&getComputedStyle(r).contain==="none")'));
  console.log(`\n${pass} passed`);
  await send('Browser.close');
} finally {
  ws?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
