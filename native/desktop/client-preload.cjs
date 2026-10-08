/*
 * The server's page in the Windows app: what the app offers it, and what it
 * watches of it. The Android app's counterpart is assets/native.js.
 *
 *  - window.ollamaNative: the platform, server change and update check (the
 *    page's account menu shows them), busy() while an answer is written (the
 *    taskbar shows progress, and the button flashes when it ends unseen), and
 *    onAction() for what the app asks of the page -- a new chat from the tray,
 *    the jump list or the global key (src/nativeEvents.js).
 *  - The page's background colour, so the title bar takes it (theme.mjs).
 *
 * Every message is checked in main.mjs against the page's origin.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ollamaNative', {
  platform: 'desktop',
  changeServer: () => ipcRenderer.invoke('client:changeServer'),
  checkUpdates: () => ipcRenderer.invoke('client:checkUpdates'),
  busy: (busy) => ipcRenderer.send('client:busy', !!busy),
  onAction: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, request) => { try { callback(request); } catch { /* the page's own */ } };
    ipcRenderer.on('client:action', handler);
    return () => ipcRenderer.removeListener('client:action', handler);
  },
});

let last = '';
const send = () => {
  const css = getComputedStyle(document.body || document.documentElement).backgroundColor;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css || '');
  if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return;
  const color = '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('');
  if (color === last) return;
  last = color;
  ipcRenderer.send('client:chrome', color);
};
// Read once per frame, not once per mutation: each read recalculates style.
let queued = false;
const queue = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; send(); });
};
const watch = () => {
  send();
  const observer = new MutationObserver(queue);
  const what = { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] };
  observer.observe(document.documentElement, what);
  if (document.body) observer.observe(document.body, what);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', queue);
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
else watch();
window.addEventListener('load', send, { once: true });
