// Cutting text without cutting a character in half.
//
// The report was that generated text sometimes shows up as `��`. That is what
// a lone surrogate looks like after anything encodes it, and a lone surrogate
// is what you get when a JavaScript string is cut through the middle of a
// character that lives outside the Basic Multilingual Plane — every emoji, and
// a good many rare CJK characters, which are two UTF-16 code units each.
//
//     '완료 🎉'.slice(0, 4)  ->  '완료 \ud83c'   ->  encoded  ->  '완료 �'
//
// It is silent. Nothing throws, nothing is logged, and it only happens when a
// cut lands on exactly the wrong index — which is why it looked random and why
// it went unnoticed. The cuts that could do it were in the continuation
// joiner (which stitches a truncated answer back together), the chunker that
// feeds retrieved passages into a prompt, and the transcript budgets used for
// compaction and titles.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleOne = async (entry, out, external = []) => {
  const b = await rolldown({ input: path.resolve(HERE, entry), external, platform: 'neutral' });
  const file = path.resolve(HERE, out);
  await b.write({ file, format: 'esm' });
  await b.close();
  return import(pathToFileURL(file).href);
};

const cut = await bundleOne('../src/textCut.js', '../node_modules/.textcut-test-bundle.mjs');
const cont = await bundleOne('../src/continuation.js', '../node_modules/.textcut-cont-bundle.mjs');
const rag = await bundleOne('../src/rag.js', '../node_modules/.textcut-rag-bundle.mjs',
  ['localforage', 'pdfjs-dist', 'fflate']);

const { safeIndex, safeSlice, safeHead, safeTail, stripLoneSurrogates, hasLoneSurrogate } = cut;
const { trimOverlap } = cont;
const { chunkPages } = rag;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------- what the bug looks like */

const EMOJI = '완료 🎉 끝';
// The mechanism, stated as a test so the rest has a reason to exist.
check('a plain slice really does break a character',
  hasLoneSurrogate(EMOJI.slice(0, 4)), JSON.stringify(EMOJI.slice(0, 4)));
check('and encoding it really does produce the replacement character',
  Buffer.from(EMOJI.slice(0, 4), 'utf8').toString('utf8').includes('�'));

/* ------------------------------------------------------------ safeIndex */

eq('an index between a pair moves back', safeIndex(EMOJI, 4), 3);
eq('an index on a whole character stays', safeIndex(EMOJI, 3), 3);
eq('past the end is the end', safeIndex(EMOJI, 999), EMOJI.length);
eq('before the start is the start', safeIndex(EMOJI, -5), 0);
eq('an empty string has one index', safeIndex('', 3), 0);

/* -------------------------------------------------------------- the cuts */

check('safeHead never leaves half a character', !hasLoneSurrogate(safeHead(EMOJI, 4)));
eq('and it cuts before the pair rather than through it', safeHead(EMOJI, 4), '완료 ');
eq('a cut that does not split anything is unchanged', safeHead(EMOJI, 5), '완료 🎉');
eq('a head longer than the text is the text', safeHead(EMOJI, 999), EMOJI);
eq('a head of nothing is nothing', safeHead(EMOJI, 0), '');

check('safeTail never leaves half a character', !hasLoneSurrogate(safeTail(EMOJI, 4)));
// '완료 🎉 끝' is 완(0) 료(1) ' '(2) 🎉(3,4) ' '(5) 끝(6).
eq('a tail that begins on a whole character keeps it', safeTail(EMOJI, 4), '🎉 끝');
// Forward, not back: a tail beginning at 4 begins on the *low* half of the
// emoji, i.e. inside a character, and reaching back for its other half would
// return more than was asked for.
eq('a tail that begins inside a pair drops that character', safeTail(EMOJI, 3), ' 끝');
eq('a tail longer than the text is the text', safeTail(EMOJI, 999), EMOJI);

check('safeSlice is clean at both ends', !hasLoneSurrogate(safeSlice(EMOJI, 4, 5)));

// Every index of a string full of emoji, to be sure no offset is missed.
const DENSE = '가🎉나🙂다🚀라';
for (let i = 0; i <= DENSE.length; i++) {
  const head = safeHead(DENSE, i);
  const tail = safeTail(DENSE, i);
  if (hasLoneSurrogate(head)) check(`safeHead(${i}) is clean`, false, JSON.stringify(head));
  if (hasLoneSurrogate(tail)) check(`safeTail(${i}) is clean`, false, JSON.stringify(tail));
}
check('every offset of a dense string cuts cleanly', true);

