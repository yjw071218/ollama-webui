const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('appDialog',{
 ready:callback=>{ipcRenderer.once('app-dialog:data',(_event,data)=>callback(data));ipcRenderer.send('app-dialog:ready');},
 reply:index=>ipcRenderer.send('app-dialog:reply',index)
});