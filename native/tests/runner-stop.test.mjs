import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i=0;i<100;i++) { if(await fn()) return; await delay(100); } throw Error('Timed out'); }

test('Stop waits for detached server after its launcher exits, then releases its port', {skip:process.platform !== 'win32'}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-stop-test-'));
  const handlers = new Map();
  globalThis.__runnerTestIPC = { handle: (name, handler) => handlers.set(name, handler) };
  let source = await readFile(new URL('../desktop/runner.mjs', import.meta.url), 'utf8');
  source = source.replace("import { ipcMain, dialog, shell, screen } from 'electron';", 'const ipcMain = globalThis.__runnerTestIPC; const dialog = {}, shell = {}, screen = {};');
  for (const name of ['i18n', 'winembed']) source = source.replace(`'./${name}.mjs'`, JSON.stringify(new URL(`../desktop/${name}.mjs`, import.meta.url).href));
  const { createRunner } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const runner = createRunner({valid:()=>true,owner:()=>null,send:()=>{},allowed:()=>true,allow:()=>{},openBrowser:()=>{}});
  const invoke = (name,...args) => handlers.get('runner:'+name)({},...args);
  let run;
  try {
    await writeFile(path.join(dir,'server.cjs'), `const net=require('net'),fs=require('fs'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>fs.writeFileSync('server.json',JSON.stringify({pid:process.pid,port:s.address().port})));`);
    await writeFile(path.join(dir,'launch.cjs'), `const {spawn}=require('child_process'); spawn(process.execPath,['server.cjs'],{detached:true,stdio:'ignore',windowsHide:true}).unref();`);
    run = await invoke('start',{cwd:dir,command:`"${process.execPath}" launch.cjs`});
    let info;
    await until(async()=>{try { info=JSON.parse(await readFile(path.join(dir,'server.json'),'utf8'));return true; }catch{return false;}});
    await delay(800);
    assert.equal((await invoke('list'))[0].exited,false,'detached server must stay stoppable');
    assert.equal(await invoke('stop',run.id),true);
    assert.equal((await invoke('list'))[0].exited,true);
    await until(()=>{try {process.kill(info.pid,0);return false;}catch{return true;}});
    const probe=net.createServer();
    await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(info.port,'127.0.0.1',resolve);});
    await new Promise(resolve=>probe.close(resolve));
    console.log('Verified detached PID exited and TCP port reusable');
  } finally { runner.stopAll(); delete globalThis.__runnerTestIPC; await rm(dir,{recursive:true,force:true}); }
});

test('Missing supervision never reports zero live processes or successful termination', {skip:process.platform !== 'win32'}, async () => {
  const {createWinEmbed}=await import('../desktop/winembed.mjs');
  const helper=createWinEmbed();
  try {
    assert.equal(await helper.alive(0),-1);
    assert.equal(await helper.kill(0),false);
  } finally {helper.close();}
});
