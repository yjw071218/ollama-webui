import React, { useEffect, useRef, useState } from 'react';
import localforage from 'localforage';
import { readOffice, editOfficeBytes, createPresentation, createHangul, createWord, createWorkbook, writeWorkbook, convertOfficeBytes, downloadOffice } from './officeEditing.js';
import { normaliseSlide, slideScene, SLIDE_LAYOUTS, OFFICE_THEMES, officePrompt, parseOfficeProposal } from './officeDesign.js';
import { authHeaders } from './session.jsx';
import OfficeSheet from './OfficeSheet.jsx';
import './officeEditor.css';

const store=localforage.createInstance({name:'ollama-webui',storeName:'officeDrafts'});
const exportsFor={pptx:['pptx','ppt','odp','pdf'],docx:['docx','doc','odt','rtf','txt','pdf'],hwpx:['hwpx','hwp'],xlsx:['xlsx','xls','ods','csv','tsv','pdf']};
const layoutNames={section:'섹션 표지',quote:'인용 강조',split:'비대칭 분할',metrics:'핵심 수치',closing:'마무리',title:'표지',body:'본문',columns:'비교',cards:'카드',chart:'차트',timeline:'타임라인'};
export function SlidePreview({slide,index=0}) {
  return <svg className="office-slide-preview" viewBox="0 0 1333.3 750" role="img" aria-label={`슬라이드 ${index+1} 디자인 미리보기`}>
    {slideScene(slide,index+1).map((s,i)=>s.type==='rect'?<rect key={i} x={s.x*100} y={s.y*100} width={s.w*100} height={s.h*100} fill={'#'+s.fill}/>:<foreignObject key={i} x={s.x*100} y={s.y*100} width={s.w*100} height={s.h*100}><div xmlns="http://www.w3.org/1999/xhtml" style={{color:'#'+s.color,fontSize:s.size*100/72,fontWeight:s.bold?700:400,fontFamily:'맑은 고딕, sans-serif',lineHeight:1.2,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{s.text}</div></foreignObject>)}
  </svg>;
}
export default function OfficeEditor({scope,seed={},model,onClose}) {
  const [name,setName]=useState(seed.title||'새 문서'),[mode,setMode]=useState('pptx');
  const [slides,setSlides]=useState([normaliseSlide({title:seed.title||'제목',body:seed.text||'',layout:'title'})]);
  const [text,setText]=useState(seed.text||''),[document,setDocument]=useState(null),[workbook,setWorkbook]=useState(null);
  const [page,setPage]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[hasDraft,setHasDraft]=useState(false);
  const [request,setRequest]=useState(''),[proposal,setProposal]=useState(null),[generating,setGenerating]=useState(false);
  const file=useRef(null),abort=useRef(null), mounted=useRef(true);
  const latest=useRef(); latest.current={name,mode,slides,text,document,page,workbook};
  useEffect(()=>{mounted.current=true;store.getItem(scope).then(v=>{if(mounted.current)setHasDraft(!!v);}).catch(e=>setError(e.message));return()=>{mounted.current=false;abort.current?.abort();};},[scope]);
  const dirty=()=>setSaved(false);
  const save=async()=>{await store.setItem(scope,latest.current);if(mounted.current){setSaved(true);setHasDraft(true);}};
  const restore=async()=>{const v=await store.getItem(scope);if(!v)return;setName(v.name);setMode(v.mode);setSlides((v.slides||[]).map(normaliseSlide));setText(v.text||'');setDocument(v.document||null);setWorkbook(v.workbook||v.document?.workbook||null);setPage(v.page||0);setProposal(null);setSaved(true);};
  const run=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){if(mounted.current)setError(e.name==='AbortError'?'생성을 취소했습니다.':e.message);}finally{if(mounted.current)setBusy(false);}};
  const open=selected=>selected&&run(async()=>{const value=await readOffice(selected);await save();setDocument(value.workbook?null:value);setWorkbook(value.workbook||null);setMode(value.format);setName(value.name);setPage(0);setProposal(null);dirty();});
  const fresh=next=>run(async()=>{await save();setDocument(null);setMode(next);setPage(0);setProposal(null);if(next==='xlsx'&&!workbook)setWorkbook(await createWorkbook());dirty();});
  const exportAs=format=>run(async()=>{
    let bytes=mode==='xlsx'?await writeWorkbook(workbook,format==='pdf'?'xlsx':format):document?editOfficeBytes(document,document.pages):mode==='pptx'?await createPresentation(slides,name):mode==='docx'?createWord(text,name):await createHangul(text);
    if(mode!=='xlsx'||format==='pdf')bytes=await convertOfficeBytes(bytes,mode,format);
    downloadOffice(bytes,name,format);await save();
  });
  const generate=()=>run(async()=>{
    if(!model)throw new Error('채팅에서 사용할 AI 모델을 먼저 선택해 주세요.');
    setGenerating(true);setProposal(null);const controller=new AbortController();abort.current=controller;
    try {
      const context=document?document.pages.flatMap(p=>p.texts).join('\n'):mode==='pptx'?JSON.stringify(slides):mode==='xlsx'?JSON.stringify(workbook):text;
      const response=await fetch('/api/chat',{method:'POST',headers:{...authHeaders('POST'),'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({model,stream:false,think:false,messages:officePrompt(mode,request,context),options:{temperature:.5,num_predict:12000}})});
      if(!response.ok)throw new Error(`AI 요청 실패 (HTTP ${response.status})`);
      const result=await response.json();if(result.error)throw new Error(String(result.error));
      if(mounted.current)setProposal({...parseOfficeProposal(result.message?.content||result.response,mode),mode});
    } finally {abort.current=null;if(mounted.current)setGenerating(false);}
  });
  const applyProposal=()=>run(async()=>{await save();const p=proposal;const next=p.mode==='xlsx'?await createWorkbook(p.sheets):null;setName(p.title);setDocument(null);setPage(0);if(p.slides)setSlides(p.slides);if(p.text!==undefined)setText(p.text);if(next)setWorkbook(next);setProposal(null);dirty();});
  const updateSlide=change=>{setSlides(v=>v.map((s,i)=>i===page?{...s,...change}:s));dirty();};
  const slide=slides[page]||normaliseSlide(), pages=document?document.pages:slides;
  return <div className="office-overlay" role="dialog" aria-modal="true" aria-label="오피스 문서 편집">
    <section className="office-editor">
      <header><strong>오피스 · AI 제작</strong><input aria-label="파일 이름" disabled={busy} value={name} onChange={e=>{setName(e.target.value);dirty();}}/>
        <button disabled={busy} onClick={()=>file.current.click()}>파일 열기</button><button disabled={busy} onClick={()=>run(save)}>{saved?'초안 저장됨':'초안 저장'}</button>
        {hasDraft&&<button disabled={busy} onClick={()=>run(restore)}>저장한 초안</button>}<button disabled={busy} onClick={()=>run(async()=>{await save();onClose();})}>저장 후 닫기</button></header>
      <input ref={file} hidden type="file" accept=".ppt,.pptx,.odp,.doc,.docx,.odt,.rtf,.txt,.hwp,.hwpx,.xls,.xlsx,.xlsb,.ods,.csv,.tsv" onChange={e=>{void open(e.target.files[0]);e.target.value='';}}/>
      {error&&<p className="office-error" role="alert">{error}</p>}
      <nav>{[['pptx','발표자료'],['docx','Word 문서'],['xlsx','Excel 표'],['hwpx','한글 문서']].map(([v,label])=><button key={v} disabled={busy} aria-pressed={mode===v} onClick={()=>fresh(v)}>새 {label}</button>)}
        {exportsFor[mode].map(format=><button key={format} disabled={busy||(mode==='xlsx'&&!workbook)} onClick={()=>exportAs(format)}>{format.toUpperCase()} 저장</button>)}</nav>
      <div className="office-ai"><label htmlFor="office-ai-request">AI에게 제작 요청</label><textarea id="office-ai-request" disabled={busy} value={request} onChange={e=>setRequest(e.target.value)} placeholder="예: 임원 보고용 발표자료 8장을 만들어줘. 짙은 남색 배경, 핵심 지표와 추진 일정 포함."/>
        <button disabled={busy||!request.trim()||!model} onClick={generate}>AI 디자인·제작</button>{generating&&<button onClick={()=>abort.current?.abort()}>생성 취소</button>}
        <span role="status">{busy?(generating?'AI가 문서를 구성하고 있습니다…':'문서를 처리하고 있습니다…'):model?`모델: ${model}`:'채팅에서 모델을 선택해 주세요.'}</span></div>
      {proposal&&<div className="office-proposal"><strong>AI 제안: {proposal.title}</strong><span>{proposal.slides?`${proposal.slides.length}장`:proposal.sheets?`${proposal.sheets.length}개 시트`:'문서 본문'}</span>
        <div className="office-proposal-preview">{proposal.slides?proposal.slides.map((s,i)=><SlidePreview key={i} slide={s} index={i}/>):<pre>{proposal.text||JSON.stringify(proposal.sheets,null,2)}</pre>}</div>
        <button disabled={busy} onClick={applyProposal}>편집기에 적용</button><button disabled={busy} onClick={()=>setProposal(null)}>제안 닫기</button><small>적용 전 현재 작업을 초안으로 저장합니다.</small></div>}
      {document&&<p className="office-note">원본의 텍스트를 편집합니다. 기존 구성 파일은 유지하지만 변환하거나 글 길이가 달라지면 원본 프로그램에서 배치를 확인해 주세요.</p>}
      <fieldset disabled={busy} className="office-content">
        {(document||mode==='pptx')&&<aside>{pages.map((p,i)=><button key={i} className={i===page?'active':''} onClick={()=>setPage(i)}>{mode==='pptx'?'슬라이드':'구역'} {i+1}<small>{p.title||p.texts?.[0]}</small></button>)}
          {!document&&<><button onClick={()=>{setSlides(v=>[...v,normaliseSlide({title:'새 슬라이드'})]);setPage(slides.length);dirty();}}>+ 슬라이드 추가</button><button disabled={slides.length<2} onClick={()=>{setSlides(v=>v.filter((_,i)=>i!==page));setPage(Math.max(0,page-1));dirty();}}>현재 슬라이드 삭제</button></>}</aside>}
        <main>{mode==='xlsx'?workbook&&<OfficeSheet key={name} workbook={workbook} onChange={v=>{setWorkbook(v);dirty();}}/>:document?<div className="office-fields">{document.pages[page]?.texts.map((value,i)=><label key={i}>텍스트 {i+1}<textarea value={value} onChange={e=>{const value=e.target.value;setDocument(prev=>({...prev,pages:prev.pages.map((p,k)=>k===page?{...p,texts:p.texts.map((t,j)=>j===i?value:t)}:p)}));dirty();}}/></label>)}</div>
          :mode==='pptx'?<div className="office-slide-editor"><SlidePreview slide={slide} index={page}/><div className="office-fields"><label>레이아웃<select value={slide.layout} onChange={e=>updateSlide({layout:e.target.value})}>{SLIDE_LAYOUTS.map(v=><option key={v} value={v}>{layoutNames[v]}</option>)}</select></label><label>색상 테마<select value={slide.theme} onChange={e=>updateSlide({theme:e.target.value})}>{Object.keys(OFFICE_THEMES).map(v=><option key={v}>{v}</option>)}</select></label><label>제목<input value={slide.title} onChange={e=>updateSlide({title:e.target.value})}/></label><label>본문<textarea value={slide.body} onChange={e=>updateSlide({body:e.target.value})}/></label>
            {['columns','cards','timeline'].includes(slide.layout)&&<><button onClick={()=>updateSlide({items:[...slide.items,{title:'새 항목',body:''}].slice(0,6)})}>항목 추가</button>{slide.items.map((item,i)=><div key={i}><input aria-label={`항목 ${i+1} 제목`} value={item.title} onChange={e=>updateSlide({items:slide.items.map((v,j)=>j===i?{...v,title:e.target.value}:v)})}/><textarea aria-label={`항목 ${i+1} 본문`} value={item.body} onChange={e=>updateSlide({items:slide.items.map((v,j)=>j===i?{...v,body:e.target.value}:v)})}/><button onClick={()=>updateSlide({items:slide.items.filter((_,j)=>i!==j)})}>항목 삭제</button></div>)}</>}
            {slide.layout==='chart'&&<><button onClick={()=>updateSlide({chart:[...slide.chart,{label:'항목',value:0}].slice(0,8)})}>차트 값 추가</button>{slide.chart.map((item,i)=><div key={i}><input aria-label={`차트 ${i+1} 이름`} value={item.label} onChange={e=>updateSlide({chart:slide.chart.map((v,j)=>j===i?{...v,label:e.target.value}:v)})}/><input type="number" aria-label={`차트 ${i+1} 값`} value={item.value} onChange={e=>updateSlide({chart:slide.chart.map((v,j)=>j===i?{...v,value:Number(e.target.value)}:v)})}/><button onClick={()=>updateSlide({chart:slide.chart.filter((_,j)=>i!==j)})}>값 삭제</button></div>)}</>}
            <label>발표자 노트<textarea value={slide.notes} onChange={e=>updateSlide({notes:e.target.value})}/></label></div></div>
          :<textarea className="office-paper" aria-label="문서 본문" value={text} onChange={e=>{setText(e.target.value);dirty();}}/>}</main>
      </fieldset>
    </section>
  </div>;
}
