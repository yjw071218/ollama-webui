import PdfPreview from './PdfPreview.jsx';
import React,{useEffect,useState,useRef} from 'react';
import {createPortal} from 'react-dom';
import './filePreview.css';
export default function FilePreview({file,onClose,children}) {
  const [url,setUrl]=useState(''),[error,setError]=useState(''),[text,setText]=useState(''),[kind,setKind]=useState('');
  const dialog=useRef(null);
  useEffect(()=>{const previous=document.activeElement;dialog.current?.focus();const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();onClose();}if(e.key==='Tab'){const nodes=[...dialog.current.querySelectorAll('button:not(:disabled),a[href],iframe,[tabindex="0"]')];const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',key,true);return()=>{document.removeEventListener('keydown',key,true);previous?.focus();};},[onClose]);
  useEffect(()=>{
    if(!file)return;let disposed=false,objectUrl='';setError('');setUrl('');setText('');setKind('');
    (async()=>{try{
      const ext=file.name.split('.').pop().toLowerCase();let bytes=file.bytes,mime='application/pdf',type='pdf';
      if(['png','jpg','jpeg','webp','gif'].includes(ext)){mime='image/'+(ext==='jpg'?'jpeg':ext);type='image';}
      else if(['txt','md','tex','json','csv','tsv'].includes(ext)){if(!disposed){setText(new TextDecoder().decode(bytes));setKind('text');}return;}
      else if(['html','htm','svg'].includes(ext)){mime=ext==='svg'?'image/svg+xml':'text/html';type='html';}
      else if(ext!=='pdf'){const {convertOfficeBytes}=await import('./officeEditing.js');bytes=await convertOfficeBytes(bytes,ext,'pdf');}
      objectUrl=URL.createObjectURL(new Blob([bytes],{type:mime}));if(!disposed){setUrl(objectUrl);setKind(type);}else URL.revokeObjectURL(objectUrl);
    }catch(e){if(!disposed)setError(e.message);}})();
    return()=>{disposed=true;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[file]);
  return createPortal(<div className="file-preview-backdrop"><section className="file-preview-dialog" role="dialog" aria-modal="true" aria-label={file?.name||'문서 미리보기'} tabIndex={-1} ref={dialog}>
    <header className="file-preview-toolbar"><strong>{file?.name||'문서 미리보기'}</strong>{file&&<button onClick={async()=>{try{const {downloadOffice}=await import('./officeEditing.js');const i=file.name.lastIndexOf('.');await downloadOffice(file.bytes,file.name.slice(0,i),file.name.slice(i+1));}catch(e){setError(e.message);}}}>다운로드</button>}<button onClick={onClose} aria-label="미리보기 닫기">닫기</button></header>
    <div className="file-preview-body">{children||<>{error?<p role="alert">미리보기를 만들지 못했습니다. {error} 원본은 다운로드할 수 있습니다.</p>:!kind?<p role="status">미리보기를 만드는 중…</p>:kind==='text'?<pre>{text}</pre>:kind==='image'?<img src={url} alt={file.name}/>:kind==='pdf'?<PdfPreview url={url}/>:<iframe title={file.name} src={url} sandbox=""/>}</>}</div>
  </section></div>,document.body);
}
