/**
 * Choosing what to share for a screen capture, by its picture.
 *
 * The choice used to be the app dialog with one button per screen and window
 * -- up to twenty names, no thumbnails, the dialog growing past the screen.
 * This is a modal of its own: a grid of thumbnails, screens first, chosen
 * with a click, arrow keys and Enter, or Escape to cancel.
 *
 * Resolves with the chosen source, or null.
 */
import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tr } from './i18n.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const url = pathToFileURL(path.join(root, 'capture.html')).href;

/** What the picker shows of each source: screens first, then windows, at most 24. */
export const pickerItems = (sources) => {
  const list = (sources || []).filter(s => s && s.id && s.name);
  const screens = list.filter(s => String(s.id).startsWith('screen:'));
  const windows = list.filter(s => !String(s.id).startsWith('screen:'));
  return [...screens, ...windows].slice(0, 24).map((s, index) => ({
    index, id: s.id, name: s.name, screen: String(s.id).startsWith('screen:'),
    thumb: s.thumbnail && !s.thumbnail.isEmpty?.() ? s.thumbnail.toDataURL() : '',
  }));
};

export function pickSource(owner, sources, detail = '') {
  return new Promise((resolve) => {
    const items = pickerItems(sources);
    if (!owner || owner.isDestroyed() || !items.length) { resolve(null); return; }
    const win = new BrowserWindow({
      parent: owner, modal: true, show: false, frame: false, width: 760, height: 560, minWidth: 520, minHeight: 380,
      backgroundColor: '#292620', title: tr('화면 캡처', 'Screen capture'),
      webPreferences: { preload: path.join(root, 'capture-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenu(null);
    const valid = (event) => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === url;
    let chosen = null;
    const ready = (event) => { if (valid(event)) event.sender.send('capture:data', { items, detail }); };
    const reply = (event, index) => {
      if (!valid(event)) return;
      const item = Number.isInteger(index) ? items[index] : null;
      chosen = item ? (sources || []).find(s => s.id === item.id) || null : null;
      win.close();
    };
    ipcMain.on('capture:ready', ready);
    ipcMain.on('capture:reply', reply);
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      ipcMain.removeListener('capture:ready', ready);
      ipcMain.removeListener('capture:reply', reply);
      resolve(chosen);
    });
    win.once('ready-to-show', () => win.show());
    win.loadURL(url).catch(() => { if (!win.isDestroyed()) win.close(); });
  });
}
