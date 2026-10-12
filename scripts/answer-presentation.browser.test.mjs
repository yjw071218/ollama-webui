import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {convertOffice} from '../server/officeConvert.js';
import {unzipSync,strFromU8} from 'fflate';
const root=process.cwd();
const browser=[process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean).flatMap(p=>[path.join(p,'Microsoft/Edge/Application/msedge.exe'),path.join(p,'Google/Chrome/Application/chrome.exe')]).find(fs.existsSync);
assert.ok(browser,'Chromium is required');
// A test-only bridge exercises the browser conversion client against the real
// converter without starting an authenticated production server.
const bridge={name:'office-test-bridge',configureServer(server){server.middlewares.use('/api/auth/office/convert',async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const result=await convertOffice(JSON.parse(Buffer.concat(chunks).toString()));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({success:true,...result}));}catch(error){res.statusCode=422;res.end(JSON.stringify({success:false,error:error.message}));}});}};
const server=await createServer({configFile:false,root,plugins:[react(),bridge],optimizeDeps:{entries:['scripts/browserFixtures/answerPresentation.html']},server:{host:'127.0.0.1',port:0,watch:null},logLevel:'error'});
await server.listen();
const profile=fs.mkdtempSync(path.join(root,'native/artifacts/answer-presentation-browser-'));
const child=spawn(browser,['--headless=new','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));let ws;
try {
 let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
 assert.ok(port,'debugger started');
 const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')console.error(JSON.stringify(m.params));if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const job=++id;const timer=setTimeout(()=>{pending.delete(job);reject(new Error('Debugger timeout: '+method));},65000);pending.set(job,value=>{clearTimeout(timer);resolve(value);});ws.send(JSON.stringify({id:job,method,params}));});
 const run=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,timeout:60000});assert.ok(!r.error&&!r.result.exceptionDetails,JSON.stringify(r));return r.result.result.value;};
 const until=async expression=>{for(let i=0;i<200;i++){if(await run(expression))return;await delay(100);}throw new Error('Timed out: '+expression);};
 await send('Runtime.enable');
 await send('Page.navigate',{url:`http://127.0.0.1:${server.httpServer.address().port}/scripts/browserFixtures/answerPresentation.html`});
 await until('!!document.querySelector(".ig-panel")');
 assert.equal(await run('document.querySelectorAll(".ig-stat").length'),4);
 assert.equal(await run('document.querySelectorAll(".ig-media article").length'),2);
 await until('document.querySelector(".ig-media img").naturalWidth>0');
 assert.equal(await run('document.querySelectorAll("td br").length'),2);
 assert.equal(await run('document.querySelector("td code").textContent'),'<br>');
 assert.ok(await run('!!document.querySelector(".chart-svg")'));
 assert.ok(await run('!!document.querySelector(".office-cover")'));
 assert.equal(await run('document.querySelector(".ig-sources a").getAttribute("href")'),'https://example.org/');
 for(const [width,height,name] of [[1100,1600,'desktop'],[390,1500,'mobile']]) {
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});await delay(300);
   assert.ok(await run('document.documentElement.scrollWidth<=innerWidth+1'),'no horizontal overflow '+name);
   const metrics=await send('Page.getLayoutMetrics');const size=metrics.result.cssContentSize;const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:size.width,height:size.height,scale:1}});fs.writeFileSync(`native/artifacts/answer-presentation-${name}.png`,Buffer.from(shot.result.data,'base64'));
 }
 await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='미리보기').click()`);
 await until('!!document.querySelector(".file-preview-dialog")');
 assert.ok(await run('!!document.querySelector(".file-slide svg")'));
 await run(`document.querySelector('[aria-label="미리보기 닫기"]').click()`);
 await until('!document.querySelector(".file-preview-dialog")');
 await run(`window.ollamaNative={saveFile:async(blob,name)=>{window.savedDownload={size:blob.size,name};return true;}};document.querySelector('.office-download').click()`);
 await until('!!window.savedDownload');
 assert.ok(await run('window.savedDownload.size>1000'));
 await until('document.querySelector(".download-tray")?.textContent.includes("저장 완료")');
 console.log('PASS full slide preview, native save completion and download status');
 await run('window.presentationTest.design()');
 await until('!!document.querySelector(".office-cover ellipse")');
 await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='미리보기').click()`);
 await until('!!document.querySelector(".file-slide ellipse")');
 const designShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('native/artifacts/document-design-preview.png',Buffer.from(designShot.result.data,'base64'));
 if(fs.existsSync('native/artifacts/latex-preview.pdf')){
   await run('window.presentationTest.pdf()');
   await until('document.querySelector("canvas")?.width>300 && !!document.querySelector("nav")');
   await delay(400);
   const pdfShot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('native/artifacts/latex-mobile-preview.png',Buffer.from(pdfShot.result.data,'base64'));
   console.log('PASS Korean LaTeX PDF canvas preview on mobile');
 }
 await run('window.presentationTest.malformed()');await until('!!document.querySelector(".ig-pending")');
 assert.equal(await run('document.querySelectorAll(".artifact-card").length'),0);
 console.log('PASS infographic panels, media, charts, source links, table breaks, editable document preview, malformed streaming block and desktop/mobile layout');
 await send('Browser.close');
} finally {ws?.close();if(child.exitCode===null)child.kill();await server.close();}
