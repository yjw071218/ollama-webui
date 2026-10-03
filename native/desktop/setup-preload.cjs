const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', {
  current: () => ipcRenderer.invoke('connection:current'),
  connect: value => ipcRenderer.invoke('connection:connect', value),
});
