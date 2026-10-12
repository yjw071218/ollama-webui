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
