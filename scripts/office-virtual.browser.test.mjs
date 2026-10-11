import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rolldown } from 'rolldown';
import { convertOffice } from '../server/officeConvert.js';
import { unzipSync, strFromU8 } from 'fflate';
const root=process.cwd();
const browser=[process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean).flatMap(p=>[path.join(p,'Microsoft/Edge/Application/msedge.exe'),path.join(p,'Google/Chrome/Application/chrome.exe')]).find(fs.existsSync);
assert.ok(browser,'Chromium installed');
const entry=path.join(root,'node_modules/.office-virtual-test.jsx');
fs.writeFileSync(entry,`export * from '../src/officeEditing.js';
import React from 'react'; import {createRoot} from 'react-dom/client'; import VirtualMessage from '../src/VirtualMessage.jsx';
export function mount(){const root=createRoot(document.getElementById('test'));root.render(<div className="messages-scroll-area" style={{height:400,overflow:'auto'}}>{Array.from({length:300},(_,i)=><VirtualMessage key={i} chat="test" index={i}><div className="heavy" style={{height:100}}>row {i}{Array.from({length:20},(_,j)=><span key={j}>content </span>)}</div></VirtualMessage>)}</div>);}`);
const bundle=await rolldown({input:entry,platform:'browser'});
const {output}=await bundle.generate({format:'esm'});await bundle.close();
const chunks=new Map(output.filter(o=>o.type==='chunk').map(o=>['/'+o.fileName,o.code]));
const entryURL='/'+output.find(o=>o.type==='chunk'&&o.isEntry).fileName;
const server=createServer((req,res)=>{
  if(chunks.has(req.url)){res.setHeader('Content-Type','text/javascript');return res.end(chunks.get(req.url));}
  if(req.url==='/office/blank.hwpx')return res.end(fs.readFileSync('public/office/blank.hwpx'));
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="test"></div>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
fs.mkdirSync('native/artifacts',{recursive:true});
const profile=fs.mkdtempSync(path.join(root,'native/artifacts/office-browser-'));
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let ws;
try {
  let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
  assert.ok(port,'debugger started');
  const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(method,params={})=>new Promise(r=>{pending.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
  const run=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,timeout:60000});assert.ok(!r.error&&!r.result.exceptionDetails,JSON.stringify(r));return r.result.result.value;};
  await send('Page.navigate',{url:origin});await delay(400);
  const result=await run(`(async()=>{const m=window.testModule=await import(${JSON.stringify(entryURL)});
    const bytes=await m.createPresentation([{title:'한글 제목',body:'본문 & <안전>'},{title:'두 번째',body:'내용'}]);
    const doc=await m.readOffice(new File([bytes],'test.pptx'));
    const retained=doc.files['ppt/theme/theme1.xml'];
    doc.pages[0].texts[0]='수정한 제목';
    const edited=await m.readOffice(new File([m.editOfficeBytes(doc,doc.pages)],'edited.pptx'));
    const hwpx=await m.createHangul('새 문서 제목\\n내용 & <태그>\\n마지막 문단');
    const hangul=await m.readOffice(new File([hwpx],'test.hwpx'));
    hangul.pages[0].texts[0]='수정한 한글 제목';
    const final=m.editOfficeBytes(hangul,hangul.pages);
    const opened=await m.readOffice(new File([final],'test.hwpx'));
    m.mount();
    return {slides:doc.pages.length,title:edited.pages[0].texts[0],retained:JSON.stringify([...retained])===JSON.stringify([...edited.files['ppt/theme/theme1.xml']]),text:opened.pages[0].texts.join('\\n'),hwpx:m.encode64(final)};
  })()`);
  assert.equal(result.slides,2);assert.equal(result.title,'수정한 제목');assert.ok(result.retained);
  assert.match(result.text,/수정한 한글 제목/);assert.match(result.text,/내용 & <태그>/);assert.match(result.text,/마지막 문단/);
  console.log('PASS browser PPTX/HWPX creation, text editing, Unicode, original theme preservation');
  await delay(600);
  const before=await run(`({count:document.querySelectorAll('.heavy').length,height:document.querySelector('.messages-scroll-area').scrollHeight})`);
  assert.ok(before.count<40,JSON.stringify(before));assert.ok(before.height>=29000);
  await run(`document.querySelector('.messages-scroll-area').scrollTop=20000`);await delay(500);
  assert.ok(await run(`document.querySelectorAll('.heavy').length<45 && [...document.querySelectorAll('.heavy')].some(n=>n.textContent.startsWith('row 200'))`));
  await run(`window.dispatchEvent(new CustomEvent('webui-reveal-row',{detail:{chat:'test',index:5}}))`);await delay(100);
  assert.ok(await run(`!!document.querySelector('[data-virtual-index="5"] .heavy')`));
  console.log('PASS 300-row virtualization: bounded mounted content, retained scroll height, jump target reveal');
  if(process.platform==='win32') {
    if (process.argv.includes('--ppt')) {
    const pptx = await run(`(async()=>{const m=window.testModule;return m.encode64(await m.createPresentation([{title:'PPT 왕복 제목',body:'한글 본문 유지'}]));})()`);
    const ppt = await convertOffice({from:'pptx',to:'ppt',data:pptx});
    assert.equal(Buffer.from(ppt.data,'base64').subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1','PPT is a real binary Office file');
    const pptBack = await convertOffice({from:'ppt',to:'pptx',data:ppt.data});
    const pptArchive = unzipSync(Buffer.from(pptBack.data,'base64'));
    const pptText=strFromU8(pptArchive['ppt/slides/slide1.xml']).replace(/<[^>]*>/g,'');
    assert.match(pptText,/PPT 왕복 제목/);
    assert.match(pptText,/한글 본문 유지/);
    console.log('PASS PPTX to binary PPT and back preserves Korean title and body');
    } else console.log('SKIP legacy PPT automation (run with --ppt to require this integration)');
    const hwp=await convertOffice({from:'hwpx',to:'hwp',data:result.hwpx});
    const back=await convertOffice({from:'hwp',to:'hwpx',data:hwp.data});
    const archive=unzipSync(Buffer.from(back.data,'base64'));
    const section=strFromU8(archive['Contents/section0.xml']);
    assert.match(section,/수정한 한글 제목/);assert.match(section,/마지막 문단/);
    console.log('PASS Hancom opens browser-produced HWPX, saves HWP, and retains edited text on reopening');
  }
  await send('Browser.close');
} finally { ws?.close();server.closeAllConnections();await new Promise(r=>server.close(r));if(child.exitCode===null)child.kill(); }
