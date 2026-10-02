/**
 * Korean pages labelled EUC-KR, read the way a browser reads them.
 *
 * Almost every Korean site that says `charset=euc-kr` is really serving CP949
 * (Microsoft's "Unified Hangul Code"), and the Encoding Standard browsers follow
 * treats the label that way. Node does not: its ICU `euc-kr` is plain KS X 1001,
 * which has only 2,350 of the 11,172 Hangul syllables. The other 8,822 -- 똠,
 * 뷁, 쀍, 햏, 펐, 켰 and a great many ordinary ones -- are CP949's extension,
 * and Node reads each as a C1 control character plus a stray ASCII letter, or
 * pairs its second byte with the next character and garbles what follows.
 * Reported as article text breaking into diamonds with a question mark in them;
 * measured on ppomppu.co.kr as "┎徽체낡邕�".
 *
 * The extension is defined by a rule, not a table: the syllables KS X 1001 lacks,
 * in Unicode order, laid over fixed byte ranges. So the table is computed here --
 * the KS X 1001 syllables are read with Node's own decoder, the rest are counted
 * off in order -- and nothing is copied or downloaded.
 */

const ranges = (...pairs) => pairs.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));

/* Where the extension syllables sit, in the order they are assigned. */
const EXTENSION_SLOTS = () => {
  const slots = [];
  const lowTrails = ranges([0x41, 0x5a], [0x61, 0x7a]);
  for (let lead = 0x81; lead <= 0xa0; lead += 1) {
    for (const trail of [...lowTrails, ...ranges([0x81, 0xfe])]) slots.push((lead << 8) | trail);
  }
  for (let lead = 0xa1; lead <= 0xc6; lead += 1) {
    for (const trail of [...lowTrails, ...ranges([0x81, 0xa0])]) {
      if (lead === 0xc6 && trail > 0x52) break;
      slots.push((lead << 8) | trail);
    }
  }
  return slots;
};

let table = null;

/** Every two-byte CP949 code, to its character. Built once, on first use. */
const buildTable = () => {
  const map = new Map();
  const plain = new TextDecoder('euc-kr');
  // KS X 1001 as Node has it: both bytes 0xA1-0xFE.
  const ksx = new Set();
  for (let lead = 0xa1; lead <= 0xfe; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const text = plain.decode(new Uint8Array([lead, trail]));
      if (text.length === 1 && text !== '�') {
        map.set((lead << 8) | trail, text);
        const code = text.codePointAt(0);
        if (code >= 0xac00 && code <= 0xd7a3) ksx.add(code);
      }
    }
  }
  const extension = [];
  for (let code = 0xac00; code <= 0xd7a3; code += 1) if (!ksx.has(code)) extension.push(code);
  const slots = EXTENSION_SLOTS();
  // 8,822 of each, or the rule was misread -- in which case use nothing rather than guess.
  if (extension.length === slots.length) {
    slots.forEach((slot, i) => map.set(slot, String.fromCodePoint(extension[i])));
  }
  // The two symbols CP949 added to KS X 1001's own rows.
  map.set(0xa2e6, '€');
  map.set(0xa2e7, '®');
  return map;
};

export const cp949Table = () => (table ||= buildTable());

/** Bytes as CP949 text. An invalid pair is one replacement character, and an ASCII second byte is not swallowed by it. */
export const decodeCp949 = (bytes) => {
  const map = cp949Table();
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const lead = bytes[i];
    if (lead < 0x80) { out += String.fromCharCode(lead); continue; }
    const trail = bytes[i + 1];
    if (lead >= 0x81 && lead <= 0xfe && trail !== undefined) {
      const found = map.get((lead << 8) | trail);
      if (found) { out += found; i += 1; continue; }
      out += '�';
      if (trail >= 0x80) i += 1;
      continue;
    }
    out += '�';
  }
  return out;
};

/** Labels that mean CP949 on the web. */
export const KOREAN_LABEL = /^(euc-kr|ks_c_5601(-1987|-1989)?|ksc5601|ksc_5601|cp949|windows-949|x-windows-949|csksc56011987|iso-ir-149|korean|uhc)$/i;
