import {BrowserWindow,ipcMain} from 'electron';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const url=pathToFileURL(path.join(root,'dialog.html')).href;
const active=new WeakMap();
export function appDialog(owner,options={}) {
  if(!owner || owner.isDestroyed()) return Promise.resolve({response:options.cancelId??0});
  // Serialize modal requests for a window, including concurrent permission prompts.
  const previous=active.get(owner)||Promise.resolve();
  const result=previous.catch(()=>{}).then(()=>show(owner,options));
  active.set(owner,result); return result;
}
function show(owner,options) {
  return new Promise(resolve=>{
    const buttons=options.buttons?.length?options.buttons:['확인'];
    const cancelId=options.cancelId??0;
    if(owner.isDestroyed()){resolve({response:cancelId});return;}
    const win=new BrowserWindow({parent:owner,modal:true,show:false,frame:false,width:520,height:Math.min(680,290+buttons.length*30),
      resizable:false,backgroundColor:'#292620',title:options.title||'Ollama WebUI',
      webPreferences:{preload:path.join(root,'dialog-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.setMenu(null);
    const valid=event=>event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && event.senderFrame.url===url;
    const ready=event=>{if(valid(event)) event.sender.send('app-dialog:data',{title:options.title||'Ollama WebUI',message:options.message||'',detail:options.detail||'',buttons,cancelId,defaultId:options.defaultId??0});};
    let response=cancelId;
    const reply=(event,index)=>{if(!valid(event)||!Number.isInteger(index)||index<0||index>=buttons.length)return;response=index;win.close();};
    ipcMain.on('app-dialog:ready',ready);ipcMain.on('app-dialog:reply',reply);
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.on('closed',()=>{ipcMain.removeListener('app-dialog:ready',ready);ipcMain.removeListener('app-dialog:reply',reply);resolve({response});});
    win.once('ready-to-show',()=>win.show());
    win.loadURL(url).catch(()=>{if(!win.isDestroyed())win.close();});
  });
}
