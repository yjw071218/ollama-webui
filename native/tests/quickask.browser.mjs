import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const base='native/android/app/src/main/assets/';
const browser=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).flatMap(p=>[path.join(p,'Microsoft/Edge/Application/msedge.exe'),path.join(p,'Google/Chrome/Application/chrome.exe')]).find(existsSync);
assert.ok(browser,'Chromium browser required');
const calls=[];let mode='ok';
const server=createServer(async(req,res)=>{
 calls.push(req.url);
 if(req.url==='/api/auth/session'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({sessionId:'test-session',csrfToken:'test-csrf'}));}
 if(req.url==='/api/tags'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({models:[{name:'test-model'}]}));}
 if(req.url==='/api/chat'){
  let body='';for await(const part of req)body+=part;
  const parsed=JSON.parse(body); requests.push({headers:req.headers,body:parsed});
  res.setHeader('Content-Type','application/x-ndjson');
  if(mode==='hold'){res.write('{"message":{"content":"진행"}}\n');return;}
  if(mode==='error'){res.end('{"error":"test failure"}\n');return;}
  const bytes=Buffer.from('{"message":{"content":"안녕하세요 <script>bad</script>"}}\n{"done":true}');
  res.write(bytes.subarray(0,25));setTimeout(()=>res.end(bytes.subarray(25)),10);return;
 }
 const asset=req.url==='/__native/quickask.js'?'quickask.js':'quickask.html';
 res.setHeader('Content-Type',asset.endsWith('.js')?'application/javascript':'text/html');res.end(readFileSync(base+asset));
});
const requests=[];
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const profile=mkdtempSync(path.join(os.tmpdir(),'quickask-browser-'));
const child=spawn(browser,['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let ws;let seq=0;const pending=new Map();
try{
 let port;for(let i=0;i<100;i++){try{port=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
 assert.ok(port);
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50);}throw Error('Timeout '+expression);};
 await send('Emulation.setDeviceMetricsOverride',{width:360,height:460,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:origin+'/__native/quickask'});
 await until('!!document.getElementById("model")?.value');
 await evaluate(`window.__ollamaNative=[{type:'selection',text:'선택한 원문'}];window.dispatchEvent(new Event('ollama-native-action'));document.querySelector('[data-prompt]').click()`);
 await until('document.getElementById("send").textContent === "보내기"');
 assert.equal(requests.length,1);
 assert.equal(requests[0].headers['x-chat-ephemeral'],'1');
 assert.equal(requests[0].headers['x-session-id'],'test-session');
 assert.equal(requests[0].headers['x-csrf-token'],'test-csrf');
 assert.equal(requests[0].headers['x-chat-conversation'],undefined);
 assert.equal(requests[0].headers['x-chat-job-id'],undefined);
 assert.match(requests[0].body.messages[0].content,/선택한 원문/);
 assert.match(await evaluate('document.querySelector(".answer").textContent'),/안녕하세요 <script>/);
 assert.equal(await evaluate('document.querySelector(".answer script")'),null);
 await evaluate(`document.getElementById('input').value='후속 질문';document.getElementById('form').requestSubmit()`);
 await until('document.getElementById("send").textContent === "보내기"');
 assert.equal(requests[1].body.messages.length,3);
 assert.ok(calls.every(url=>['/__native/quickask','/__native/quickask.js','/api/auth/session','/api/tags','/api/chat','/favicon.ico'].includes(url)),JSON.stringify(calls));
 assert.equal(await evaluate('localStorage.length'),0);
 await send('Page.reload');await until('!!document.getElementById("model")?.value');
 assert.equal(await evaluate('document.querySelectorAll(".answer").length'),0);
 mode='error';await evaluate(`document.getElementById('input').value='오류 뒤에도 남는 질문';document.getElementById('form').requestSubmit()`);await until('document.getElementById("send").textContent === "보내기"');
 assert.match(await evaluate('document.getElementById("status").textContent'),/test failure/);
 assert.equal(await evaluate('document.getElementById("input").value'),'오류 뒤에도 남는 질문');
 mode='hold';await evaluate(`document.querySelector('[data-prompt]').click()`);await until('document.getElementById("send").textContent === "중지"');
 await evaluate('document.getElementById("form").requestSubmit()');await until('document.getElementById("send").textContent === "보내기"');
 assert.match(await evaluate('document.getElementById("status").textContent'),/중지/);
 mode='ok';await evaluate(`document.getElementById('form').requestSubmit()`);await until('document.getElementById("send").textContent === "보내기"');
 assert.equal(await evaluate('document.getElementById("input").value'),'');
 mode='ok';await send('Page.reload');await until('!!document.getElementById("model")?.value');
 await evaluate(`window.__ollamaNative=[{type:'selection',text:'선택한 글을 요약하거나 번역하고, 궁금한 점을 물어보세요.'}];window.dispatchEvent(new Event('ollama-native-action'))`);
 assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
 const screenshot=await send('Page.captureScreenshot',{format:'png'});writeFileSync('native/artifacts/quickask-preview.png',Buffer.from(screenshot.data,'base64'));
 console.log('PASS standalone UI: session reuse, split UTF-8, terminal frame, follow-up, no sync/storage, close/reopen, errors, cancellation, 360px layout');
 await send('Browser.close');
}finally{ws?.close();if(child.exitCode===null)child.kill();server.closeAllConnections();server.close();}
