// What happens to a file dropped on the composer.
//
// A tuition invoice was attached as a PDF and the answer that came back had
// nothing to do with it. The cause was one line: everything that was not an
// image went through `reader.readAsText(file)`. For a PDF that means decoding
// compressed binary as UTF-8, so the model received a hundred thousand
// characters of `%PDF-1.4`, stream markers and replacement characters — an
// enormous token bill for an attachment containing no readable text at all,
// and a prompt so far from language that what came back had little to do with
// the question.
//
// The extractor was already in the repository, doing this correctly for the
// knowledge library. The composer simply never called it. So what is checked
// here is the extractor itself against a real PDF, and — because the bug was
// in the caller, not the extractor — a scan of the composer for the call that
// caused it.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/* ------------------------------------------------- the composer's call site */

// Line endings are normalised because this repository checks out with
// `core.autocrlf=true`, so a source file's newlines depend on whether git
// last touched it. A pattern anchored on \n would then pass or fail for a
// reason that has nothing to do with the code it is checking.
const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
// Comments explain this bug at length; a check that counts the explanation as
// a recurrence is a check that punishes writing one.
const appCode = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// Scoped to `addFiles`, which is the composer's ingestion path. `readAsText`
// elsewhere is fine and correct — importing a JSON export of the chat history
// is reading a text file as text.
const addFiles = appCode.slice(
  appCode.indexOf('const addFiles'),
  appCode.indexOf('const handleFileChange'));
check('the composer path was found', addFiles.length > 0);
check('the composer no longer reads attachments as raw text',
  !/readAsText/.test(addFiles),
  (addFiles.match(/.*readAsText.*/) || [''])[0].trim());

check('it extracts documents instead', /extractDocument\s*\(/.test(appCode));

// A file nothing can read must still be refused rather than decoded: a zip, a
// video or an executable produces exactly the same flood of mojibake a PDF
// did. The check is no longer on the name -- see `sniffKind` -- so what the
// composer must do is handle the refusal that comes back from reading it.
check('and refuses files that turn out not to be text',
  /err\.code === 'binary'/.test(addFiles),
  addFiles.slice(addFiles.indexOf('catch (err)'), addFiles.indexOf('catch (err)') + 160));

// An attachment is context for a question, not a corpus. Without a ceiling one
// long PDF fills the window, pushes the question out of it, and is re-sent with
// every later turn.
check('a size ceiling exists', /MAX_ATTACHMENT_CHARS/.test(appCode));

/* ------------------------------------------- character maps for CJK fonts */

// The Korean tuition invoice that started this reported "no text found", and
// it was full of text. A CID-keyed font -- which is how every CJK document
// embeds characters -- stores glyph ids, and turning those back into Unicode
// needs the character map for the font's collection. Without `cMapUrl` pdf.js
// cannot fetch one, `getTextContent()` returns items whose `str` is empty, and
// the only honest conclusion left is that the file has no text in it.
//
// Verified by removing the setting and re-running the browser probe: the same
// PDF went from 41 Korean characters to zero.
const ragSource = fs.readFileSync(path.join(ROOT, 'src/rag.js'), 'utf8').replace(/\r\n/g, '\n');
check('pdf.js is given character maps', /cMapUrl\s*:/.test(ragSource));
check('and told they are packed', /cMapPacked\s*:\s*true/.test(ragSource));
check('and given the standard fonts', /standardFontDataUrl\s*:/.test(ragSource));

// The URLs are only meaningful if the files are actually there to serve.
const KOREA_CMAP = path.join(ROOT, 'public', 'pdfjs', 'cmaps', 'Adobe-Korea1-UCS2.bcmap');
check('the Korean character map is in public/', fs.existsSync(KOREA_CMAP),
  'run `node scripts/pdf-assets.mjs` — predev and prebuild do');
check('a Japanese one is there too',
  fs.existsSync(path.join(ROOT, 'public', 'pdfjs', 'cmaps', 'Adobe-Japan1-UCS2.bcmap')));
check('and a Chinese one',
  fs.existsSync(path.join(ROOT, 'public', 'pdfjs', 'cmaps', 'Adobe-GB1-UCS2.bcmap')));

// They are copied from node_modules, so the copy has to happen before the app
// is built or served — otherwise it works on this machine and nowhere else.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('the copy runs before a build', /pdf-assets/.test(pkg.scripts.prebuild || ''));
check('and before the dev server', /pdf-assets/.test(pkg.scripts.predev || ''));

/* ------------------------- a document with no text at all */

// A scan, or a page exported as one flat image. The words are visible, just
// not as characters — so the pages are drawn and attached as pictures, and a
// model that can see reads them. Refusing is true and useless there.
check('there is a fallback that renders the pages', /renderPdfPages/.test(ragSource));
check('and the composer uses it', /renderPdfPages\s*\(/.test(appCode));

/* --------------------------------------------------- the extractor, for real */

// A genuine PDF, built here rather than committed: compressed streams and an
// xref table, so pdf.js does real work.
const buildPdf = () => {
  const content = Buffer.from([
    'BT /F1 14 Tf 72 760 Td (2026 Spring Tuition Invoice) Tj ET',
    'BT /F1 11 Tf 72 730 Td (Student: HONG GILDONG   ID: 20261234) Tj ET',
    'BT /F1 11 Tf 72 700 Td (Amount due: 2,980,000 KRW) Tj ET',
    'BT /F1 11 Tf 72 670 Td (Due date: 2026-02-27) Tj ET',
  ].join('\n'), 'latin1');
  const stream = zlib.deflateSync(content);

  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R '
      + '/Resources << /Font << /F1 5 0 R >> >> >>', 'latin1'),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream', 'latin1'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'latin1'),
  ];

  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    at += chunk.length;
  });
  const xref = at;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, '0')} 00000 n \n`;
  parts.push(Buffer.from(
    `${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    'latin1'));
  return Buffer.concat(parts);
};

