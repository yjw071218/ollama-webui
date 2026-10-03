import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {createClientWindow} from '../desktop/chrome.mjs';
import {appDialog} from '../desktop/dialog.mjs';
setTimeout(()=>{console.error('CHROME_SMOKE timeout');app.exit(1);},20000);
app.whenReady().then(async()=>{
console.log('chrome start');
const server=http.createServer((q,r)=>r.end('<!doctype html><h1>Client content</h1>'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const win=createClientWindow({show:false,width:900,height:600,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}, {server(){},updates(){},menu(){}});
try {
 await win.loadClientURL('http://127.0.0.1:'+server.address().port);
 console.log('content loaded');
 if(win.webContents.isLoading()) await once(win.webContents,'did-finish-load');
 assert.equal(await win.clientContents.executeJavaScript('typeof window.appChrome'),'undefined');
 assert.equal(await win.webContents.executeJavaScript('typeof window.appChrome.action'),'function');
 assert.equal(win.contentView.children.at(-1).getBounds().y,44);
 win.setSize(1100,700);await new Promise(r=>setTimeout(r,100));
 assert.equal(win.contentView.children.at(-1).getBounds().width,win.getContentSize()[0]);
 win.showInactive();
 console.log('bounds checked');
 const pending=appDialog(win,{title:'연결 확인',message:'앱 전용 확인창',detail:'<script>not executable</script>',buttons:['취소','확인']});
 let modal;
 for(let i=0;i<100;i++){modal=BrowserWindow.getAllWindows().find(w=>w!==win);if(modal && !modal.webContents.isLoading() && await modal.webContents.executeJavaScript('document.querySelectorAll("footer button").length===2').catch(()=>false))break;await new Promise(r=>setTimeout(r,50));}
 console.log('modal ready');
 assert.ok(modal);
 assert.equal(await modal.webContents.executeJavaScript('document.querySelector("#detail").textContent'),'<script>not executable</script>');
 await new Promise(r=>setTimeout(r,400));
 await writeFile(new URL('../artifacts/dialog-preview.png',import.meta.url),(await modal.webContents.capturePage()).toPNG());
 await modal.webContents.executeJavaScript('document.querySelectorAll("footer button")[1].click()');
 assert.equal((await pending).response,1);
 const cancel=appDialog(win,{message:'닫기 검사',buttons:['취소','허용']});
 await new Promise(r=>setTimeout(r,200));BrowserWindow.getAllWindows().find(w=>w!==win)?.close();
 assert.equal((await cancel).response,0);
 const child=win.clientContents;const disposed=once(child,'destroyed');win.destroy();await disposed;assert.ok(child.isDestroyed());
 console.log('CHROME_SMOKE passed: isolated chrome, bounds, modal selection, safe text, cancellation, disposal');
} catch(e){console.error(e);process.exitCode=1;}
finally{server.closeAllConnections();server.close();app.exit(process.exitCode||0);}
}).catch(error=>{console.error(error);app.exit(1);});
