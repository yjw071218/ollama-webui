// Reading an answer out while it is still arriving.
//
// The reply used to be spoken only once it had finished. On a local 31B at
// four tokens a second that is a minute or two of silence first — and in
// hands-free mode, where the whole point is not looking at the screen, a
// minute of silence is indistinguishable from the app having died.
//
// The difficulty is entirely in where to cut. A piece that ends mid-sentence
// sounds wrong however good the voice is: the intonation falls where a comma
// was and the next piece starts as though it were a new thought. So the cut
// goes at a sentence end and nowhere else — and "sentence end" has to mean
// `。` and `？` too, or a Korean answer never triggers once and this is back to
// speaking at the end.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({ input: path.resolve(HERE, '../src/speechChunks.js'), platform: 'neutral' });
const out = path.resolve(HERE, '../node_modules/.speech-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { takeSpeakable, splitForSpeech, MIN_PIECE, MAX_PIECE } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------- nothing said too early */

// A half-written sentence must wait. Saying it and then saying the rest as a
// new sentence is the failure this whole module exists to avoid.
eq('a fragment waits', takeSpeakable('A hash table stores').piece, '');
eq('and stays in the buffer', takeSpeakable('A hash table stores').rest, 'A hash table stores');
eq('an empty buffer says nothing', takeSpeakable('').piece, '');
eq('whitespace says nothing', takeSpeakable('   \n ').piece, '');

// Too short to be worth a request of its own, even though it is a sentence.
eq('a very short sentence waits for company', takeSpeakable('Yes. ').piece, '');

/* --------------------------------------------------- and cut at sentences */

const EN = 'A hash table stores key-value pairs in an array of buckets. '
  + 'It uses a hash function to turn a key into an index. '
  + 'And so a lookup costs constant time on average. ';
{
  const { piece, rest } = takeSpeakable(EN);
  check('a full sentence is ready', piece.length > 0, piece);
  check('and it ends on a sentence end', /[.!?。！？…]$/.test(piece), piece.slice(-30));
  check('the rest is kept', (piece + rest).replace(/\s+/g, ' ').trim() === EN.replace(/\s+/g, ' ').trim());
}

// The *last* end at or after the minimum, not the first: three short sentences
// are better said in one breath than in three requests, because the gap
// between requests is audible.
{
  const many = 'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Eleven. Twelve. ';
  const { piece } = takeSpeakable(many);
  check('several short sentences go together', piece.split('.').length > 3, piece);
}

/* -------------------------------------------------------------- Korean */

// The rule written only for `.` would never fire on this, and the whole answer
// would arrive as one "sentence" — which is the bug, not the fix.
const KO = '해시 테이블은 키와 값을 저장합니다. 해시 함수로 키를 인덱스로 바꿉니다. 그래서 조회가 평균 상수 시간입니다. ';
{
  const pieces = splitForSpeech(KO);
  check('Korean is split at all', pieces.length >= 1, JSON.stringify(pieces));
  check('and nothing is lost',
    pieces.join(' ').replace(/\s+/g, '') === KO.replace(/\s+/g, ''),
    pieces.join(' ').slice(0, 60));
}
{
  // A full-width question mark is a sentence end too. Long enough to clear
  // MIN_PIECE, or nothing is ready and the test would be measuring the
  // minimum rather than the punctuation.
  const q = '이것은 무엇입니까？ '.repeat(8);
  check('the sample is past the minimum', q.length > MIN_PIECE, String(q.length));
  const { piece } = takeSpeakable(q);
  check('a full-width question mark ends a sentence', piece.endsWith('？'), JSON.stringify(piece.slice(-20)));
}
{
  const ja = 'これはハッシュテーブルです。キーと値を保存します。検索は平均して定数時間です。'.repeat(2);
  const pieces = splitForSpeech(ja);
  check('Japanese splits on 。', pieces.length >= 1 && pieces.every(p => p.trim()), JSON.stringify(pieces).slice(0, 80));
}

/* ---------------------------------------------- a wall with no punctuation */

// Waiting for a full stop that is never coming means never speaking.
{
  const wall = 'word '.repeat(300);
  const { piece, rest } = takeSpeakable(wall);
  check('an unpunctuated wall is still said', piece.length > 0, String(piece.length));
  check('and it is cut at a word boundary', !piece.endsWith('wor'), piece.slice(-12));
  check('within the ceiling', piece.length <= MAX_PIECE + 1, String(piece.length));
  check('and the remainder is kept', rest.length > 0);
}

/* ----------------------------------------------------- the end of a stream */

// Whatever is left when the model stops is all there will ever be, sentence or
// not — otherwise the last few words of every answer are never spoken.
eq('the final pass says the remainder', takeSpeakable('and finally', { final: true }).piece, 'and finally');
eq('and leaves nothing behind', takeSpeakable('and finally', { final: true }).rest, '');
eq('a final pass on nothing says nothing', takeSpeakable('  ', { final: true }).piece, '');

/* ------------------------------------------------------------- splitting */

{
  const pieces = splitForSpeech(EN);
  check('a whole answer splits into pieces', pieces.length >= 1, String(pieces.length));
  check('every piece has something in it', pieces.every(p => p.trim().length > 0));
  check('and together they are the answer',
    pieces.join(' ').replace(/\s+/g, ' ').trim() === EN.replace(/\s+/g, ' ').trim());
}
eq('nothing splits into nothing', splitForSpeech('').length, 0);
eq('null splits into nothing', splitForSpeech(null).length, 0);

// A rule that consumed nothing would spin here for ever.
{
  const started = Date.now();
  splitForSpeech('.'.repeat(5000));
  check('a pathological input terminates', Date.now() - started < 3000, `${Date.now() - started}ms`);
}

/* --------------------------------------------------------- the call sites */

const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

check('speech starts while the answer is still arriving',
  /if \(delta\.content\) speakAsItArrives\(false\)/.test(app));
check('and the tail is said when it ends', /speakAsItArrives\(true\)/.test(app));
check('only when reading aloud was asked for',
  /if \(!\(ttsAutoPlay \|\| voiceModeRef\.current\)\) return;/.test(app));

// Pieces must play one after another rather than on top of one another.
check('there is a queue', /speechQueueRef/.test(app));
check('and one pump, so two pieces cannot play at once', /speechPumpRef\.current\) return;/.test(app));
check('the pump waits for each clip to finish', /await synthesiseAndPlay\(next\.text, next\.index\)/.test(app));
check('stopping clears what has not been said yet', /speechQueueRef\.current = \[\];/.test(app));

// The speaker button and the streamed path share the splitter, so a message
// read by hand sounds the same as one read as it arrived.
check('the button uses the same splitter', /for \(const piece of splitForSpeech\(cleanText\)\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
