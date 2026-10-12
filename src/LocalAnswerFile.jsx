import React, {useState} from 'react';
import {api} from './session.jsx';
import FilePreview from './FilePreview.jsx';
export default function LocalAnswerFile({href,children,...props}) {
  const [file,setFile]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  return <><a {...props} href={href} aria-busy={busy} onClick={async event=>{
    event.preventDefault();event.stopPropagation();if(busy)return;setBusy(true);setError('');
    try {
      const value=await api('/api/auth/answer-file',{method:'POST',body:{path:href}});
      const bytes=Uint8Array.from(atob(value.base64),c=>c.charCodeAt(0));
      setFile({bytes,name:value.name});
    }catch(e){
      if(window.ollamaNative?.platform==='desktop'&&window.ollamaNative?.openLocalPath){try{await window.ollamaNative.openLocalPath(href);}catch(nativeError){setError(nativeError.message);}}
      else setError(e.message);
    }finally{setBusy(false);}
  }}>{children}{busy?' · 파일 여는 중…':''}</a>{error&&<span role="alert"> {error}</span>}{file&&<FilePreview file={file} onClose={()=>setFile(null)}/>}</>;
}
