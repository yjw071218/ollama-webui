const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('appChrome',{
  action: value=>ipcRenderer.send('chrome:action',value),
  onColors: callback=>{ ipcRenderer.on('chrome:colors',(_event,colors)=>callback(colors)); ipcRenderer.send('chrome:ready'); },
});
