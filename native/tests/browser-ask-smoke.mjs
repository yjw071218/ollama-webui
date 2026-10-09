// The in-app browser in real Electron: tabs, find, zoom, bookmarks, and a
// question carrying the page's whole text, a screenshot and its pictures.
import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
app.on('window-all-closed', () => {}); // the test closes the window to mimic quitting
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'inapp-browser-')));
const png = nativeImage.createFromBitmap(Buffer.alloc(200 * 200 * 4, 0x80), { width: 200, height: 200 }).toPNG();
const long = 'LONGTEXT '.repeat(3000);
const server = createServer((req, res) => {
  if (req.url === '/pic.png') { res.setHeader('Content-Type', 'image/png'); res.end(png); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<title>Test page</title><h1>Hello apple world</h1><p>apple banana apple</p><img src="/pic.png" alt="grey square" width=200 height=200><p>${long}END_MARK</p>`);
});
const timeout = setTimeout(() => { console.error('timeout'); app.exit(1); }, 40000);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await wait(50); } return false; };
app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { openInAppBrowser, setBrowserModels, restoreInAppBrowser, sessionOf } = await import('../desktop/browser.mjs');
  let host;
  try {
    host = new BrowserWindow({ show: true, x: -3000, y: 0, width: 1300, height: 900 });
    const sent = [];
    host.clientContents = { isDestroyed: () => false, send: (ch, p) => sent.push([ch, p]), focus() {} };
    let laid = 0; host.layoutClient = () => { laid++; };
    const b = openInAppBrowser(origin + '/', { parent: host });
    const wc = () => b.tabs.find(t => t.view.webContents.getURL().startsWith(origin))?.view.webContents;
    assert.ok(await until(() => wc() && !wc().isLoading() && wc().getTitle() === 'Test page'), 'page loads');
    await wait(300);
    b.command('quick', 'summary');
    assert.ok(await until(() => sent.some(([, x]) => x.type === 'ask')), 'question reaches the chat');
    const [ch, p] = sent.find(([, x]) => x.type === 'ask');
    assert.equal(ch, 'client:action'); assert.equal(p.type, 'ask');
    assert.match(p.text, /요약|Summar/);
    assert.ok(p.page.text.includes('END_MARK'), 'whole text, not a slice');
    assert.ok(p.page.text.includes('grey square'), 'image alt texts');
    assert.equal(p.page.images.length, 2, 'screenshot + the picture');
    assert.ok(p.page.images.every(x => nativeImage.createFromBuffer(Buffer.from(x, 'base64')).getSize().width > 0), 'images decode');
    assert.ok(host.clientLeft > 0 && laid > 0, 'chat docked beside');
    assert.ok(sent.some(([, x]) => x.type === 'browser-dock' && x.docked === true), 'chat told to hide its side panel');
    assert.equal(p.page.focusImage, false);
    let found = null; wc().on('found-in-page', (_e, r) => { if (r.finalUpdate) found = r; });
    b.command('find', 'apple');
    assert.ok(await until(() => found), 'find works'); assert.equal(found.matches, 3);
    b.command('zoomIn'); assert.equal(Math.round(wc().getZoomFactor() * 100), 110);
    b.command('zoomReset'); assert.equal(wc().getZoomFactor(), 1);
    b.command('bookmark');
    const file = path.join(app.getPath('userData'), 'inapp-browser.json');
    assert.ok(await until(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).bookmarks.length === 1; } catch { return false; } }), 'bookmark saved');
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).history.some(h => h.url.startsWith(origin)), 'history saved');
    const errors = []; b.bar.webContents.on('console-message', (e) => { if ((e.level ?? e) === 'error' || e.level === 3) errors.push(e.message); });
    assert.ok(await until(async () => (await b.bar.webContents.executeJavaScript('document.querySelectorAll(".tab").length')) === 1), 'bar draws the tab');
    b.command('panel', 'bookmarks');
    assert.ok(await until(async () => (await b.bar.webContents.executeJavaScript('document.querySelectorAll("#panel-list .entry").length')) === 1), 'bookmark panel lists it');
    b.command('panel', '');
    assert.equal(errors.length, 0, errors.join(' | '));
    b.command('newTab'); assert.equal(b.tabs.length, 2, 'new tab');
    b.command('closeTab', 2); assert.equal(b.tabs.length, 1, 'tab closed');
    setBrowserModels(host, { models: ['llama3', 'qwen3'], selected: 'llama3' });
    assert.ok(await until(async () => (await b.bar.webContents.executeJavaScript('document.querySelector("#model-name").textContent')) === 'llama3'), 'bar shows the model');
    b.command('model', 'qwen3');
    assert.ok(sent.some(([, x]) => x.type === 'browser-model' && x.model === 'qwen3'), 'model choice reaches the chat');
    b.command('model', 'not-installed');
    assert.ok(!sent.some(([, x]) => x.model === 'not-installed'), 'unknown model refused');
    b.command('newTab');
    await until(() => b.tabs.length === 2);
    b.tabs[1].view.webContents.loadURL(origin + '/second');
    assert.ok(await until(() => b.tabs[1].view.webContents.getURL().endsWith('/second')), 'second page');
    b.command('close'); assert.equal(host.clientLeft, 0, 'chat restored');
    const read = () => sessionOf(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(read().tabs.length, 2, 'both pages kept after closing'); assert.equal(read().open, false);
    const again = openInAppBrowser(origin + '/third', { parent: host });
    assert.equal(again.tabs.length, 3, 'old pages come back with the new one');
    host.close();
    assert.ok(await until(() => host.isDestroyed()), 'app window closed');
    assert.equal(read().open, true, 'kept open for the next launch'); assert.equal(read().tabs.length, 3);
    host = new BrowserWindow({ show: true, x: -3000, y: 0, width: 1300, height: 900 });
    host.clientContents = { isDestroyed: () => false, send() {}, focus() {} };
    const restored = restoreInAppBrowser(host);
    assert.equal(restored?.tabs.length, 3, 'pages restored after restart');
    assert.ok(await until(() => restored.tabs.every(t => t.view.webContents.getURL().startsWith(origin))), 'restored pages load');
    assert.ok(sent.some(([, x]) => x.type === 'browser-dock' && x.docked === false), 'side panel comes back');
    console.log('PASS in-app browser: whole page + images to AI, dock, find, zoom, bookmarks, history, tabs');
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { clearTimeout(timeout); host?.destroy(); server.close(); app.exit(process.exitCode || 0); }
});
