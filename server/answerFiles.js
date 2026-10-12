import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileBytes} from './folderWatch.js';
const formats = new Set('pdf pptx ppt odp docx doc odt rtf txt md tex xlsx xls ods csv tsv hwpx hwp html htm svg png jpg jpeg webp gif json zip'.split(' '));
export function answerFilePath(value) {
  let text=String(value||'');
  if (/^file:/i.test(text)) text=fileURLToPath(text);
  else { try { text=decodeURIComponent(text); } catch {} }
  text=text.replace(/:(\d+)(?::\d+)?$/,'');
  if (!path.isAbsolute(text) || !formats.has(path.extname(text).slice(1).toLowerCase())) throw new Error('지원하는 문서·이미지 파일의 절대 경로가 필요합니다.');
  return path.normalize(text);
}
export function referencesAnswerFile(payload, target) {
  let chat;try{chat=JSON.parse(payload);}catch{return false;}
  return (chat.messages||[]).some(message=>message.role==='assistant' && [...String(message.content||'').matchAll(/\]\((?:<([^>]+)>|([^\n]+?))\)/g)].some(match=>{
    try{return answerFilePath(match[1]||match[2])===target;}catch{return false;}
  }));
}
export function readAnswerFile(db, owner, requested) {
  const target=answerFilePath(requested);
  const records=db.prepare("SELECT payload FROM readable_records WHERE user_id=? AND kind='chat' AND deleted=0").iterate(owner);
  let allowed=false;
  for(const record of records) if(referencesAnswerFile(record.payload,target)){allowed=true;break;}
  if(!allowed) throw new Error('이 계정의 저장된 AI 답변에 연결된 파일만 열 수 있습니다. 대화 동기화 후 다시 시도해 주세요.');
  return readFileBytes(target);
}
