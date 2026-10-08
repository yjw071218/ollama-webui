// Run with Electron: the title bar in the page's colours, the screen picker,
// and the address screen's failure panel and recent servers.
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClientWindow } from '../desktop/chrome.mjs';
import { pickSource, pickerItems } from '../desktop/capture.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
app.on('window-all-closed', () => {});
const timer = setTimeout(() => { console.error('FEATURES_SMOKE timeout'); app.exit(1); }, 40000);
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

app.whenReady().then(async () => {
  try {
    // 1. Title bar colours follow the page.
    const win = createClientWindow({ show: false, width: 900, height: 600, pageBackground: '#faf9f5', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }, { server() {}, updates() {}, menu() {} });
    await until(() => !win.webContents.isLoading());
    const bg = () => win.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor");
    await until(async () => (await bg()) === 'rgb(250, 249, 245)');
    win.setChromeColors('#1a1916');
    await until(async () => (await bg()) === 'rgb(26, 25, 22)');
    const fg = await win.webContents.executeJavaScript("getComputedStyle(document.body).color");
    assert.equal(fg, 'rgb(237, 232, 223)');
    win.destroy();
    console.log('title bar follows the page');

    // 2. The screen picker shows pictures, screens first, and returns the choice.
    const owner = new BrowserWindow({ show: false });
    const pic = nativeImage.createFromPath(path.join(root, '../desktop/icons/app.png')).resize({ width: 64, height: 36 });
    const sources = [
      { id: 'window:1', name: 'Notepad', thumbnail: pic },
      { id: 'screen:0', name: 'Screen 1', thumbnail: pic },
      { id: 'window:2', name: 'Browser', thumbnail: nativeImage.createEmpty() },
    ];
    const items = pickerItems(sources);
    assert.deepEqual(items.map(i => i.id), ['screen:0', 'window:1', 'window:2']);
    assert.match(items[0].thumb, /^data:image\/png;base64,/); assert.equal(items[2].thumb, '');
    const choice = pickSource(owner, sources, 'http://server');
    const picker = await until(() => BrowserWindow.getAllWindows().find(w => w !== owner && w.getParentWindow() === owner));
    await until(() => picker.webContents.executeJavaScript("document.querySelectorAll('.tile').length === 3 && !!document.querySelector('.tile img')"));
    const firstSelected = await picker.webContents.executeJavaScript("document.querySelector('#screens .tile').getAttribute('aria-selected')");
    assert.equal(firstSelected, 'true');
    await picker.webContents.executeJavaScript("document.querySelectorAll('#windows .tile')[1].click(); document.querySelector('#share').click()");
    assert.equal((await choice).id, 'window:2');
    const cancelled = pickSource(owner, sources, '');
    const picker2 = await until(() => BrowserWindow.getAllWindows().find(w => w !== owner && w.getParentWindow() === owner));
    await until(() => picker2.webContents.executeJavaScript("document.querySelectorAll('.tile').length === 3"));
    picker2.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    assert.equal(await cancelled, null);
    owner.destroy();
    console.log('screen picker chooses by picture');

    // 3. The address screen: the failure panel and the recent servers.
    const failure = { server: 'http://192.168.0.5:5173', message: 'ECONNREFUSED' };
    let recent = ['http://192.168.0.5:5173', 'https://home.example'];
    ipcMain.handle('connection:current', () => failure.server);
    ipcMain.handle('connection:failure', () => failure);
    ipcMain.handle('connection:recent', () => recent);
    ipcMain.handle('connection:forget', (_e, v) => { recent = recent.filter(s => s !== v); return recent; });
    ipcMain.handle('connection:connect', () => { throw new Error('still down'); });
    const setup = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, '../desktop/setup-preload.cjs'), contextIsolation: true, sandbox: true } });
    await setup.loadURL(pathToFileURL(path.join(root, '../desktop/setup.html')).href);
    const state = () => setup.webContents.executeJavaScript("({failure:!document.querySelector('#failure').hidden,server:document.querySelector('#failureServer').textContent,countdown:document.querySelector('#countdown').textContent,recent:[...document.querySelectorAll('.recent-open')].map(b=>b.textContent)})");
    const s1 = await until(async () => { const s = await state(); return s.recent.length ? s : null; });
    assert.equal(s1.failure, true); assert.equal(s1.server, failure.server); assert.ok(s1.countdown.length > 0, 'it counts down to a retry');
    assert.deepEqual(s1.recent, recent);
    await setup.webContents.executeJavaScript("document.querySelectorAll('.recent-remove')[1].click()");
    await until(async () => (await state()).recent.length === 1);
    setup.destroy();
    console.log('address screen: failure, retry, recent servers');

    console.log('FEATURES_SMOKE passed');
    clearTimeout(timer); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
