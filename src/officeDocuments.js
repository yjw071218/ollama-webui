import { unzip, strFromU8 } from 'fflate';

const LIMIT = 50 * 1024 * 1024;
const parseXML = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('문서 XML이 손상되어 읽을 수 없습니다.');
  return doc;
};
const elements = (node, name) => [...node.getElementsByTagNameNS('*', name)];

// Read text nodes only. Styles, embedded objects and scripts are never executed.
const textOf = (node) => {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1 && node.nodeType !== 9) return '';
  const name = node.localName;
  if (['script', 'style', 'binary-data'].includes(name)) return '';
  if (['tab'].includes(name)) return '\t';
  if (['br', 'line-break'].includes(name)) return '\n';
  if (name === 's') return ' '.repeat(Math.min(100, Number(node.getAttribute('text:c')) || 1));
  const text = [...node.childNodes].map(textOf).join('');
  return text + (['p', 'h', 'tr', 'div', 'section', 'table-row'].includes(name) ? '\n' : ['td', 'th', 'table-cell'].includes(name) ? '\t' : '');
};

export const extractHTML = (text) => {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return [{ page: 1, text: textOf(doc.body).trim() }];
};

export const extractOfficeDocument = async (buffer, name, onProgress) => {
  if (buffer.byteLength > LIMIT) throw new Error('문서는 50 MB 이하로 나누어 첨부해 주세요.');
  const ext = name.split('.').pop().toLowerCase();
  let expanded = 0, oversized = false;
  const files = await new Promise((resolve, reject) => unzip(new Uint8Array(buffer), {
    filter: (file) => {
      const wanted = /^(ppt\/(presentation\.xml|_rels\/presentation\.xml.rels|slides\/slide\d+\.xml)|content\.xml|Contents\/section\d+\.xml)$/.test(file.name);
      if (!wanted) return false;
      expanded += file.originalSize;
      if (expanded > LIMIT) { oversized = true; return false; }
      return true;
    },
  }, (error, result) => error ? reject(error) : resolve(result)));
  if (oversized) throw new Error('압축을 푼 문서가 너무 큽니다. 파일을 나누어 첨부해 주세요.');
  const xml = (path) => {
    if (!files[path]) throw new Error(`문서 구성 파일이 없습니다: ${path}`);
    return parseXML(strFromU8(files[path]));
  };
  let nodes;
  if (ext === 'pptx') {
    const rels = new Map(elements(xml('ppt/_rels/presentation.xml.rels'), 'Relationship')
      .filter(r => r.getAttribute('TargetMode') !== 'External')
      .map(r => [r.getAttribute('Id'), r.getAttribute('Target')]));
    nodes = elements(xml('ppt/presentation.xml'), 'sldId').map(slide => {
      const target = rels.get(slide.getAttribute('r:id') || slide.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const path = new URL(target || '', 'https://document.invalid/ppt/').pathname.slice(1);
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(path)) throw new Error('슬라이드 참조가 올바르지 않습니다.');
      return xml(path);
    });
  } else if (ext === 'hwpx') {
    nodes = Object.keys(files).filter(p => /^Contents\/section\d+\.xml$/.test(p))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map(xml);
  } else {
    const doc = xml('content.xml');
    nodes = ext === 'odp' ? elements(doc, 'page') : elements(doc, 'body');
  }
  if (!nodes.length) throw new Error('문서에서 본문을 찾지 못했습니다.');
  return nodes.map((node, i) => {
    onProgress?.(i + 1, nodes.length);
    return { page: i + 1, text: textOf(node).trim() };
  });
};
