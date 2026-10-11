import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute=promisify(execFile);
const root=fileURLToPath(new URL('../',import.meta.url));
export async function libreOfficeBinary() {
  const candidates=[process.env.WEBUI_LIBREOFFICE,
    path.join(root,'native/artifacts/office-runtime/program/soffice.exe'),
    path.join(root,'native/artifacts/office-runtime/LibreOffice/program/soffice.exe'),
    'C:/Program Files/LibreOffice/program/soffice.exe','C:/Program Files (x86)/LibreOffice/program/soffice.exe',
    '/usr/bin/libreoffice','/usr/bin/soffice','/Applications/LibreOffice.app/Contents/MacOS/soffice'].filter(Boolean);
  for(const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  throw new Error('오피스 변환 엔진이 없습니다. LibreOffice를 설치하거나 WEBUI_LIBREOFFICE에 실행 파일 경로를 지정해 주세요.');
}
const groups=[['ppt','pptx','odp'],['doc','docx','odt','rtf','txt'],['xls','xlsx','ods','csv','tsv']];
export const supportsOfficeConversion=(from,to)=>groups.some(group=>group.includes(from)&&(group.includes(to)||to==='pdf'));
const filters={ppt:'MS PowerPoint 97',pptx:'Impress MS PowerPoint 2007 XML',odp:'impress8',doc:'MS Word 97',docx:'Office Open XML Text',odt:'writer8',rtf:'Rich Text Format',txt:'Text (encoded):UTF8',xls:'MS Excel 97',xlsx:'Calc MS Excel 2007 XML',ods:'calc8',csv:'Text - txt - csv (StarCalc):44,34,76',tsv:'Text - txt - csv (StarCalc):9,34,76'};
export async function convertWithLibreOffice(directory,source,from,to) {
  const binary=await libreOfficeBinary();
  const profile=path.join(directory,'profile');
  await fs.mkdir(path.join(profile,'user'),{recursive:true});
  // Each request owns a fresh profile: no reuse of an interactive Office session.
  await fs.writeFile(path.join(profile,'user/registrymodifications.xcu'),`<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`);
  const out=path.join(directory,'output'); await fs.mkdir(out);
  const filter=to==='pdf' ? (groups[0].includes(from)?'impress_pdf_Export':groups[2].includes(from)?'calc_pdf_Export':'writer_pdf_Export') : filters[to];
  const {stdout,stderr}=await execute(binary,[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--nologo','--nodefault','--norestore','--convert-to',`${to}:${filter}`,'--outdir',out,source],{windowsHide:true,timeout:90000,maxBuffer:16384});
  const target=path.join(out,`${path.parse(source).name}.${to}`);
  try { const bytes=await fs.readFile(target); if(!bytes.length||bytes.length>50*1024*1024) throw new Error('변환 결과 크기가 올바르지 않습니다.'); return bytes; }
  catch(error) { throw new Error(`오피스 변환 결과를 읽지 못했습니다: ${String(stderr||stdout||error.message).slice(0,500)}`); }
}
