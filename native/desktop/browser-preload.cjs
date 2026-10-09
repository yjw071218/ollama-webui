const { contextBridge, ipcRenderer } = require('electron');
const on = (channel) => (callback) => ipcRenderer.on(channel, (_e, value) => callback(value));
contextBridge.exposeInMainWorld('appBrowser', {
  action: (name, value, extra) => ipcRenderer.send('browser:action', String(name), value, extra && typeof extra === 'object' ? JSON.parse(JSON.stringify(extra)) : undefined),
  onFocusAddress: on('browser:focusAddress'),
  onFocusFind: on('browser:focusFind'),
  onAskPrompt: on('browser:askPrompt'),
  onLists: on('browser:lists'),
  onState: (callback) => { ipcRenderer.on('browser:state', (_e, state) => callback(state)); ipcRenderer.send('browser:ready'); },
});
