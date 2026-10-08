const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('capturePicker', {
  ready: (callback) => { ipcRenderer.once('capture:data', (_event, data) => callback(data)); ipcRenderer.send('capture:ready'); },
  reply: (index) => ipcRenderer.send('capture:reply', index),
});
