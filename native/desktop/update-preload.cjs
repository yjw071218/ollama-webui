const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('appUpdate', {
  subscribe: callback => { ipcRenderer.on('update:state', (_event, state) => callback(state)); ipcRenderer.send('update:ready'); },
  action: name => ipcRenderer.send('update:action', String(name)),
});
