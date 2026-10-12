import FilePreview from '../../src/FilePreview.jsx';
import React from 'react';
import {createRoot} from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {remarkTableBreaks} from '../../src/answerPresentation.js';
import InfoBlocks from '../../src/InfoBlocks.jsx';
import ChatOfficeCard from '../../src/ChatOfficeCard.jsx';
import {I18nProvider} from '../../src/i18n.jsx';
import '../../src/extras.css';
const root=createRoot(document.getElementById('test'));
document.head.insertAdjacentHTML('beforeend','<style>:root{--text-primary:#edeae4;--text-secondary:#aaa69d;--bg-secondary:#242321;--border-color:#45413b;--accent-color:#ca7958}body{background:#171715;color:var(--text-primary);font-family:system-ui;margin:0;padding:20px}#test{max-width:850px;margin:auto}table{width:100%;border-collapse:collapse}td,th{border:1px solid #45413b;padding:12px}*{box-sizing:border-box}</style>');
const graphic={title:'자료 비교 · 예시 데이터',blocks:[
 {type:'stats',items:[{label:'현재',value:'3.27',unit:'%',delta:'+0.06%p'},{label:'변화',value:'47% → 19%',note:'예시 기간'}]},
 {type:'media',items:[{image:location.origin+'/favicon.svg',title:'프랑스',text:'출처로 확인한 설명을 이미지 또는 아이콘과 함께 표시합니다.'},{icon:'🇯🇵',title:'일본',text:'긴 설명도 모바일 너비 안에서 줄바꿈합니다.'}]},
 {type:'panel',title:'처리 결과',blocks:[{type:'stats',items:[{label:'전체',value:100},{label:'유지',value:25}]},{type:'progress',items:[{label:'유지',value:25},{label:'기타',value:75}]}],note:'시각 검증을 위한 가상 데이터입니다.'},
 {type:'chart',chart:{type:'bar',labels:['A','B'],data:[1,4],title:'예시 비교'}},
],sources:[{title:'출처 예시',url:'https://example.org'}]};
window.presentationTest={render:()=>root.render(<I18nProvider><InfoBlocks source={JSON.stringify(graphic)}/><ReactMarkdown remarkPlugins={[remarkGfm,remarkTableBreaks]}>{'| 구분 | 설명 |\n|---|---|\n|줄바꿈|첫 줄<br>둘째 줄<BR />셋째 줄|\n|코드|`<br>`|'}</ReactMarkdown><ChatOfficeCard source={JSON.stringify({format:'pptx',title:'다음 장을 만드는 이야기',slides:[{title:'생각을\n경험으로 바꾸다',body:'프로젝트의 문제와 해결을 중심으로',kicker:'PORTFOLIO · 2026',layout:'title',theme:'forest'}]})}/></I18nProvider>),malformed:()=>root.render(<InfoBlocks source={'{"type":"stats","items":'}/>)};
window.presentationTest.render();

window.presentationTest.design=()=>root.render(<I18nProvider><ChatOfficeCard source={JSON.stringify({format:'pptx',title:'생각을 경험으로 바꾸다',slides:[{title:'생각을 경험으로 바꾸다',layout:'freeform',theme:'paper',elements:[
{type:'rect',x:0,y:0,w:13.333,h:7.5,fill:'F4F0E8'},
{type:'rect',x:8.6,y:0,w:4.733,h:7.5,fill:'6652C2'},
{type:'ellipse',x:9.2,y:1.3,w:3.5,h:3.5,fill:'D1C4F6'},
{type:'ellipse',x:10.1,y:2.2,w:1.7,h:1.7,fill:'6652C2'},
{type:'text',x:.8,y:.65,w:7,h:.4,text:'CREATIVE REPORT  /  2026',size:12,color:'6652C2',bold:true},
{type:'text',x:.8,y:2,w:7,h:2.5,text:'생각을\n경험으로 바꾸다',size:46,color:'252136',bold:true},
{type:'rect',x:.8,y:5.1,w:1.15,h:.05,fill:'6652C2'},
{type:'text',x:.8,y:5.5,w:6.5,h:.8,text:'작은 아이디어에서 시작하는 새로운 이야기',size:18,color:'706980'},
{type:'text',x:9.2,y:6.5,w:3.4,h:.4,text:'OLLAMA WEBUI  ✦',size:14,color:'FFFFFF',bold:true}
]}]})}/></I18nProvider>);

window.presentationTest.pdf=async()=>{const bytes=new Uint8Array(await(await fetch('/native/artifacts/latex-preview.pdf')).arrayBuffer());root.render(<FilePreview file={{name:'한글 수식.pdf',bytes}} onClose={()=>window.presentationTest.render()}/>);};
