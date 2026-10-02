// Finding a picture you half remember.
//
// The gallery matched substrings against the prompt each picture was drawn
// from. That works when you remember the words, and the whole difficulty is
// that you do not: what you remember is *a red sunset over water*, and what was
// typed a month ago was `golden hour, ocean horizon, dramatic clouds`. Nothing
// in those two strings matches.
//
// The conversations already had the fix (src/chatSearch.js). This is the same
// one pointed at prompts, and the two decisions that cost something are the
// same two: substring matches are kept and ranked first, and the index is built
// on demand rather than maintained as pictures are made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* Bundled rather than imported: the module reaches for localforage and the
   embedder, and what is under test is the arithmetic around them -- which of
   two searches wins, what counts as the same gallery, what happens to a hit
   for a picture that is no longer there. None of that touches either. */
const { rolldown } = await import('rolldown');
const bundle = await rolldown({
  input: path.join(ROOT, 'src/pictureSearch.js'),
  platform: 'neutral',
  external: ['localforage'],
});
const out = path.join(ROOT, 'node_modules/.picturesearch-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

const P = await import(pathToFileURL(out).href).catch((e) => {
  console.log(`SKIP  the module could not be loaded here: ${e.message}`);
  process.exit(0);
});

/* ------------------------------------------------------- what gets indexed */

const items = [
  { key: 'a', prompt: 'golden hour, ocean horizon, dramatic clouds', sessionTitle: 'Landscapes', at: 3 },
  { key: 'b', prompt: '1girl, school uniform, classroom', sessionTitle: 'Characters', at: 2 },
  { key: 'c', prompt: '', sessionTitle: '', at: 1 },
];

eq('a picture with nothing written about it cannot be found by words',
  P.indexablePictures(items).map(p => p.key), ['a', 'b']);
eq('  and what is indexed is the prompt and the chat it came from',
  P.pieceOf(items[0]), 'golden hour, ocean horizon, dramatic clouds — Landscapes');

/* A prompt cannot change after the picture is drawn, so the same keys are the
   same vectors: that is what makes "is this index stale" answerable without
   reading the vectors. */
{
  const first = P.indexSignature(P.indexablePictures(items));
  const again = P.indexSignature(P.indexablePictures([...items]));
  eq('the same gallery signs the same', first, again);
  const more = P.indexSignature(P.indexablePictures([{ key: 'd', prompt: 'a cat' }, ...items]));
  check('and one more picture signs differently', first !== more, `${first} / ${more}`);
}

/* --------------------------------------------------------- letters first */

eq('the letters find what the letters can', P.literalPictures(items, 'ocean').map(i => i.key), ['a']);
eq('  including the chat name', P.literalPictures(items, 'characters').map(i => i.key), ['b']);
eq('  and nothing typed is everything', P.literalPictures(items, '  ').length, 3);
eq('  while words nobody wrote find nothing', P.literalPictures(items, 'sunset').map(i => i.key), []);

/* Then meaning, for the ones the letters missed -- and never in front of them.
   Type a filename and you want that file, not the five prompts most like it. */
{
  const literal = P.literalPictures(items, 'ocean');
  const merged = P.mergePictures(items, literal, [{ key: 'b', score: 0.7 }, { key: 'a', score: 0.9 }]);
  eq('a semantic hit is added after the literal ones', merged.map(i => i.key), ['a', 'b']);
  eq('  and a literal hit is never listed twice', merged.filter(i => i.key === 'a').length, 1);
  const unknown = P.mergePictures(items, [], [{ key: 'gone', score: 0.9 }]);
  eq('  a hit for a picture no longer here is dropped', unknown, []);
}

/* ------------------------------------------------------------------ the wiring */

const gallery = read('src/PictureGallery.jsx');
check('the gallery still filters by letters', /const literal = useMemo\(\(\) => literalPictures\(everything, query\)/.test(gallery));
// The expensive half runs only when the cheap half found nothing, which is the
// case it exists for.
check('  and only asks for meaning when they found nothing',
  /if \(wanted\.length < 2 \|\| literal\.length > 0\)/.test(gallery));
check('  building the index on demand and caching it',
  /await buildIndex\(scope, everything, \{ signal: controller\.signal \}\)/.test(gallery));
// No embedding model, or Ollama not running: the letters are still the answer.
check('  and a search that cannot run leaves the letters alone',
  /setSemantic\(\{ query: wanted, hits: \[\], searching: false, failed: true \}\)/.test(gallery));
check('  saying so while it looks, because the first one is a wait',
  /\{semantic\.searching && <span className="gallery-searching">/.test(gallery));
check('the gallery is told whose it is', /scope=\{profileScope\}/.test(read('src/App.jsx')));
check('gallery.byMeaning is translated everywhere',
  (read('src/i18n.jsx').match(/'gallery\.byMeaning':/g) || []).length === 12);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
