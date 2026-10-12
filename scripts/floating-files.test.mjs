import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLatex} from '../server/latex.js';
import {answerFilePath,referencesAnswerFile,readAnswerFile} from '../server/answerFiles.js';
import {normaliseSlide,slideScene,fittedTextSize} from '../src/officeDesign.js';
import {parseChatOffice} from '../src/chatOffice.js';
test('LaTeX accepts a complete math document and rejects constructed commands and file I/O',()=>{
 const source=String.raw`\documentclass{article}\usepackage{amsmath,kotex}\begin{document}한글 \[\frac{1}{2}\]\end{document}`;
 assert.equal(validateLatex(source),source);
 for(const body of [String.raw`\input{secret}`,String.raw`\csname input\endcsname`,String.raw`\begin{filecontents}{x}bad\end{filecontents}`,String.raw`\usepackage{../../secret}`,String.raw`\documentclass\textbf`,String.raw`^^5cinput{secret}`,String.raw`\write18{cmd}`])assert.throws(()=>validateLatex(source.replace('한글',body)));
});
test('server files require a matching assistant link and current account records',()=>{
 const target=answerFilePath(process.platform==='win32'?'C:/docs/report.pdf':'/docs/report.pdf');
 assert.equal(referencesAnswerFile(JSON.stringify({messages:[{role:'assistant',content:`[파일](<${target}>)`}]}),target),true);
 assert.equal(referencesAnswerFile(JSON.stringify({messages:[{role:'user',content:`[파일](${target})`}]}),target),false);
 assert.equal(referencesAnswerFile(JSON.stringify({messages:[{role:'assistant',content:`[파일](${target}.txt)`}]}),target),false);
 assert.throws(()=>answerFilePath('relative.pdf'));assert.throws(()=>answerFilePath('C:/secret.exe'));
 const db={prepare:()=>({iterate:owner=>{assert.equal(owner,'owner');return [];}})};
 assert.throws(()=>readAnswerFile(db,'owner',target),/이 계정/);
});
test('custom slide shapes survive normalization and dense text shrinks',()=>{
 const slide=normaliseSlide({layout:'freeform',elements:[{type:'ellipse',x:1,y:1,w:2,h:2,fill:'ab12ef'},{type:'text',x:4,y:1,w:3,h:1,text:'한글 문장이 길어져도 상자 안에서 읽을 수 있도록 조정합니다.',size:50}]});
 const shapes=slideScene(slide);assert.equal(shapes[1].type,'ellipse');assert.ok(shapes[2].size<50);
 assert.ok(fittedTextSize('짧은 제목',10,2,40)===40);
});
test('new downloadable document formats retain complete sources',()=>{
 for(const format of ['tex','pdf','html','svg','md','json']){
 const value=parseChatOffice(JSON.stringify({format,title:'자료',text:'complete source'}));assert.equal(value.format,format);assert.equal(value.text,'complete source');
 }
});
