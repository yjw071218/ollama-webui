import { unzip, strFromU8 } from 'fflate';
import { extractHTML } from './officeDocuments.js';

export const ARCHIVE_LIMIT = 50 * 1024 * 1024;
export const archiveFiles = (buffer, budget) => new Promise((resolve, reject) => {
  let exceeded = false;
  unzip(new Uint8Array(buffer), { filter(file) {
    budget.bytes += file.originalSize;
    budget.files++;
    if (budget.bytes > ARCHIVE_LIMIT || budget.files > 1000) { exceeded = true; return false; }
    return !file.name.endsWith('/');
  } }, (error, files) => {
    if (error) reject(error);
    else if (exceeded) reject(new Error('압축 해제 한도(50 MB / 1,000개 항목)를 넘었습니다. 파일을 나누어 첨부해 주세요.'));
    else resolve(files);
  });
});

export const archiveFormat = files => {
  if (files['word/document.xml']) return 'docx';
  if (files['xl/workbook.xml'] || files['xl/workbook.bin']) return 'spreadsheet';
  if (files['ppt/presentation.xml']) return 'pptx';
  if (files['Contents/section0.xml']) return 'hwpx';
  const mime = files.mimetype ? strFromU8(files.mimetype).trim() : '';
  if (mime === 'application/vnd.oasis.opendocument.spreadsheet') return 'spreadsheet';
  if (mime === 'application/vnd.oasis.opendocument.text') return 'odt';
  if (mime === 'application/vnd.oasis.opendocument.presentation') return 'odp';
  if (mime === 'application/epub+zip' || files['META-INF/container.xml']) return 'epub';
  // Some exporters omit the mimetype member.
  if (files['content.xml']) {
    const xml = strFromU8(files['content.xml']);
    if (/<office:spreadsheet\b/.test(xml)) return 'spreadsheet';
    if (/<office:presentation\b/.test(xml)) return 'odp';
    if (/<office:text\b/.test(xml)) return 'odt';
  }
  return null;
};

export const epubPages = files => {
  const xml = path => {
    if (!files[path]) throw new Error(`전자책 구성 파일이 없습니다: ${path}`);
    const doc = new DOMParser().parseFromString(strFromU8(files[path]), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('전자책 XML이 손상되었습니다.');
    return doc;
  };
  const all = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
  const opf = all(xml('META-INF/container.xml'), 'rootfile')[0]?.getAttribute('full-path');
  const doc = xml(opf);
  const manifest = new Map(all(doc, 'item').map(item => [item.getAttribute('id'), item.getAttribute('href')]));
  return all(doc, 'itemref').map((item, i) => {
    const href = manifest.get(item.getAttribute('idref'));
    if (!href) throw new Error('전자책 목차 참조가 올바르지 않습니다.');
    const path = decodeURIComponent(new URL(href, `https://document.invalid/${opf}`).pathname.slice(1));
    if (!files[path]) throw new Error(`전자책 본문이 없습니다: ${path}`);
    return { page: i + 1, text: extractHTML(strFromU8(files[path]))[0].text };
  });
};
