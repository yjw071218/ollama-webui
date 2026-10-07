import { BrowserWindow, WebContentsView, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachShortcuts } from './shortcuts.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const shellURL = pathToFileURL(path.join(root, 'chrome.html')).href;
export const chromeOptions = { titleBarStyle: 'hidden', titleBarOverlay: { color: '#211f1c', symbolColor: '#ede8df', height: 44 }, backgroundColor: '#211f1c', autoHideMenuBar: true };
export function createClientWindow(options, actions) {
  const win = new BrowserWindow({ ...options, ...chromeOptions,
    webPreferences: { preload: path.join(root, 'chrome-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const view = new WebContentsView({webPreferences: options.webPreferences});
  win.contentView.addChildView(view);
  win.clientContents = view.webContents;
  win.loadClientURL = url => view.webContents.loadURL(url);
  attachShortcuts(win, view.webContents); // F5, Ctrl+F5, F11 (shortcuts.mjs)
  const resize = () => { const [width, height] = win.getContentSize(); const top = win.isFullScreen() ? 0 : 44; view.setBounds({x:0,y:top,width,height:Math.max(0,height-top)}); };
  for (const event of ['resize','enter-full-screen','leave-full-screen']) win.on(event,resize);
  resize();
  win.webContents.on('will-navigate', event=>event.preventDefault());
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const command = (event, action) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== shellURL) return;
    if (action === 'reload') view.webContents.reload();
    else if (action === 'server') actions.server();
    else if (action === 'updates') actions.updates();
    else if (action === 'menu') actions.menu(win);
  };
  ipcMain.on('chrome:action',command);
  win.on('closed',()=>{ ipcMain.removeListener('chrome:action',command); if (!view.webContents.isDestroyed()) view.webContents.close(); });
  win.loadURL(shellURL);
  return win;
}
