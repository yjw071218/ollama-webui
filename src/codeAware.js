/**
 * Tags quoted in code are text.
 *
 * `<think>`, `<TOOL_RESULT>` and the tool tags are found with regular
 * expressions all over the app -- to split an answer for display, and to strip
 * reasoning before a transcript is sent back to a model. None of them knew
 * about code, so an answer that *showed* a think tag (a diff of the very code
 * that handles it, an explanation of the format) opened a block there that ran
 * to the end of the message: on screen the rest of the answer vanished into the
 * thinking dropdown, and in history it was cut off for good.
 *
 * Pure and dependency-free: the server imports it too.
 */

/** [start, end) offsets of fenced code blocks and inline code spans. */
export const codeRanges = (text) => {
  const s = String(text ?? '');
  const ranges = [];
  let fence = null, fenceStart = 0, pos = 0;
  for (const line of s.split('\n')) {
    const end = pos + line.length;
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m[0].length).trim()) {
        ranges.push([fenceStart, end]);
        fence = null;
      }
    } else if (m) {
      fence = m[1]; fenceStart = pos;
    } else {
      // Inline spans on this line: a run of N backticks closes at the next run of N.
      const re = /`+/g;
      let open = null, r;
      while ((r = re.exec(line)) !== null) {
        if (!open) open = { at: r.index, len: r[0].length };
        else if (r[0].length === open.len) { ranges.push([pos + open.at, pos + r.index + r[0].length]); open = null; }
      }
    }
    pos = end + 1;
  }
  // A fence still open at the end (a streaming answer) runs to the end.
  if (fence) ranges.push([fenceStart, s.length]);
  return ranges;
};

export const inRanges = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);

/** Whether the end of `text` is inside code -- where the next character would land. */
export const insideCode = (text) => {
  const s = String(text ?? '');
  if (!s.includes('`') && !s.includes('~~~')) return false;
  // Probe one character past the end: an unclosed fence contains it.
  if (inRanges(codeRanges(`${s}x`), s.length)) return true;
  // An inline span still open on the last line (`like <think> here).
  const lastLine = s.slice(s.lastIndexOf('\n') + 1);
  return (lastLine.match(/`/g) || []).length % 2 === 1;
};

/** String.replace with a global regex, leaving matches that start inside code alone.
 *  Code is judged from the end of the previous match, so a fence left open
 *  inside one removed block cannot hide every block after it. */
export const replaceOutsideCode = (text, regex, replacement = '') => {
  const s = String(text ?? '');
  if (!s.includes('`') && !s.includes('~~~')) return s.replace(regex, replacement);
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  let out = '', last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (insideCode(s.slice(last, m.index))) { re.lastIndex = m.index + 1; continue; }
    out += s.slice(last, m.index) + (typeof replacement === 'function' ? replacement(...m) : replacement);
    last = m.index + m[0].length;
    if (!m[0].length) re.lastIndex++;
  }
  return out + s.slice(last);
};

const THINK = /<think>[\s\S]*?(?:<\/think>|$)/gi;

/** The text without its reasoning blocks (closed or left open), code untouched. */
export const stripThinking = (text, replacement = '') => replaceOutsideCode(text, THINK, replacement);
