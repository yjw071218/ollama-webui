const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appBrowser', {
  action: (name, value) => ipcRenderer.send('browser:action', name, value),
  onState: (callback) => { ipcRenderer.on('browser:state', (_e, state) => callback(state)); ipcRenderer.send('browser:ready'); },
});
