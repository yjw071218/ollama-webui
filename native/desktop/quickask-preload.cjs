const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quickAsk', {
  ready: (callback) => ipcRenderer.once('quickask:data', (_e, data) => callback(data)),
  choose: (kind, text, question) => ipcRenderer.send('quickask:choose', String(kind), String(text || ''), String(question || '')),
  close: () => ipcRenderer.send('quickask:close'),
});
