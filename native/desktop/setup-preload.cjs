const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('connection', {
  current: () => ipcRenderer.invoke('connection:current'),
  connect: value => ipcRenderer.invoke('connection:connect', value),
  recent: () => ipcRenderer.invoke('connection:recent'),
  forget: value => ipcRenderer.invoke('connection:forget', value),
  failure: () => ipcRenderer.invoke('connection:failure'),
});
