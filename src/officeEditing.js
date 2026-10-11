import { zipSync, strFromU8, strToU8 } from 'fflate';
import { archiveFiles, archiveFormat } from './documentArchive.js';
import { api } from './session.jsx';
import { slideScene, normaliseSlide } from './officeDesign.js';

const XML = text => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('문서 XML이 손상되었습니다.');
  return doc;
};
const texts = doc => [...doc.getElementsByTagNameNS('*', 't')];
export const encode64 = bytes => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 16384) value += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(value);
};
const decode64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function readOffice(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error('문서는 50 MB 이하여야 합니다.');
  const extension = file.name.split('.').pop().toLowerCase();
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (['xlsx','xls','ods','csv','tsv','xlsb'].includes(extension)) {
    if(extension==='ods') bytes=await convertOfficeBytes(bytes,'ods','xlsx');
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(bytes, { type:'array', cellStyles:true, cellFormula:true, bookVBA:false });
    let count=0;
    for(const sheet of Object.values(workbook.Sheets)) for(const key of Object.keys(sheet)) {
      if(!key.startsWith('!') && ++count>200000) throw new Error('20만 셀을 넘는 문서는 나누어 열어 주세요.');
    }
    if(!workbook.SheetNames.length) throw new Error('워크시트가 없습니다.');
    return {format:'xlsx',workbook,name:file.name.replace(/\.[^.]+$/,''),originalFormat:extension};
  }
  if (['hwp','ppt','odp','doc','odt','rtf','txt'].includes(extension)) {
    const from = file.name.split('.').pop().toLowerCase();
    const to = from === 'hwp' ? 'hwpx' : ['ppt','odp'].includes(from) ? 'pptx' : 'docx';
    const result = await api('/api/auth/office/convert', { method: 'POST', body: { from, to, data: encode64(bytes) } });
    bytes = decode64(result.data);
  }
  const files = await archiveFiles(bytes, { bytes: 0, files: 0 });
  const format = archiveFormat(files);
  if (!['pptx', 'hwpx','docx'].includes(format)) throw new Error('지원하는 오피스 문서를 선택해 주세요.');
  let paths;
  if (format === 'pptx') {
    const presentation = XML(strFromU8(files['ppt/presentation.xml']));
    const rels = XML(strFromU8(files['ppt/_rels/presentation.xml.rels']));
    const map = new Map([...rels.getElementsByTagNameNS('*', 'Relationship')].filter(r => r.getAttribute('TargetMode') !== 'External').map(r => [r.getAttribute('Id'), r.getAttribute('Target')]));
    paths = [...presentation.getElementsByTagNameNS('*', 'sldId')].map(s => {
      const target = map.get(s.getAttribute('r:id'));
      if (!target) throw new Error('슬라이드 참조가 없습니다.');
      return new URL(target, 'https://office.invalid/ppt/').pathname.slice(1);
    });
  } else if(format==='docx') paths=['word/document.xml',...Object.keys(files).filter(p=>/^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p))];
  else paths = Object.keys(files).filter(p => /^Contents\/section\d+\.xml$/.test(p)).sort((a,b) => Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  const pages = paths.map(path => {
    if (!files[path]) throw new Error(`문서 구성 파일이 없습니다: ${path}`);
    return { path, texts: texts(XML(strFromU8(files[path]))).map(t => t.textContent) };
  });
  return { format, files, pages, name: file.name.replace(/\.[^.]+$/, '') };
}

