import { localize } from './page-i18n.mjs';
localize();
window.appDialog.ready(data=>{
 document.getElementById('title').textContent=data.title;
 document.getElementById('message').textContent=data.message;
 document.getElementById('detail').textContent=data.detail;
 const footer=document.getElementById('buttons');
 data.buttons.forEach((label,index)=>{const button=document.createElement('button');button.textContent=label;button.onclick=()=>window.appDialog.reply(index);footer.append(button);});
 document.getElementById('close').onclick=()=>window.appDialog.reply(data.cancelId);
 document.addEventListener('keydown',event=>{
   if(event.key==='Escape'){event.preventDefault();window.appDialog.reply(data.cancelId);}
   if(event.key==='Tab'){const nodes=[...document.querySelectorAll('button')];const at=nodes.indexOf(document.activeElement);event.preventDefault();nodes[(at+(event.shiftKey?-1:1)+nodes.length)%nodes.length].focus();}
 });
 footer.children[data.defaultId]?.focus();
});