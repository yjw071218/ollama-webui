// Deciding what a file is by looking at it.
//
// There used to be a list of extensions, and a list of extensions can only
// ever be wrong in both directions at once. It refused `.env`, `.bat`, `.ini`,
// `.toml`, `.rs`, `.go`, `.vue`, `.kt`, `Dockerfile` and `Makefile` — every
// one of them plainly text and every one of them something somebody wanted to
// attach. And it would happily have passed a zip renamed to `.txt` straight
// into the decoder, which is exactly the failure that once turned a PDF into a
// hundred thousand characters of mojibake.
//
// "Text" is not a format. It is a property of the bytes, and the bytes are
// right there — so the question is answered by reading them.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({
  input: path.resolve(HERE, '../src/rag.js'),
  external: ['localforage', 'pdfjs-dist', 'mammoth'],
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.sniff-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { looksBinary, sniffKind, isSupportedDocument } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const bytes = (text) => new TextEncoder().encode(text);

/* ------------------------------------- the files the old list turned away */

// Every one of these is a real thing somebody attaches, and every one of them
// was refused for having the wrong name.
const TEXT_FILES = {
  '.env': 'DATABASE_URL=postgres://localhost:5432/app\nAPI_KEY=abc123\nDEBUG=true\n',
  '.bat': '@echo off\r\nsetlocal\r\ncall npm run build\r\nif errorlevel 1 exit /b 1\r\n',
  '.ini': '[server]\nhost = 127.0.0.1\nport = 8080\n',
  '.toml': '[package]\nname = "thing"\nversion = "0.1.0"\n',
  '.rs': 'fn main() {\n    println!("hello");\n}\n',
  '.go': 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n',
  '.vue': '<template><div>{{ msg }}</div></template>\n<script>export default {}</script>\n',
  '.kt': 'fun main() {\n    println("hello")\n}\n',
  '.swift': 'import Foundation\nprint("hello")\n',
  '.sql': 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n',
  '.ps1': 'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1MB }\n',
  '.gitignore': 'node_modules/\ndist/\n*.log\n',
  'Dockerfile': 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci\n',
  'Makefile': 'all:\n\tnpm run build\n\nclean:\n\trm -rf dist\n',
  'no-extension-at-all': 'just some notes I wrote down\nsecond line\n',
};
for (const [name, body] of Object.entries(TEXT_FILES)) {
  eq(`${name} reads as text`, sniffKind(bytes(body), name), 'text');
}

// Windows files are CRLF and often not UTF-8; neither makes them binary.
eq('a CRLF file is text', sniffKind(bytes('line one\r\nline two\r\n'), 'a.bat'), 'text');
eq('an empty file is text, not binary', sniffKind(new Uint8Array(0), 'empty.txt'), 'text');
eq('a file of only newlines is text', sniffKind(bytes('\n\n\n'), 'x.txt'), 'text');

// Latin-1 accents decode as a few replacement characters and must survive:
// refusing a config file over one stray byte would be the old bug in reverse.
const latin1 = new Uint8Array([...bytes('caf'), 0xe9, ...bytes(' na'), 0xef, ...bytes('ve resume text here')]);
eq('a Latin-1 file is still text', sniffKind(latin1, 'notes.txt'), 'text');

// Korean, Japanese and emoji are multi-byte UTF-8 and decode cleanly.
eq('Korean is text', sniffKind(bytes('안녕하세요\n설정 파일입니다\n'), 'ko.txt'), 'text');
eq('emoji are text', sniffKind(bytes('status: ✅ done 🎉\n'), 'log.txt'), 'text');

/* ------------------------------------------- and the ones it must refuse */

// A NUL byte is the signal. Text files do not contain one; practically every
// binary format does within the first few kilobytes.
const withNul = new Uint8Array([...bytes('MZ'), 0x00, 0x00, ...bytes('this is an exe')]);
eq('an executable is binary', sniffKind(withNul, 'thing.exe'), 'binary');
eq('and is still binary when renamed .txt', sniffKind(withNul, 'thing.txt'), 'binary');
check('looksBinary agrees on its own', looksBinary(withNul) === true);

// High bytes that are not valid UTF-8, in quantity: the mojibake flood.
const garbage = new Uint8Array(600);
for (let i = 0; i < garbage.length; i++) garbage[i] = 0x80 + (i % 0x40);
eq('a wall of invalid UTF-8 is binary', sniffKind(garbage, 'data.bin'), 'binary');
eq('renaming it does not help', sniffKind(garbage, 'data.txt'), 'binary');

/* ------------------------------------------------- the ones with readers */

// The signature decides, so a PDF saved with no extension is still a PDF.
const pdf = new Uint8Array([...bytes('%PDF-1.7\n'), 0x00, 0x01, 0x02]);
eq('a PDF is a PDF', sniffKind(pdf, 'invoice.pdf'), 'pdf');
eq('a PDF named .txt is still a PDF', sniffKind(pdf, 'invoice.txt'), 'pdf');
eq('a PDF with no extension is still a PDF', sniffKind(pdf, 'invoice'), 'pdf');

// docx is a zip, and so is every other Office format, a jar and an epub.
// Only the name can tell them apart, and only docx has a reader here.
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
eq('a .docx is a docx', sniffKind(zip, 'report.docx'), 'docx');
eq('an .xlsx is not, since nothing here reads one', sniffKind(zip, 'sheet.xlsx'), 'binary');
eq('a plain .zip is binary', sniffKind(zip, 'archive.zip'), 'binary');

/* ------------------------------------------------------- the gate itself */

// It exists only so the two callers have something to ask; the answer is now
// always yes, because reading the file is what decides.
eq('anything may be attempted', isSupportedDocument({ name: 'whatever.xyz' }), true);
eq('even with no argument', isSupportedDocument(), true);

/* --------------------------------------------------------- the call sites */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const panel = fs.readFileSync(path.resolve(HERE, '../src/KnowledgePanel.jsx'), 'utf8').replace(/\r\n/g, '\n');
const rag = fs.readFileSync(path.resolve(HERE, '../src/rag.js'), 'utf8').replace(/\r\n/g, '\n');

// The file picker must not grey out files the app can read.
check('the composer picker has no extension filter',
  !/accept="[^"]*\.txt/.test(app), (app.match(/accept="[^"]*"/g) || []).join(' '));
check('nor does the knowledge panel', !/accept="[^"]*\.txt/.test(panel));

// The old allowlist is gone from the place it lived.
check('rag.js keeps no list of readable extensions',
  !/\\\.\(pdf\|docx\|txt\|md/.test(rag));

// A file that really is not text is still refused, and says why.
check('the composer refuses binary with its own message',
  /err\.code === 'binary'[\s\S]{0,160}attach\.unsupported/.test(app));
check('so does the knowledge panel', /e\.code === 'binary'/.test(panel));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
