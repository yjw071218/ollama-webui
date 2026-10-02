/**
 * A command's output as a terminal would show it, for the monitor
 * (src/AgentActivity.jsx): ANSI colours kept as colours rather than as
 * `\x1b[31m` litter, each line marked when it reads as an error or a warning,
 * and a filter for finding one line in a long build. Pure, so it is tested
 * without a browser.
 */

/* SGR colour codes to class names; everything else in an escape is dropped. */
const COLOURS = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'gray', 91: 'red', 92: 'green', 93: 'yellow', 94: 'blue', 95: 'magenta', 96: 'cyan', 97: 'white',
};
const ESCAPE = /\u001b\[([0-9;?]*)([@-~])/g;
const OTHER_ESCAPES = /\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[()][A-Z0-9]|\u001b[=>]/g;

/** `[{ text, fg, bold }]` for one line. */
export const ansiSpans = (line) => {
  const spans = [];
  let fg = null, bold = false, last = 0;
  const source = String(line).replace(OTHER_ESCAPES, '');
  for (const m of source.matchAll(ESCAPE)) {
    if (m.index > last) spans.push({ text: source.slice(last, m.index), fg, bold });
    last = m.index + m[0].length;
    if (m[2] !== 'm') continue;                      // cursor moves and the like
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i];
      if (c === 0) { fg = null; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) fg = null;
      else if (COLOURS[c]) fg = COLOURS[c];
      else if (c === 38) i += codes[i + 1] === 5 ? 2 : 4;   // 256/truecolour: skipped
    }
  }
  if (last < source.length) spans.push({ text: source.slice(last), fg, bold });
  return spans.filter(s => s.text);
};

export const stripAnsi = (text) => String(text || '').replace(OTHER_ESCAPES, '').replace(ESCAPE, '');

const ERROR = /\b(error|errors|failed|failure|fail|fatal|exception|traceback|panic|unhandled|cannot find|not found|denied)\b|ERR!|✗|✖|×\s|^\s*at .+[:(]\d+:\d+\)?\s*$|^E\s+/i;
const WARNING = /\b(warn|warning|warnings|deprecated)\b|⚠/i;
const SUCCESS = /\b(passed|success|succeeded|done in|built in|compiled successfully|ready in)\b|✓|✔/i;

/** 'error' | 'warn' | 'ok' | '' for how a line reads. */
export const lineTone = (line) => {
  const plain = stripAnsi(line);
  if (/\b0 (errors?|failed|failures)\b/i.test(plain)) return SUCCESS.test(plain) ? 'ok' : '';
  if (ERROR.test(plain)) return 'error';
  if (WARNING.test(plain)) return 'warn';
  if (SUCCESS.test(plain)) return 'ok';
  return '';
};

/**
 * The lines to draw: `[{ n, text, tone }]`, only those matching `query` when
 * there is one (case-insensitive, plain text), and at most `limit` from the end.
 */
export const outputLines = (text, { query = '', limit = 400 } = {}) => {
  const all = String(text || '').replace(/\r(?!\n)/g, '\n').split(/\r?\n/);
  const q = String(query || '').trim().toLowerCase();
  const lines = all.map((line, i) => ({ n: i + 1, text: line, tone: lineTone(line) }))
    .filter(l => !q || stripAnsi(l.text).toLowerCase().includes(q));
  return lines.length > limit ? lines.slice(-limit) : lines;
};

/** How many lines read as errors, for a badge. */
export const errorCount = (text) => String(text || '').split(/\r?\n/).filter(line => lineTone(line) === 'error').length;
