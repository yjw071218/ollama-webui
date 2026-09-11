// Copy pdf.js's character maps and standard fonts into public/.
//
// pdf.js can parse a PDF without these and still hand back nothing readable.
// A CID-keyed font — which is how every CJK document embeds its text — stores
// glyph ids, not characters, and turning those back into Unicode needs the
// character map for that font's collection. `Adobe-Korea1-UCS2.bcmap` is the
// one a Korean document wants. Without it `getTextContent()` returns items
// whose `str` is empty, and the app concludes the PDF has no text in it and
// says so — which is exactly what a Korean tuition invoice did.
//
// The files ship inside pdfjs-dist but are not importable: there are 169 of
// them, loaded by name at run time, so a bundler cannot see which one will be
// needed. They have to exist at a URL. `public/` is the one directory Vite
// serves as-is in development and copies verbatim into `dist/` on build, so
// putting them there makes both cases work with no plugin and no config.
//
// Run from `predev` and `prebuild`, and cheap to repeat: it skips a
// destination that is already complete.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FROM = path.join(ROOT, 'node_modules', 'pdfjs-dist');
const TO = path.join(ROOT, 'public', 'pdfjs');

// Kept in step with the URLs passed to `getDocument` in src/rag.js.
const SETS = [
  { name: 'cmaps', why: 'CID fonts (every CJK document)' },
  { name: 'standard_fonts', why: 'the 14 fonts a PDF may omit' },
];

const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) { copied += copyDir(src, dst); continue; }
    // Skip a file that is already there and the same size: this runs before
    // every dev start and every build.
    if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) continue;
    fs.copyFileSync(src, dst);
    copied++;
  }
  return copied;
};

if (!fs.existsSync(FROM)) {
  // Not an error: `npm install` has not run yet, and the next one will.
  console.log('pdf-assets: pdfjs-dist is not installed yet; nothing to copy.');
  process.exit(0);
}

let total = 0;
for (const { name, why } of SETS) {
  const from = path.join(FROM, name);
  if (!fs.existsSync(from)) {
    console.warn(`pdf-assets: pdfjs-dist has no ${name}/ — ${why} will not resolve.`);
    continue;
  }
  total += copyDir(from, path.join(TO, name));
}

console.log(total > 0
  ? `pdf-assets: copied ${total} file(s) into public/pdfjs/`
  : 'pdf-assets: already up to date.');
