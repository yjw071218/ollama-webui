const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appSplitter', {
  send: (kind, x) => ipcRenderer.send('browser:split', String(kind), Number(x) || 0),
  onPlace: (cb) => ipcRenderer.on('split:place', (_e, x) => cb(x)),
  onColors: (cb) => ipcRenderer.on('split:colors', (_e, c) => cb(c)),
});
