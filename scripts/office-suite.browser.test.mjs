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
const server=await createServer({configFile:false,root,plugins:[react(),bridge],optimizeDeps:{entries:['scripts/browserFixtures/officeSuite.html']},server:{host:'127.0.0.1',port:0,watch:null},logLevel:'error'});
await server.listen();
const profile=fs.mkdtempSync(path.join(root,'native/artifacts/office-suite-browser-'));
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
 await send('Page.navigate',{url:`http://127.0.0.1:${server.httpServer.address().port}/scripts/browserFixtures/officeSuite.html`});
 await until('!!window.officeTest');
 if (!process.argv.includes('--ui-only')) {
 const result=await run(`(async()=>{const m=window.officeTest;
  const word=m.createWord('첫 문단 & <태그>\\n마지막 문단','문서 제목');
  const doc=await m.readOffice(new File([word],'test.docx'));doc.pages[0].texts[1]='수정된 문단';
  const edited=m.editOfficeBytes(doc,doc.pages);const back=await m.readOffice(new File([edited],'edited.docx'));
  const wb=await m.createWorkbook([{name:'자료',rows:[['항목','값'],['예산',42],['추가',8],['합계','=SUM(B2:B3)']]}]);
  const formats={};for(const format of ['xlsx','xls','ods','csv','tsv']){const bytes=await m.writeWorkbook(wb,format);const read=await m.readOffice(new File([bytes],'test.'+format));formats[format]={value:read.workbook.Sheets[read.workbook.SheetNames[0]].B2.v,formula:read.workbook.Sheets[read.workbook.SheetNames[0]].B4?.f,total:read.workbook.Sheets[read.workbook.SheetNames[0]].B4?.v};}
  const proposal=m.parseOfficeProposal(JSON.stringify({title:'디자인',slides:m.SLIDE_LAYOUTS.map(layout=>({title:layout,layout,body:'본문',items:[{title:'단계',body:'설명'}],chart:[{label:'증가',value:3},{label:'감소',value:-2}],notes:'발표 노트'}))}),'pptx');
  const deck=await m.createPresentation(proposal.slides,proposal.title);const deckDoc=await m.readOffice(new File([deck],'deck.pptx'));
  return {word:m.encode64(edited),wordText:back.pages[0].texts.join(' '),formats,slides:deckDoc.pages.length,xlsx:m.encode64(await m.writeWorkbook(wb)),deck:m.encode64(deck)};
 })()`);
 assert.match(result.wordText,/수정된 문단/);assert.match(result.wordText,/마지막 문단/);
 for(const [format,r] of Object.entries(result.formats)){assert.equal(r.value,42,format);if(['xlsx','xls','ods'].includes(format))assert.equal(r.formula,'SUM(B2:B3)',format);}
 for(const format of ['xls','ods']) assert.equal(result.formats[format].total,50,format+' calculated sum');
 assert.equal(result.slides,11);
 console.log('PASS DOCX editing, XLSX/XLS/ODS/CSV/TSV values, spreadsheet formulas and eleven editable slide designs');
 if(process.argv.includes('--convert')) {
  for(const [from,to,data] of [['docx','doc',result.word],['docx','odt',result.word],['pptx','odp',result.deck]]) {
   const out=await convertOffice({from,to,data});const back=await convertOffice({from:to,to:from,data:out.data});const files=unzipSync(Buffer.from(back.data,'base64'));
   const body=strFromU8(files[from==='docx'?'word/document.xml':'ppt/slides/slide1.xml']).replace(/<[^>]*>/g,'');assert.match(body,from==='docx'?/수정된 문단/:/title/);
  }
  for(const [from,data] of [['docx',result.word],['xlsx',result.xlsx],['pptx',result.deck]]){const out=await convertOffice({from,to:'pdf',data});assert.equal(Buffer.from(out.data,'base64').subarray(0,5).toString(),'%PDF-');}
  console.log('PASS DOC/ODT/ODP round trips and Word/Excel/PowerPoint PDF conversion');
 }
 }
 await run('window.officeTest.diagram()');await until('!!document.querySelector(".mermaid-canvas svg")');await delay(1000);
 await run(`window.originalSVG=document.querySelector('.mermaid-canvas svg');window.replacements=0;window.observer=new MutationObserver(records=>{for(const r of records)if(r.type==='childList')window.replacements++;});window.observer.observe(document.querySelector('.mermaid-canvas'),{childList:true,subtree:true});`);
 const point=await run(`(()=>{const r=document.querySelector('.mermaid-stage').getBoundingClientRect();return {x:r.left+100,y:r.top+100};})()`);
 await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
 for(let i=1;i<=30;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:point.x+i*3,y:point.y+20});
 await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x+90,y:point.y+20});await delay(200);
 assert.ok(await run(`window.originalSVG===document.querySelector('.mermaid-canvas svg')&&window.replacements===0`));
 assert.ok(await run(`new DOMMatrix(getComputedStyle(document.querySelector('.mermaid-canvas')).transform).m41>70`));
 assert.equal(await run(`getComputedStyle(document.querySelector('.mermaid-canvas')).transitionDuration`),'0s');
 await send('Emulation.setTouchEmulationEnabled',{enabled:true});
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1}]});
 for(let i=1;i<=12;i++)await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+i*4,y:point.y,id:1}]});
 await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(200);
 assert.ok(await run(`window.originalSVG===document.querySelector('.mermaid-canvas svg')&&window.replacements===0`));
 assert.ok(await run(`new DOMMatrix(getComputedStyle(document.querySelector('.mermaid-canvas')).transform).m41>110`));
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y,id:1},{x:point.x+60,y:point.y,id:2}]});
 await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x-20,y:point.y,id:1},{x:point.x+100,y:point.y,id:2}]});
 await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(200);
 assert.ok(await run(`new DOMMatrix(getComputedStyle(document.querySelector('.mermaid-canvas')).transform).m11>1.5&&window.originalSVG===document.querySelector('.mermaid-canvas svg')&&window.replacements===0`));
 console.log('PASS real mouse and touch panning: SVG identity retained, zero subtree replacements, no transform transition');
 await run(`window.observer.disconnect();window.officeTest.editor();window.originalFetch=window.fetch;window.fetch=async(url,options)=>{if(url==='/api/chat'){window.aiRequest=JSON.parse(options.body);return new Response(JSON.stringify({message:{content:JSON.stringify({title:'AI 결과',slides:[{title:'AI 표지',body:'완성 본문',layout:'title',theme:'ocean'},{title:'일정',layout:'timeline',items:[{title:'1단계',body:'구현'},{title:'2단계',body:'검증'}]}]})}}),{status:200,headers:{'Content-Type':'application/json'}});}return window.originalFetch(url,options);};`);
 await until('!!document.querySelector("#office-ai-request")');
 await run(`(()=>{const el=document.querySelector('#office-ai-request');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'보고서 2장 만들어줘');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await delay(100);
 await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='AI 디자인·제작').click()`);
 await until('!!document.querySelector(".office-proposal")');
 assert.equal(await run('window.aiRequest.model'),'test-model');
 assert.equal(await run('document.querySelectorAll(".office-proposal-preview svg").length'),2);
 await run(`[...document.querySelectorAll('button')].find(b=>b.textContent==='편집기에 적용').click()`);await delay(200);
 assert.equal(await run('document.querySelector(".office-editor header input").value'),'AI 결과');
 assert.equal(await run('document.querySelectorAll(".office-content aside>button").length'),4);
 console.log('PASS AI request, schema parsing, design preview and applying editable slides (mock model response)');
 for(const [width,height,name] of [[1280,900,'desktop'],[390,844,'mobile']]) {
  await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:name==='mobile'});await delay(200);
  assert.ok(await run(`document.querySelector('.office-editor').getBoundingClientRect().width<=innerWidth+1`));
  assert.ok(await run(`(()=>{const e=document.querySelector('.office-editor');return e.scrollWidth<=e.clientWidth+1;})()`),'editor has no horizontal overflow');
  const screenshot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(`native/artifacts/office-${name}.png`,Buffer.from(screenshot.result.data,'base64'));
 }
 console.log('PASS desktop/mobile editor width and saved screenshots');
 await run(`window.fetch=window.originalFetch;HTMLAnchorElement.prototype.click=function(){window.savedDocument={name:this.download,url:this.href};};`);
 for(const document of [
  {format:'pptx',title:'대화 발표',slides:[{title:'대화에서 제작',body:'편집기 없이 다운로드',layout:'title'}]},
  {format:'xlsx',title:'대화 표',sheets:[{name:'자료',rows:[['값'],[42]]}]},
  {format:'docx',title:'대화 보고서',text:'완성된 보고서 본문'},
 ]) {
  await run(`window.savedDocument=null;window.officeTest.chatDocument(${JSON.stringify(JSON.stringify(document))})`);
  await until(`!!document.querySelector('section[aria-label="대화에서 만든 오피스 문서"] button')`);
  await run(`document.querySelector('section[aria-label="대화에서 만든 오피스 문서"] button').click()`);
  await until('!!window.savedDocument');
  assert.equal(await run('window.savedDocument.name'),document.title+'.'+document.format);
  const reopened=await run(`(async()=>{const file=new File([await(await fetch(window.savedDocument.url)).blob()],window.savedDocument.name);const doc=await window.officeTest.readOffice(file);return {format:doc.format,pages:doc.pages?.length,sheets:doc.workbook?.SheetNames.length};})()`);
  assert.equal(reopened.format,document.format);
  assert.equal(reopened.pages||reopened.sheets,1);
 }
 console.log('PASS chat document cards download real PPTX/XLSX/DOCX files without opening the editor');
 await send('Browser.close');
} finally {ws?.close();if(child.exitCode===null)child.kill();server.httpServer?.closeAllConnections();await server.close();}
