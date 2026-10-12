import React,{useEffect,useRef,useState} from 'react';
export default function PdfPreview({url}) {
  const canvas=useRef(null),[document,setDocument]=useState(null),[page,setPage]=useState(1),[error,setError]=useState(''),[zoom,setZoom]=useState(1);
  useEffect(()=>{let disposed=false,task;setDocument(null);setPage(1);setError('');(async()=>{try{
    const pdf=await import('pdfjs-dist');if(disposed)return;pdf.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();
    task=pdf.getDocument({url,isEvalSupported:false});const doc=await task.promise;if(!disposed)setDocument(doc);
  }catch(e){if(!disposed)setError(e.message);}})();return()=>{disposed=true;task?.destroy();};},[url]);
  useEffect(()=>{if(!document)return;let cancelled=false,render;
    (async()=>{try{const sheet=await document.getPage(page);if(cancelled)return;const view=sheet.getViewport({scale:1.5*zoom});canvas.current.width=view.width;canvas.current.height=view.height;render=sheet.render({canvasContext:canvas.current.getContext('2d'),viewport:view});await render.promise;}catch(e){if(!cancelled)setError(e.message);}})();
    return()=>{cancelled=true;render?.cancel();};
  },[document,page,zoom]);
  return <div>{error&&<p role="alert">{error}</p>}{!document&&!error&&<p role="status">PDF 읽는 중…</p>}{document&&<nav aria-label="PDF 페이지"><button disabled={page<=1} onClick={()=>setPage(p=>p-1)}>이전</button> {page} / {document.numPages} <button disabled={page>=document.numPages} onClick={()=>setPage(p=>p+1)}>다음</button> <button aria-label="PDF 축소" disabled={zoom<=.75} onClick={()=>setZoom(z=>Math.max(.75,z-.25))}>−</button> {Math.round(zoom*100)}% <button aria-label="PDF 확대" disabled={zoom>=2.5} onClick={()=>setZoom(z=>Math.min(2.5,z+.25))}>+</button></nav>}<canvas ref={canvas} style={{width:`${zoom*100}%`,maxWidth:'none',height:'auto',background:'white'}} aria-label={`PDF ${page}페이지`}/></div>;
}
