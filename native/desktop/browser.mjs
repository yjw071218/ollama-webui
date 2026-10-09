/*
 * Links from the page open here, inside the app, instead of in the system
 * browser -- and not in a window of their own either: the page slides in
 * over the chat, under the app's own title bar, with a slim bar of back /
 * forward / reload / address, a button to hand it to the real browser, and
 * one to close it and be back in the chat where you were.
 *
 * The site runs in its own session (persist:inapp-browser), sandboxed, with
 * no preload and every permission refused -- it is somebody else's page, and
 * it gets nothing of the app's or the server's.
 */
import { BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeColors } from './theme.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const barURL = pathToFileURL(path.join(root, 'browser.html')).href;
const TITLE = 44;   // the app's own title bar (chrome.mjs), which stays on top
const BAR = 42;     // this browser's bar
const web = (url) => { try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; } };

let browserSession = null;
const siteSession = () => {
  if (browserSession) return browserSession;
  browserSession = session.fromPartition('persist:inapp-browser');
  browserSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  browserSession.setPermissionCheckHandler(() => false);
  return browserSession;
};

/* What was typed in the address bar, as a URL: an address as it is, a host
   with a dot as https (localhost and bare IPs as http), anything else a search. */
export const addressToUrl = (value) => {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/|$)/i.test(v)) return 'http://' + v;
  if (/^[^\s]+\.[^\s]+$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
};

const embedded = new WeakMap(); // app window -> its browser

/** Opens `url` over the chat in `parent`, reusing the one already open there. */
export function openInAppBrowser(url, { parent, background } = {}) {
  if (!web(url)) return null;
  const host = parent && !parent.isDestroyed() ? parent : BrowserWindow.getFocusedWindow();
  if (!host || host.isDestroyed()) { void shell.openExternal(url); return null; }
  const open = embedded.get(host);
  if (open && !open.closed) { open.load(url); open.reveal(); return open; }
  const b = embed(host, background);
  embedded.set(host, b);
  b.load(url);
  return b;
}

function embed(host, background) {
  const colors = chromeColors(background);
  const bar = new WebContentsView({ webPreferences: { preload: path.join(root, 'browser-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const view = new WebContentsView({ webPreferences: { session: siteSession(), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  bar.setBackgroundColor(colors.bg);
  view.setBackgroundColor(colors.bg);
  host.contentView.addChildView(view);
  host.contentView.addChildView(bar);
  const site = view.webContents;
  const nav = site.navigationHistory;
  const b = { closed: false };

  /* Laid out under the title bar, over exactly the area the chat has. `shift`
     slides it in from a little below, the way the app's own panels arrive. */
  let shift = 0;
  const layout = () => {
    if (b.closed || host.isDestroyed()) return;
    const [w, h] = host.getContentSize();
    const top = (host.isFullScreen() ? 0 : TITLE) + shift;
    bar.setBounds({ x: 0, y: top, width: w, height: BAR });
    view.setBounds({ x: 0, y: top + BAR, width: w, height: Math.max(0, h - top - BAR) });
  };
  let anim = null;
  b.reveal = () => {
    clearInterval(anim);
    shift = 18; layout();
    const began = Date.now();
    anim = setInterval(() => {
      const t = Math.min(1, (Date.now() - began) / 150);
      shift = Math.round(18 * (1 - t) ** 3);
      layout();
      if (t >= 1) clearInterval(anim);
    }, 16);
    site.focus();
  };
  const events = ['resize', 'enter-full-screen', 'leave-full-screen'];
  for (const ev of events) host.on(ev, layout);

  b.load = (target) => { if (web(target)) void site.loadURL(target).catch(() => {}); };
  const sendState = () => {
    if (b.closed || bar.webContents.isDestroyed()) return;
    bar.webContents.send('browser:state', {
      url: site.getURL(), title: site.getTitle(), loading: site.isLoading(),
      back: nav ? nav.canGoBack() : site.canGoBack(),
      forward: nav ? nav.canGoForward() : site.canGoForward(),
      colors, embedded: true,
    });
  };
  const goBack = () => {
    // Back from the first page is back to the chat.
    if (nav ? nav.canGoBack() : site.canGoBack()) { nav ? nav.goBack() : site.goBack(); } else b.close();
  };
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) site.on(ev, sendState);
  // A pop-up opens in this same view; anything not http(s) is refused.
  site.setWindowOpenHandler(({ url: next }) => { b.load(next); return { action: 'deny' }; });
  site.on('will-navigate', (e, next) => { if (!web(next)) e.preventDefault(); });
  site.on('will-attach-webview', (e) => e.preventDefault());
  const keys = (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key;
    if (input.alt && key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (input.alt && key === 'ArrowRight') { e.preventDefault(); nav ? nav.goForward() : site.goForward(); }
    else if (key === 'F5') { e.preventDefault(); site.reload(); }
    else if (input.control && key.toLowerCase() === 'w') { e.preventDefault(); b.close(); }
    else if (input.control && key.toLowerCase() === 'l') { e.preventDefault(); bar.webContents.focus(); bar.webContents.send('browser:focusAddress'); }
    else if (key === 'Escape' && site.isLoading()) site.stop();
  };
  site.on('before-input-event', keys);

  bar.webContents.on('will-navigate', (e) => e.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const fromBar = (e) => e.sender === bar.webContents && e.senderFrame?.url === barURL;
  const command = (e, action, value) => {
    if (!fromBar(e)) return;
    if (action === 'back') goBack();
    else if (action === 'forward') nav ? nav.goForward() : site.goForward();
    else if (action === 'reload') site.reload();
    else if (action === 'stop') site.stop();
    else if (action === 'close') b.close();
    else if (action === 'external') { const u = site.getURL(); if (web(u)) void shell.openExternal(u); }
    else if (action === 'go' && typeof value === 'string') b.load(addressToUrl(value));
  };
  const ready = (e) => { if (fromBar(e)) sendState(); };
  ipcMain.on('browser:action', command);
  ipcMain.on('browser:ready', ready);

  b.close = () => {
    if (b.closed) return;
    b.closed = true;
    clearInterval(anim);
    ipcMain.removeListener('browser:action', command);
    ipcMain.removeListener('browser:ready', ready);
    if (!host.isDestroyed()) {
      for (const ev of events) host.removeListener(ev, layout);
      try { host.contentView.removeChildView(bar); host.contentView.removeChildView(view); } catch { /* gone */ }
      host.clientContents?.focus?.();
    }
    if (!site.isDestroyed()) site.close();
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
    if (embedded.get(host) === b) embedded.delete(host);
  };
  host.once('closed', b.close);

  void bar.webContents.loadURL(barURL);
  b.reveal();
  return b;
}
