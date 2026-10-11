const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quickAsk', {
  ready: (callback) => ipcRenderer.once('quickask:data', (_e, data) => callback(data)),
  choose: (kind, text, question) => ipcRenderer.send('quickask:choose', String(kind), String(text || ''), String(question || '')),
  answer: callback => ipcRenderer.on('quickask:answer', (_e, data) => callback(data)),
  close: () => ipcRenderer.send('quickask:close'),
});
