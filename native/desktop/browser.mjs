/*
 * Links from the page open here, inside the app, instead of in the system
 * browser: a window with back / forward / reload / address and a button to
 * hand the page on to the real browser when that is wanted.
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
const BAR = 44;
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

let last = null;

/** Opens `url` in the in-app browser, reusing the window if one is open. */
export function openInAppBrowser(url, { parent, background } = {}) {
  if (!web(url)) return null;
  if (last && !last.isDestroyed()) {
    last.loadSite(url);
    if (last.isMinimized()) last.restore();
    last.show(); last.focus();
    return last;
  }
  const colors = chromeColors(background);
  const bounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const win = new BrowserWindow({
    width: bounds ? Math.round(bounds.width * 0.9) : 1200,
    height: bounds ? Math.round(bounds.height * 0.9) : 820,
    minWidth: 420, minHeight: 300,
    backgroundColor: colors.bg, autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: colors.bg, symbolColor: colors.fg, height: BAR },
    webPreferences: { preload: path.join(root, 'browser-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const view = new WebContentsView({ webPreferences: { session: siteSession(), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  const site = view.webContents;
  const resize = () => { const [w, h] = win.getContentSize(); view.setBounds({ x: 0, y: BAR, width: w, height: Math.max(0, h - BAR) }); };
  win.on('resize', resize);
  resize();

  const nav = site.navigationHistory;
  win.loadSite = (target) => { if (web(target)) void site.loadURL(target).catch(() => {}); };
  const sendState = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('browser:state', {
      url: site.getURL(), title: site.getTitle(), loading: site.isLoading(),
      back: nav ? nav.canGoBack() : site.canGoBack(),
      forward: nav ? nav.canGoForward() : site.canGoForward(),
      colors,
    });
    win.setTitle(site.getTitle() || 'Ollama WebUI');
  };
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) site.on(ev, sendState);
  // A pop-up opens in this same window; anything not http(s) is refused.
  site.setWindowOpenHandler(({ url: next }) => { win.loadSite(next); return { action: 'deny' }; });
  site.on('will-navigate', (e, next) => { if (!web(next)) e.preventDefault(); });
  site.on('will-attach-webview', (e) => e.preventDefault());
  site.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt && input.key === 'ArrowLeft') { e.preventDefault(); nav ? nav.goBack() : site.goBack(); }
    else if (input.alt && input.key === 'ArrowRight') { e.preventDefault(); nav ? nav.goForward() : site.goForward(); }
    else if (input.key === 'F5') { e.preventDefault(); site.reload(); }
    else if (input.key === 'Escape' && site.isLoading()) site.stop();
  });

  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const fromBar = (e) => e.sender === win.webContents && e.senderFrame?.url === barURL;
  const command = (e, action, value) => {
    if (!fromBar(e)) return;
    if (action === 'back') nav ? nav.goBack() : site.goBack();
    else if (action === 'forward') nav ? nav.goForward() : site.goForward();
    else if (action === 'reload') site.reload();
    else if (action === 'stop') site.stop();
    else if (action === 'external') { const u = site.getURL(); if (web(u)) void shell.openExternal(u); }
    else if (action === 'go' && typeof value === 'string') win.loadSite(addressToUrl(value));
  };
  const ready = (e) => { if (fromBar(e)) sendState(); };
  ipcMain.on('browser:action', command);
  ipcMain.on('browser:ready', ready);
  win.on('closed', () => {
    ipcMain.removeListener('browser:action', command);
    ipcMain.removeListener('browser:ready', ready);
    if (!site.isDestroyed()) site.close();
    if (last === win) last = null;
  });
  void win.loadURL(barURL);
  win.loadSite(url);
  last = win;
  return win;
}
