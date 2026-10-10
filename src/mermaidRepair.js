/*
 * The mistakes models make in flowcharts, put right before giving up.
 *
 * Almost every "Parse error" seen here is one shape: a node label with
 * brackets, a comma or a colon in it and no quotes -- A[앱<br>(정우 님의 코드)].
 * Mermaid reads the "(" as the start of another shape. Quoting the label is
 * what the author meant, so labels like that are quoted, and edge labels
 * between pipes the same. Only tried when the original does not parse.
 */
const SHAPES = [['[[', ']]'], ['[(', ')]'], ['([', '])'], ['((', '))'], ['{{', '}}'], ['[/', '/]'], ['[', ']'], ['(', ')'], ['{', '}'], ['>', ']']];
const ARROW = /\s*(?:<?-{2,}>?|<?={2,}>?|-\.+->?|~~~|&|--[ox]|\|)/;
const NEEDS = /[()[\]{}<>:;,|#&"]|^\s*$/;
const quote = (label) => `"${label.replace(/"/g, '#quot;')}"`;

const fixLine = (line) => {
  if (/^\s*(?:%%|style\b|classDef\b|class\b|linkStyle\b|click\b|subgraph\b|end\b|direction\b|flowchart\b|graph\b)/.test(line)) return line;
  let out = '', i = 0;
  const id = /([A-Za-z_\u00C0-\uFFFF][\w\u00C0-\uFFFF-]*)/y;
  while (i < line.length) {
    // Quoted text is already what it should be.
    if (line[i] === '"') { const j = line.indexOf('"', i + 1); const end = j < 0 ? line.length : j + 1; out += line.slice(i, end); i = end; continue; }
    id.lastIndex = i;
    const m = id.exec(line);
    const prevOk = i === 0 || /[\s&>|-]/.test(line[i - 1]);
    if (!m || !prevOk) { out += line[i]; i += 1; continue; }
    const after = i + m[0].length;
    const shape = SHAPES.find(([open]) => line.startsWith(open, after));
    if (!shape) { out += m[0]; i = after; continue; }
    const [open, close] = shape;
    const start = after + open.length;
    // The label runs to the last closer before the next arrow (or the line's end).
    const rest = line.slice(start);
    const arrowAt = (() => {
      let depth = 0;
      for (let k = 0; k < rest.length; k++) {
        const c = rest[k];
        if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
        if (depth === 0 && rest.startsWith(close, k)) {
          const tail = rest.slice(k + close.length);
          if (!tail.trim() || ARROW.test(tail.slice(0, 6)) || /^\s*:::/.test(tail)) return k;
        }
      }
      return rest.lastIndexOf(close);
    })();
    if (arrowAt < 0) { out += m[0]; i = after; continue; }
    const label = rest.slice(0, arrowAt);
    const quoted = /^\s*".*"\s*$/.test(label);
    out += m[0] + open + (!quoted && NEEDS.test(label) ? quote(label.trim()) : label) + close;
    i = start + arrowAt + close.length;
  }
  // Edge labels: -->|text (x)| and -- text (x) -->
  return out
    .replace(/\|([^|"\n]*[()[\]{}:;,#][^|"\n]*)\|/g, (_, t) => `|${quote(t.trim())}|`);
};

export const repairMermaid = (text) => {
  const src = String(text || '');
  if (!/^\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\b/i.test(src)) return null;
  const fixed = src.split('\n').map((l, n) => (n === 0 ? l : fixLine(l))).join('\n');
  return fixed !== src ? fixed : null;
};
