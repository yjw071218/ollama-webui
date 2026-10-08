// Prefer Unicode. Legacy Korean documents are decoded only when a strict
// decoder accepts their bytes and the result contains real Korean text.
export const decodeDocumentText = (input) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const clean = text => !/[\x00-\x08\x0e-\x1f]/.test(text);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    const text = new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes);
    return clean(text) ? text : null;
  }
  if (bytes.includes(0)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return clean(text) ? text : null;
  } catch { /* Try the common legacy encodings below. */ }
  try {
    const text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes);
    if (clean(text) && /[가-힣]/.test(text)) return text;
  } catch { /* Not Korean legacy text. */ }
  const text = new TextDecoder('windows-1252').decode(bytes);
  const letters = [...text].filter(c => /[A-Za-zÀ-ÿ\s\d]/.test(c)).length;
  return clean(text) && !/[\u0080-\u009f\ufffd]/.test(text) && letters / Math.max(1, text.length) > .75 ? text : null;
};

export const rtfText = (source) => {
  const stack = [];
  let skip = false, uc = 1, fallback = 0, output = '';
  const tokens = source.match(/\\'[0-9a-f]{2}(?:\\'[0-9a-f]{2})*|\\[a-z]+-?\d* ?|\\[^a-z]|[{}]|[^\\{}]+/gi) || [];
  for (const token of tokens) {
    if (token === '{') { stack.push({ skip, uc }); continue; }
    if (token === '}') { const prev = stack.pop(); if (prev) ({ skip, uc } = prev); continue; }
    if (token === '\\*') { skip = true; continue; }
    if (/^\\(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|fldinst)\b/.test(token)) { skip = true; continue; }
    if (skip) continue;
    const control = token.match(/^\\([a-z]+)(-?\d+)?/i);
    if (control) {
      const [, name, n] = control;
      if (name === 'uc') uc = Math.max(0, Math.min(16, Number(n) || 0));
      else if (name === 'u') { output += String.fromCharCode(Number(n) & 0xffff); fallback = uc; }
      else if (['par', 'line', 'row'].includes(name)) output += '\n';
      else if (['tab', 'cell'].includes(name)) output += '\t';
      continue;
    }
    let text = token;
    if (token.startsWith("\\'")) {
      const bytes = new Uint8Array([...token.matchAll(/\\'([0-9a-f]{2})/gi)].map(m => parseInt(m[1], 16)));
      const cp = source.match(/\\ansicpg(\d+)/)?.[1];
      try { text = new TextDecoder(cp === '949' ? 'euc-kr' : `windows-${cp || '1252'}`).decode(bytes); }
      catch { text = new TextDecoder('windows-1252').decode(bytes); }
    } else if (token.startsWith('\\')) text = ({ '\\~': ' ', '\\_': '-', '\\-': '' })[token] ?? token.slice(1);
    else text = token.replace(/[\r\n]/g, '');
    if (fallback) { const n = Math.min(fallback, text.length); text = text.slice(n); fallback -= n; }
    output += text;
  }
  return output.trim();
};