/* ---------------------------------------------------------- the last guard */

eq('a lone high surrogate is removed', stripLoneSurrogates('a\uD83Cb'), 'ab');
eq('a lone low surrogate is removed', stripLoneSurrogates('a\uDF89b'), 'ab');
eq('a real pair is untouched', stripLoneSurrogates('a🎉b'), 'a🎉b');
eq('ordinary text is untouched', stripLoneSurrogates('안녕하세요'), '안녕하세요');
eq('and the common case returns the same string', stripLoneSurrogates('plain'), 'plain');
eq('nothing is nothing', stripLoneSurrogates(null), '');

/* -------------------------------- the joiner that stitches a cut-off answer */

// This is the one that shows up as a broken character in an answer, because
// the two halves are joined and displayed. The overlap window used to be a
// fixed number of code units.
{
  // A previous half ending in emoji, exactly at the window boundary.
  const previous = 'x'.repeat(398) + '🎉';
  const next = 'continued from here';
  const joined = trimOverlap(previous, next);
  check('trimOverlap leaves no half-character', !hasLoneSurrogate(joined), JSON.stringify(joined.slice(0, 40)));
}
{
  // And the ordinary job still works: a repeated opening is still trimmed.
  const previous = 'The answer is that a hash table stores key-value pairs';
  const next = 'stores key-value pairs and looks them up in constant time';
  const joined = trimOverlap(previous, next);
  check('and it still removes a repeated opening',
    joined === ' and looks them up in constant time', JSON.stringify(joined));
}
{
  const previous = 'ends with an emoji 🎉';
  const next = '🎉 and carries on';
  check('an overlap that is itself an emoji does not break',
    !hasLoneSurrogate(trimOverlap(previous, next)));
}

/* --------------------------- the chunker that feeds passages into a prompt */

{
  // A paragraph longer than one chunk, made entirely of two-unit characters,
  // so every hard split lands between the halves of one.
  const wall = '🎉'.repeat(3000);
  const chunks = chunkPages([{ page: 1, text: wall }], { size: 100, overlap: 20 });
  check('the chunker produced something', chunks.length > 1, String(chunks.length));
  const broken = chunks.filter(c => hasLoneSurrogate(c.text));
  check('and no chunk holds half a character', broken.length === 0,
    `${broken.length} of ${chunks.length} chunks`);
}
{
  // The overlap tail is fed back into the next chunk, so it has to be clean too.
  const paragraphs = Array.from({ length: 12 }, (_, i) => `문단 ${i} 🚀 ${'가'.repeat(60)}`).join('\n\n');
  const chunks = chunkPages([{ page: 1, text: paragraphs }], { size: 200, overlap: 40 });
  check('nor does any chunk built from an overlap tail',
    chunks.every(c => !hasLoneSurrogate(c.text)), String(chunks.length));
}

/* -------------------------------------------------------- the call sites */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const ragSrc = fs.readFileSync(path.resolve(HERE, '../src/rag.js'), 'utf8');
const contSrc = fs.readFileSync(path.resolve(HERE, '../src/continuation.js'), 'utf8');

check('the continuation joiner cuts safely', /safeTail\(previous, OVERLAP_WINDOW\)/.test(contSrc));
check('the chunker keeps its overlap tail whole', /safeTail\(trimmed, overlap\)/.test(ragSrc));
check('and its hard split too', /safeSlice\(piece, i, i \+ size\)/.test(ragSrc));

// The transcript budgets: a broken character in a compaction summary replaces
// real turns and then stays in the conversation for good.
check('the compaction transcript is cut safely', /safeHead\(older/.test(app));
check('the memory transcript too', /safeHead\(messages/.test(app));
check('and the per-message budgets', /safeHead\(cleanForExport\(m\.content\), 1500\)/.test(app));
check('the title prompt too', /safeHead\(cleanForExport\(userText\), 1200\)/.test(app));
check('and the attachment excerpt', /safeHead\(text, MAX_ATTACHMENT_CHARS\)/.test(app));

// Nothing half-formed reaches storage, the account, or the next prompt.
check('the streamed answer is guarded before it is committed',
  /stripLoneSurrogates\(decodeByteFallback\(rawAnswerText\)\)/.test(app));
check('and so is the reasoning',
  /stripLoneSurrogates\(decodeByteFallback\(rawThinkingText\)\)/.test(app));

// The old, unsafe budgets are gone rather than merely joined by safe ones.
check('no plain slice is left on a transcript budget',
  !/\.slice\(0, 12000\)/.test(app) && !/\.slice\(0, 20000\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
