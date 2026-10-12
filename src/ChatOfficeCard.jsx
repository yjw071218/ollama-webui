import FilePreview from './FilePreview.jsx';
import { SlidePreview } from './SlidePreview.jsx';
import './chatOfficeCard.css';
import { slideScene } from './officeDesign.js';
import { Download, FileText, Presentation, Sheet } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { buildChatOffice, parseChatOffice } from './chatOffice.js';

export default function ChatOfficeCard({ source }) {
  const parsed = useMemo(() => { try { return { document: parseChatOffice(source) }; } catch (error) { return { error: error.message }; } }, [source]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const [preview,setPreview]=useState(false);
  const [previewFile,setPreviewFile]=useState(null);
  if (!parsed.document) return <section className="tool-block"><p role="status">문서 내용을 받는 중입니다. 응답이 끝난 뒤에도 파일이 표시되지 않으면 다시 생성을 요청해 주세요.</p><details><summary>문서 상태</summary>{parsed.error}</details></section>;
  const doc = parsed.document;
  const download = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const bytes = await buildChatOffice(doc);
      const { downloadOffice } = await import('./officeEditing.js');
      await downloadOffice(bytes, doc.title, doc.format);
    } catch (e) { setError(e.message); }
    finally { lock.current = false; setBusy(false); }
  };
  const openActual = async (format=doc.format) => {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const bytes=await buildChatOffice({...doc,format});setPreviewFile({name:doc.title+'.'+format,bytes});}
    catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}
  };
  const Icon = doc.slides ? Presentation : doc.sheets ? Sheet : FileText;
  const first = doc.slides?.[0];
  return <section className="chat-office-card" aria-label="대화에서 만든 오피스 문서">
    {first && <svg className="office-cover" viewBox="0 0 1333.3 750" role="img" aria-label="첫 슬라이드 미리보기">{slideScene(first).map((shape,i)=>shape.type==='image'?<image key={i} href={shape.src} x={shape.x*100} y={shape.y*100} width={shape.w*100} height={shape.h*100} preserveAspectRatio="none"/>:shape.type==='ellipse'?<ellipse key={i} cx={(shape.x+shape.w/2)*100} cy={(shape.y+shape.h/2)*100} rx={shape.w*50} ry={shape.h*50} fill={'#'+shape.fill}/>:shape.type==='rect'?<rect key={i} x={shape.x*100} y={shape.y*100} width={shape.w*100} height={shape.h*100} fill={'#'+shape.fill}/>:<foreignObject key={i} x={shape.x*100} y={shape.y*100} width={shape.w*100} height={shape.h*100}><div xmlns="http://www.w3.org/1999/xhtml" style={{fontSize:shape.size*100/72,color:'#'+shape.color,fontWeight:shape.bold?700:400,lineHeight:1.2,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{shape.text}</div></foreignObject>)}</svg>}
    <div className="office-card-content"><div className="office-card-heading"><span className="office-file-icon"><Icon size={24}/></span><div>
    <strong>{doc.title}</strong>
    <p>{doc.format.toUpperCase()} · {doc.slides ? `${doc.slides.length}개 슬라이드` : doc.sheets ? `${doc.sheets.length}개 시트` : '문서'}</p>
    </div></div><button className="office-download" type="button" disabled={busy} onClick={download}><Download size={16}/>{busy ? '파일 만드는 중…' : `${doc.format.toUpperCase()} 다운로드`}</button>
    <button className="office-preview-button" disabled={busy} onClick={()=>openActual()}>실제 파일 보기</button>
    {doc.format==='tex'&&<button className="office-preview-button" disabled={busy} onClick={()=>openActual('pdf')}>PDF 만들기</button>}
    <button className="office-preview-button" disabled={busy} onClick={()=>['html','svg','pdf'].includes(doc.format)?openActual():setPreview(true)}>미리보기</button>
    {error && <p role="alert">{error} 다시 다운로드를 누르면 재시도합니다.</p>}
    <details><summary>내용 미리보기</summary>
      {doc.slides ? doc.slides.map((s,i) => <div key={i}><h4>{i+1}. {s.title}</h4><p style={{ whiteSpace:'pre-wrap' }}>{s.body}</p>{s.items.map((v,j)=><p key={j}>{v.title}: {v.body}</p>)}</div>)
        : doc.sheets ? doc.sheets.map((s,i)=><div key={i}><h4>{s.name}</h4><pre style={{ overflow:'auto' }}>{s.rows.slice(0,20).map(row=>row.join('\t')).join('\n')}</pre></div>)
        : <p style={{ whiteSpace:'pre-wrap' }}>{doc.text}</p>}
    </details></div>
    {preview&&<FilePreview onClose={()=>setPreview(false)}>
      {doc.slides ? doc.slides.map((slide,i)=><figure className="file-slide" key={i}><SlidePreview slide={slide} index={i}/><figcaption>{i+1} / {doc.slides.length}</figcaption></figure>)
      :doc.sheets ? doc.sheets.map((sheet,i)=><section className="file-sheet" key={i}><h2>{sheet.name}</h2><table><tbody>{sheet.rows.map((row,j)=><tr key={j}>{row.map((cell,k)=>j===0?<th key={k}>{String(cell)}</th>:<td key={k}>{String(cell)}</td>)}</tr>)}</tbody></table><small>수식 계산과 인쇄 배치는 실제 파일에서 확인할 수 있습니다.</small></section>)
      :<article className="file-paper"><h1>{doc.title}</h1>{doc.text}</article>}
    </FilePreview>}
    {previewFile&&<FilePreview file={previewFile} onClose={()=>setPreviewFile(null)}/>}

  </section>;
}