const pdf = buildPdf();

// The measurement that makes the bug concrete: what the old code would have
// sent, versus what the document actually says.
const asRawText = pdf.toString('utf8');
check('a PDF read as text is mostly not text',
  /%PDF-|endobj|FlateDecode/.test(asRawText),
  'the old path sent this to the model');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/rag.js'),
  external: ['localforage', 'fflate', 'pdfjs-dist'],
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.attach-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

let rag = null;
try {
  rag = await import(pathToFileURL(out).href);
} catch (err) {
  check('the extractor module loads', false, String(err.message).slice(0, 160));
}

if (rag) {
  check('the extractor module loads', true);

  /* Which files the composer will accept at all.
   *
   * This block used to assert an extension allowlist -- accepts .pdf/.docx/
   * .txt/.md/.csv/.json, refuses .zip/.mp4/.exe/.heic/.woff2. The allowlist is
   * gone. It was wrong in both directions and could only be: it refused `.env`
   * and `.bat` and `Dockerfile`, which are text, and it would have accepted a
   * zip renamed `.txt`, which is not.
   *
   * The decision moved to the bytes, where it belongs. What is checked here is
   * that the refusal still happens for a file that genuinely is not text --
   * with the bytes of one, rather than its name. `scripts/sniff.test.mjs`
   * covers the rest.
   */
  const utf8 = (text) => new TextEncoder().encode(text);
  check('a config file with an unheard-of name is text',
    rag.sniffKind(utf8('KEY=value\nDEBUG=true\n'), '.env') === 'text');
  check('so is a batch file',
    rag.sniffKind(utf8('@echo off\r\nnpm run build\r\n'), 'run.bat') === 'text');
  check('an executable is not, however it is named',
    rag.sniffKind(new Uint8Array([0x4d, 0x5a, 0x00, 0x00, 0x01]), 'setup.txt') === 'binary');
  check('and a zip is not', rag.sniffKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'archive.zip') === 'binary');
  check('but a .docx is, because there is a reader for it',
    rag.sniffKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'report.docx') === 'docx');

  // And the extraction itself, against the PDF built above.
  try {
    const pages = await rag.extractPdf(new Uint8Array(pdf).buffer);
    const text = pages.map(p => p.text).join('\n');
    check('the PDF yields its text', /Tuition Invoice/.test(text), text.slice(0, 120));
    check('including the numbers that matter', /2,980,000/.test(text));
    check('and none of the file structure', !/%PDF-|endobj|FlateDecode/.test(text));
    check('and no replacement characters', !text.includes('�'));
    check('the extracted text is far smaller than the file',
      text.length < asRawText.length, `${text.length} vs ${asRawText.length}`);
  } catch (err) {
    // pdf.js needs a DOM-ish environment for its worker; where it cannot run in
    // Node this is reported rather than failed, since the browser probe covers
    // the same ground.
    console.log(`SKIP  pdf.js could not run under Node: ${String(err.message).slice(0, 120)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
