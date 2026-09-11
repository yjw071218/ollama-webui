// Long attachments, and long pastes.
//
// Two problems with one shape: something arrives that is too big for the place
// it was put, and the old answer to both was to lose part of it.
//
// A file over 30,000 characters was sliced at 30,000 and sent. A fifty-page
// report therefore arrived as its first ten pages, the model answered
// confidently about a document it had only seen the beginning of, and nothing
// in the answer said which part it was based on — which is a worse failure
// than refusing the file, because it looks like success. It is embedded whole
// now and retrieved from.
//
// A paste of four hundred lines went into the composer, where it buried the
// question underneath it: you could see neither what you were typing nor what
// you had pasted. It becomes an attachment now.
//
// What is checked here is the part that decides: when a paste is long enough
// to collapse, and what the resulting chip is called.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({
  input: path.resolve(HERE, '../src/ingest.js'),
  external: ['localforage', 'pdfjs-dist', 'mammoth'],
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.ingest-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  shouldPasteAsFile, namePastedText,
  PASTE_AS_FILE_CHARS, PASTE_AS_FILE_LINES, EMBED_BATCH,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------ when a paste becomes a file */

// The everyday paste must still land in the composer. If a pasted URL or a
// sentence turned into an attachment, this feature would be an obstacle.
eq('a word stays in the composer', shouldPasteAsFile('hello'), false);
eq('a sentence stays', shouldPasteAsFile('Can you explain what a hash table is, briefly?'), false);
eq('a URL stays', shouldPasteAsFile('https://example.com/some/quite/long/path?with=query'), false);
eq('a few lines stay', shouldPasteAsFile('one\ntwo\nthree\nfour'), false);
eq('nothing at all stays', shouldPasteAsFile(''), false);
eq('whitespace stays', shouldPasteAsFile('   \n  \n '), false);
eq('null does not throw', shouldPasteAsFile(null), false);

// Long by characters. One line of minified JSON is as unreadable in a one-line
// composer as three hundred short ones, which is why length counts on its own.
eq('one enormous line becomes a file', shouldPasteAsFile('x'.repeat(PASTE_AS_FILE_CHARS)), true);
eq('just under the limit does not', shouldPasteAsFile('x'.repeat(PASTE_AS_FILE_CHARS - 1)), false);

// Long by lines. A stack trace is many short lines and no single long one.
const trace = Array.from({ length: PASTE_AS_FILE_LINES }, (_, i) => `  at frame${i}`).join('\n');
eq('a stack trace becomes a file', shouldPasteAsFile(trace), true);
check('and it is nowhere near the character limit', trace.length < PASTE_AS_FILE_CHARS, String(trace.length));
eq('one line short does not',
  shouldPasteAsFile(Array.from({ length: PASTE_AS_FILE_LINES - 1 }, (_, i) => `  at frame${i}`).join('\n')), false);

/* --------------------------------------------------- what it is called */

// The name is the only thing the chip can show, so it should say what the
// thing is. A wrong guess costs a slightly odd label and nothing else.
const named = (text) => namePastedText(text);

eq('JSON', named('{"a": 1, "b": [2, 3]}'), 'pasted.json');
eq('a JSON array', named('[\n  {"a": 1}\n]'), 'pasted.json');
eq('Python', named('def add(a, b):\n    return a + b'), 'pasted.py');
eq('a Python import', named('import os\nimport sys\n\nprint(os.getcwd())'), 'pasted.py');
eq('TypeScript', named('interface User {\n  name: string;\n}'), 'pasted.ts');
eq('JavaScript', named('const x = 1;\nfunction go() { return x; }'), 'pasted.js');
eq('SQL', named('SELECT id, name FROM users WHERE active = 1;'), 'pasted.sql');
eq('HTML', named('<!doctype html>\n<html><body>hi</body></html>'), 'pasted.html');
eq('a shell session', named('$ npm install\n$ npm test'), 'pasted.sh');
eq('a traceback', named('Traceback (most recent call last):\n  File "a.py", line 1'), 'pasted.log');
eq('prose falls back to txt', named('The quick brown fox jumps over the lazy dog, repeatedly.'), 'pasted.txt');
eq('nothing falls back to txt', named(''), 'pasted.txt');
eq('null falls back to txt', named(null), 'pasted.txt');

eq('the prefix can be changed', namePastedText('hello', { prefix: 'clip' }), 'clip.txt');

// Every name has to be a usable filename: it is shown in a chip, and it is
// sent to the model as `--- Attached File: <name> ---`.
for (const sample of ['{"a":1}', 'def f(): pass', 'SELECT 1', 'plain words']) {
  const name = namePastedText(sample);
  check(`"${name}" is a plain filename`, /^[\w.-]+$/.test(name), name);
}

/* ------------------------------------------------- the wiring in the app */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

// The whole point: a long file is indexed, not sliced. The slice survives only
// as the fallback for when embedding is not available at all.
check('a long attachment is indexed', /ingestDocument\(bigFile/.test(app));
check('and the library is updated so retrieval can see it', /setKnowledge\(library\)/.test(app));
check('and retrieval is switched on, since the file was just attached',
  /if \(!ragEnabled\) setRagEnabled\(true\)/.test(app));
// Cutting survives only as the fallback for when embedding is unavailable —
// and it cuts on a character boundary now, because a plain `slice` can land
// between the halves of an emoji and leave U+FFFD in the excerpt. See
// scripts/textcut.test.mjs.
check('cutting survives only as a fallback',
  /catch \(err\)[\s\S]{0,600}?safeHead\(text, MAX_ATTACHMENT_CHARS\)/.test(app));

// An indexed document must not be pasted into the message as well: its text is
// in the library, and sending both would be the token bill this avoids.
const sendBlock = app.match(/currentAttachments\.forEach\([\s\S]*?\n {8}\}\);/);
check('the send path handles indexed documents', !!sendBlock && /att\.type === 'indexed'/.test(sendBlock[0]));
check('and does not put their text in the message',
  !!sendBlock && !/'indexed'[\s\S]{0,200}\$\{att\.data\}/.test(sendBlock[0]));
check('a pasted block is sent exactly like an attached file',
  !!sendBlock && /att\.type === 'text' \|\| att\.type === 'pasted'/.test(sendBlock[0]));

// The chip opens. An attachment you cannot look at is one you have to take on
// trust, and the moment you want to check is before sending.
check('the chip is a button that opens the attachment', /setViewingAttachment\(att\)/.test(app));
check('there is a viewer to open into', /className="attachment-viewer"/.test(app));
check('an image opens at size', /attachment-viewer-body[\s\S]{0,400}?<img/.test(app));
check('an indexed document shows its passages rather than nothing',
  /indexedPreview\s*=\s*\(att\)/.test(app) && /doc\.chunks\.slice\(0, 12\)/.test(app));

// One ingest routine, used from both places.
const panel = fs.readFileSync(path.resolve(HERE, '../src/KnowledgePanel.jsx'), 'utf8');
check('the knowledge panel uses the shared routine', /ingestDocument\(file/.test(panel));
check('and no longer has its own copy', !/embedTexts\(batch/.test(panel));
check('the batch size lives with the routine', Number.isInteger(EMBED_BATCH) && EMBED_BATCH > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
