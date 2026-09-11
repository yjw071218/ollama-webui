// Every custom property this stylesheet reads must be one it also defines, or
// one it reads with a real fallback.
//
// An undefined custom property does not warn, does not fall back to anything
// sensible, and does not show up in a build: the declaration containing it is
// thrown away at compute time and the property simply does not apply.
//
// It has now cost three visible bugs. `--bg-secondary` was read by the
// artifact panel header and defined nowhere. `--bg-hover` was read by four
// hover rules -- the variant buttons, the folder add, the folder header --
// and the property is called `--hover-bg`, so none of those elements had a
// hover state at all. And then
//
//     background: var(--bg-elevated, var(--bg-panel));
//
// on the bar that appears over a selected passage: two invented names, one
// nested inside the other's fallback slot, so the bar had no background and
// the answer's text showed straight through its buttons. That is the one a
// reader noticed and reported.
//
// All three looked perfectly reasonable while reading the file, which is why
// this is a test rather than a habit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['../src/index.css', '../src/extras.css'];

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// Comments are blanked rather than removed, so line numbers still line up.
// This file's own prose names the broken properties, and a scan that read
// comments would report them for ever.
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const sources = FILES.map(f => ({
  file: path.basename(f),
  text: stripComments(fs.readFileSync(path.resolve(HERE, f), 'utf8').replace(/\r\n/g, '\n')),
}));
const all = sources.map(s => s.text).join('\n');

// Defined: `--name:` appearing as a declaration.
const defined = new Set([...all.matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[2]));
check('the stylesheets define some variables at all', defined.size > 10, `${defined.size} found`);

/**
 * Is this `var(` — at index `from` in `text` — safe?
 *
 * Safe means: the property is defined in CSS, or it carries a fallback that is
 * itself safe.
 *
 * The fallback clause is not a loophole, it is the whole distinction. Several
 * of these are set from JavaScript on purpose — `--sidebar-width`,
 * `--chat-font-size`, `--kb-inset` — and every one of them is written
 * `var(--sidebar-width, 340px)`, so the layout is right before any script has
 * run. What is not safe is a fallback that is itself an undefined property,
 * which is exactly what `var(--bg-elevated, var(--bg-panel))` was: a chain of
 * two invented names ending in nothing at all.
 */
const safeUse = (text, from) => {
  let depth = 0;
  let end = from;
  for (; end < text.length; end++) {
    if (text[end] === '(') depth++;
    else if (text[end] === ')') { depth--; if (depth === 0) break; }
  }
  const inner = text.slice(from + 4, end); // past "var("

  // The first comma at depth zero separates the name from the fallback.
  let comma = -1;
  let d = 0;
  for (let k = 0; k < inner.length; k++) {
    if (inner[k] === '(') d++;
    else if (inner[k] === ')') d--;
    else if (inner[k] === ',' && d === 0) { comma = k; break; }
  }

  const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
  if (defined.has(name)) return true;
  if (comma === -1) return false;

  const fallback = inner.slice(comma + 1).trim();
  if (!fallback) return false;
  // A fallback that is itself a var() has to be safe in turn. Anything else is
  // a literal, and a literal always applies.
  const nested = fallback.indexOf('var(');
  if (nested === -1) return true;
  return safeUse(fallback, nested);
};

const missing = [];
for (const { file, text } of sources) {
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(/g)) {
      if (safeUse(line, m.index)) continue;
      const named = line.slice(m.index).match(/var\(\s*(--[a-zA-Z0-9-]+)/);
      missing.push(`${file}:${i + 1}  ${named ? named[1] : 'var(?)'}  ->  ${line.trim().slice(0, 72)}`);
    }
  });
}
check('every var() is defined, or has a real fallback', missing.length === 0,
  missing.slice(0, 10).join('\n      '));

// The one that is legitimately set only from JavaScript. Asserted so that
// deleting the code which sets it does not quietly leave the fallback in
// charge for ever.
check('--kb-inset is written by viewport.js',
  /--kb-inset/.test(fs.readFileSync(path.resolve(HERE, '../src/viewport.js'), 'utf8')));

// The three invented names, by name, so that re-introducing one fails with a
// message that says what happened rather than a generic one.
for (const invented of ['--bg-elevated', '--bg-panel', '--bg-hover']) {
  check(`${invented} is not used (it has never existed)`, !all.includes(`var(${invented}`));
}

// And the symptom itself: the bar the reader saw through must have a
// background, from a property that exists.
const bar = all.match(/\.selection-bar\s*\{[\s\S]*?\}/);
check('the selection bar has a background', !!bar && /background:\s*var\(--bg-main\)/.test(bar[0]),
  bar ? bar[0].replace(/\s+/g, ' ').slice(0, 180) : 'no .selection-bar rule found');

// Hovering a folder or a variant button should do something visible. These
// were the four rules that silently did nothing.
check('the hover rules use the property that exists',
  (all.match(/:hover[^{]*\{[^}]*var\(--hover-bg\)/g) || []).length >= 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
