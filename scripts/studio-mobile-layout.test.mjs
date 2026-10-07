import {readFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const browser=[process.env['ProgramFiles(x86)'],process.env.ProgramFiles].filter(Boolean).flatMap(p=>[path.join(p,'Microsoft/Edge/Application/msedge.exe'),path.join(p,'Google/Chrome/Application/chrome.exe')]).find(existsSync);
assert.ok(browser,'Chromium browser required');
const profile=mkdtempSync(path.join(root,'native/artifacts/mobile-layout-'));
const child=spawn(browser,['--headless=new','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws;const pending=new Map();let id=0;
try {
 let port;
 for(let i=0;i<100;i++){try{port=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await delay(100);}
 assert.ok(port,'browser debugger started');
 const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
 ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(new Error(JSON.stringify(m.error))):p?.resolve(m.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
 const css=['src/index.css','src/extras.css','src/studio.css'].filter(existsSync).map(p=>readFileSync(p,'utf8')).join('\n');
 const buttons=Array.from({length:6},()=>'<button class="icon-btn">☆</button>').join('');
 let count=0;
 for(const width of [320,360,390,412,768])for(const density of ['s','m','l']){
  await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:true});
  const html='<meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style><style>body{margin:0;padding:16px;box-sizing:border-box}.studio-gallery{width:100%}</style><div class="studio-gallery is-density-'+density+'">'+Array.from({length:4},()=>'<article class="studio-job"><div class="studio-job-prompt">VeryLongPrompt'.repeat(1)+'abcdefghijkmnopqrstuvwxyz</div><div class="studio-job-actions">'+buttons+'</div></article>').join('')+'</div>';
  await send('Runtime.evaluate',{expression:'document.open();document.write('+JSON.stringify(html)+');document.close()'});
  await delay(40);
  const result=await send('Runtime.evaluate',{returnByValue:true,expression:`JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,bad:[...document.querySelectorAll('.studio-job')].flatMap(c=>{const r=c.getBoundingClientRect();return [...c.querySelectorAll('button')].filter(b=>{const q=b.getBoundingClientRect();return q.left<r.left-1||q.right>r.right+1;}).map(()=>true)})})`});
  const value=JSON.parse(result.result.value);
  assert.equal(value.bad.length,0,JSON.stringify({width,density,...value}));
  assert.ok(value.scroll<=width,JSON.stringify({width,density,...value}));count++;
 }
 console.log('PASS mobile Studio action containment: '+count+' viewport/density combinations');
 await send('Browser.close');
}finally{
 ws?.close();
 // The browser profile is 20+ MB; one was left behind on every run.
 if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
 rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
