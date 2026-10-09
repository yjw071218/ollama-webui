import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachShortcuts } from './shortcuts.mjs';
import { chromeColors } from './theme.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const shellURL = pathToFileURL(path.join(root, 'chrome.html')).href;
export const chromeOptions = { titleBarStyle: 'hidden', titleBarOverlay: { color: '#211f1c', symbolColor: '#ede8df', height: 44 }, backgroundColor: '#211f1c', autoHideMenuBar: true };
export function createClientWindow({ pageBackground, ...options }, actions) {
  /* The title bar opens in the page's colours from last time (theme.mjs), so
     a light page does not start under a black strip. */
  let colors = chromeColors(pageBackground);
  const win = new BrowserWindow({ ...options, ...chromeOptions,
    titleBarOverlay: { color: colors.bg, symbolColor: colors.fg, height: 44 }, backgroundColor: colors.bg,
    webPreferences: { preload: path.join(root, 'chrome-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const view = new WebContentsView({webPreferences: { ...options.webPreferences, backgroundThrottling: false, preload: path.join(root, 'client-preload.cjs') }});
  /* Until the page paints, the view shows its own background, which is white:
     a dark app flashed white on every launch and reload. The page's own colour
     from last time (main.mjs pageBackground), else the title bar's. */
  view.setBackgroundColor(colors.bg);
  win.contentView.addChildView(view);
  win.clientContents = view.webContents;
  win.loadClientURL = url => view.webContents.loadURL(url);
  /** Paint the bar -- the shell page and Windows' own buttons -- in the page's colours. */
  win.setChromeColors = (background) => {
    const next = chromeColors(background);
    if (next.bg === colors.bg && !win.isDestroyed()) return;
    colors = next;
    if (win.isDestroyed()) return;
    try { win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.fg, height: 44 }); } catch { /* not on this Windows */ }
    win.setBackgroundColor(colors.bg);
    if (!win.webContents.isDestroyed()) win.webContents.send('chrome:colors', colors);
  };
  attachShortcuts(win, view.webContents); // F5, Ctrl+F5, F11 (shortcuts.mjs)
  const resize = () => { const [width, height] = win.getContentSize(); const top = win.isFullScreen() ? 0 : 44; view.setBounds({x:0,y:top,width,height:Math.max(0,height-top)}); };
  for (const event of ['resize','enter-full-screen','leave-full-screen']) win.on(event,resize);
  resize();
  win.webContents.on('will-navigate', event=>event.preventDefault());
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const fromShell = event => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === shellURL;
  const command = (event, action) => {
    if (!fromShell(event)) return;
    if (action === 'reload') view.webContents.reload();
    else if (action === 'server') actions.server();
    else if (action === 'updates') actions.updates();
    else if (action === 'menu') actions.menu(win);
    else if (action === 'newChat') actions.newChat?.(win);
  };
  const ready = event => { if (fromShell(event)) event.sender.send('chrome:colors', colors); };
  ipcMain.on('chrome:action',command);
  ipcMain.on('chrome:ready',ready);
  win.on('closed',()=>{ ipcMain.removeListener('chrome:action',command); ipcMain.removeListener('chrome:ready',ready); if (!view.webContents.isDestroyed()) view.webContents.close(); });
  win.loadURL(shellURL);
  return win;
}
