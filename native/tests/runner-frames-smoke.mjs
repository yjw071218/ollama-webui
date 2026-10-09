import { app, BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
let loads = 0;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/frame') { loads++; res.end('<script>window.marker=Math.random();window.ticks=0;setInterval(()=>window.ticks++,20)</script>'); }
  else res.end('<div id="one"></div><div id="two"></div>');
});
app.whenReady().then(async () => {
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const timeout = setTimeout(() => app.exit(1), 20000);

let win;
try {
  win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(origin);
  const source = (await readFile(new URL('../../src/runnerFrames.js', import.meta.url), 'utf8')).replace('export function', 'function');
  await win.webContents.executeJavaScript(`${source};window.pool=createFramePool();window.release=pool.attach(document.querySelector('#one'),${JSON.stringify(origin + '/frame')},0,{width:'100%',height:'100%'});true;`);
  await new Promise(r => setTimeout(r, 200));
  const before = await win.webContents.executeJavaScript(`({marker:document.querySelector('iframe').contentWindow.marker,ticks:document.querySelector('iframe').contentWindow.ticks})`);
  await win.webContents.executeJavaScript(`release();document.querySelector('#one').remove();`);
  await new Promise(r => setTimeout(r, 200));
  await win.webContents.executeJavaScript(`window.release=pool.attach(document.querySelector('#two'),${JSON.stringify(origin + '/frame')},0,{width:'100%',height:'100%'});true;`);
  const after = await win.webContents.executeJavaScript(`({marker:document.querySelector('#two iframe').contentWindow.marker,ticks:document.querySelector('#two iframe').contentWindow.ticks})`);
  assert.equal(before.marker, after.marker);
  assert.ok(after.ticks > before.ticks, 'background timers continue');
  assert.equal(loads, 1, 'switching layouts must not reload the page');
  await win.webContents.executeJavaScript(`release();pool.attach(document.querySelector('#two'),${JSON.stringify(origin + '/frame')},1,{});true;`);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(loads, 2, 'explicit reload still works');
  await win.webContents.executeJavaScript('pool.destroy()');
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("iframe").length'), 0);
  console.log('PASS runner frames: state, background timers, layout moves, explicit reload, cleanup');
} catch (e) { console.error(e); process.exitCode = 1; }
finally { clearTimeout(timeout); win?.destroy(); server.close(); app.exit(process.exitCode || 0); }

});
