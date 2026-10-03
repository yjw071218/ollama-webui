const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('appChrome',{action: value=>ipcRenderer.send('chrome:action',value)});