export function editOfficeBytes(document, pages) {
  const files = { ...document.files };
  pages.forEach(page => {
    const doc = XML(strFromU8(files[page.path]));
    const nodes = texts(doc);
    if (nodes.length !== page.texts.length) throw new Error('문서 구조가 변경되었습니다. 원본을 다시 열어 주세요.');
    nodes.forEach((node, index) => { node.textContent = page.texts[index]; node.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve'); });
    if (document.format === 'hwpx') [...doc.getElementsByTagNameNS('*', 'linesegarray')].forEach(node => node.remove());
    files[page.path] = strToU8(new XMLSerializer().serializeToString(doc));
  });
  if (document.format === 'hwpx') {
    files['Preview/PrvText.txt'] = strToU8(Object.keys(files).filter(p => /^Contents\/section\d+\.xml$/.test(p)).sort()
      .map(p => texts(XML(strFromU8(files[p]))).map(t => t.textContent).join('\n')).join('\n').slice(0, 10000));
  }
  // HWPX's mimetype member must be uncompressed and first.
  const archive = {};
  if (files.mimetype) archive.mimetype = [files.mimetype, { level: 0 }];
  for (const [path, bytes] of Object.entries(files)) if (path !== 'mimetype') archive[path] = bytes;
  return zipSync(archive);
}

export async function createPresentation(slides, title = '발표자료') {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE'; presentation.title = title;
  presentation.author = 'Ollama WebUI'; presentation.lang = 'ko-KR';
  for (const [index, item] of slides.entries()) {
    const slide = presentation.addSlide();
    for(const shape of slideScene(item,index+1)) {
      const {x,y,w,h}=shape;
      if(shape.type==='rect') slide.addShape(presentation.ShapeType.rect,{x,y,w,h,line:{color:shape.fill,transparency:100},fill:{color:shape.fill}});
      else slide.addText(shape.text,{x,y,w,h,fontFace:'맑은 고딕',fontSize:shape.size,bold:shape.bold,color:shape.color,valign:'top',fit:'shrink',margin:0,breakLine:false});
    }
    if(normaliseSlide(item).notes) slide.addNotes(normaliseSlide(item).notes);
  }
  return new Uint8Array(await presentation.write({ outputType: 'arraybuffer' }));
}

const escapeXML = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function createWord(text,title='문서') {
  const paragraph = (line,heading=false) => `<w:p>${heading?'<w:pPr><w:pStyle w:val="Title"/></w:pPr>':''}<w:r><w:t xml:space="preserve">${escapeXML(line)}</w:t></w:r></w:p>`;
  const files={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/styles.xml':'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="맑은 고딕"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="17365D"/></w:rPr></w:style></w:styles>',
    'word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(title,true)}${String(text).split('\n').map(line=>paragraph(line)).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([path,xml])=>[path,strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+xml)])));
}

export async function createWorkbook(sheets=[{name:'Sheet1',rows:[['항목','값'],['',0]]}]) {
  const XLSX=await import('xlsx'), workbook=XLSX.utils.book_new();
  for(const [i,sheet] of sheets.entries()) {
    const name=String(sheet.name||`Sheet${i+1}`).replace(/[\\/?*\[\]:]/g,'_').slice(0,25);
    const ws=XLSX.utils.aoa_to_sheet(sheet.rows);
    for(const key of Object.keys(ws)) if(typeof ws[key]?.v==='string' && ws[key].v.startsWith('=')) ws[key]={t:'n',f:ws[key].v.slice(1)};
    ws['!cols']=Array.from({length:Math.min(100,Math.max(1,...sheet.rows.map(r=>r.length)))},()=>({wch:22}));
    XLSX.utils.book_append_sheet(workbook,ws,workbook.SheetNames.includes(name)?`${name}_${i+1}`:name);
  }
  workbook.Workbook ||= {}; workbook.Workbook.CalcPr={fullCalcOnLoad:true,forceFullCalc:true,calcMode:'auto'};
  return workbook;
}
export async function writeWorkbook(workbook,format='xlsx',sheet=0) {
  const XLSX=await import('xlsx');
  if(!['xlsx','xls','ods','csv','tsv'].includes(format)) throw new Error('지원하지 않는 표 형식입니다.');
  // BIFF and ODS writers do not reliably retain unevaluated formulas. Convert
  // XLSX through LibreOffice, which also calculates the saved results.
  if(format==='xls'||format==='ods') return convertOfficeBytes(await writeWorkbook(workbook,'xlsx'),'xlsx',format);
  const bytes=new Uint8Array(XLSX.write(workbook,{type:'array',bookType:format==='tsv'?'csv':format,FS:format==='tsv'?'\t':',',sheet:workbook.SheetNames[sheet]}));
  if(format!=='xlsx')return bytes;
  const files=await archiveFiles(bytes,{bytes:0,files:0});
  const doc=XML(strFromU8(files['xl/workbook.xml']));
  let calc=doc.getElementsByTagNameNS('*','calcPr')[0];
  if(!calc){calc=doc.createElementNS(doc.documentElement.namespaceURI,'calcPr');doc.documentElement.appendChild(calc);}
  calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');calc.setAttribute('calcMode','auto');
  files['xl/workbook.xml']=strToU8(new XMLSerializer().serializeToString(doc));
  return zipSync(files);
}
export async function convertOfficeBytes(bytes,from,to) {
  if(from===to) return bytes;
  const result=await api('/api/auth/office/convert',{method:'POST',body:{from,to,data:encode64(bytes)}});
  return decode64(result.data);
}

export async function createHangul(text) {
  const response = await fetch('/office/blank.hwpx');
  if (!response.ok) throw new Error('한글 문서 서식을 불러오지 못했습니다.');
  const document = await readOffice(new File([await response.arrayBuffer()], '문서.hwpx'));
  const path = document.pages[0].path;
  const doc = XML(strFromU8(document.files[path]));
  const paragraphs = [...doc.documentElement.children].filter(n => n.localName === 'p');
  const template = paragraphs[paragraphs.length - 1];
  if (!template) throw new Error('한글 문서 서식에 문단이 없습니다.');
  // Preserve the first paragraph's section/page properties, and use an ordinary
  // paragraph as the template for each following line.
  const first = paragraphs[0];
  for (const p of paragraphs.slice(1)) p.remove();
  String(text || '본문을 입력하세요.').split('\n').forEach((line, index) => {
    const p = index === 0 ? first : template.cloneNode(true);
    p.setAttribute('id', String(index));
    const nodes = texts(p);
    if (!nodes.length) throw new Error('한글 서식에 텍스트 영역이 없습니다.');
    nodes[0].textContent = line;
    nodes.slice(1).forEach(n => { n.textContent = ''; });
    // Line segment positions describe the original text. Hancom recalculates
    // them when omitted instead of drawing edited text at obsolete positions.
    [...p.getElementsByTagNameNS('*', 'linesegarray')].forEach(n => n.remove());
    if (index) doc.documentElement.appendChild(p);
  });
  document.files[path] = strToU8(new XMLSerializer().serializeToString(doc));
  const bytes = editOfficeBytes(document, []);
  return bytes;
}

export async function asHwp(bytes) {
  const result = await api('/api/auth/office/convert', { method: 'POST', body: { from: 'hwpx', to: 'hwp', data: encode64(bytes) } });
  return decode64(result.data);
}
export async function asPpt(bytes) {
  const result = await api('/api/auth/office/convert', { method: 'POST', body: { from: 'pptx', to: 'ppt', data: encode64(bytes) } });
  return decode64(result.data);
}
export function downloadOffice(bytes, name, format) {
  const types={pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',ppt:'application/vnd.ms-powerpoint',hwpx:'application/hwp+zip',hwp:'application/x-hwp',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',odt:'application/vnd.oasis.opendocument.text',odp:'application/vnd.oasis.opendocument.presentation',ods:'application/vnd.oasis.opendocument.spreadsheet',pdf:'application/pdf',csv:'text/csv;charset=utf-8',tsv:'text/tab-separated-values;charset=utf-8',txt:'text/plain;charset=utf-8',rtf:'application/rtf'};
  const url = URL.createObjectURL(new Blob([bytes], { type: types[format]||'application/octet-stream' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `${String(name || '문서').replace(/[\\/:*?"<>|]/g, '_')}.${format}`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
