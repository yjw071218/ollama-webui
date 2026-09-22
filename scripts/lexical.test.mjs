// BM25, the CJK tokeniser and rank fusion, plus the second pass that reads the
// shortlist. Both modules are pure apart from one `fetch`, which is stubbed.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.lexical-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, './fixtures/lexical-entry.mjs'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { tokenize, hasCJK, buildLexicalIndex, lexicalSearch, fuseRRF, rerankHits } =
  await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ----------------------------------------------------------------- tokenising
check('lowercases', tokenize('Hello WORLD').includes('hello'));
check('drops a stopword', !tokenize('the cat').includes('the'));
check('keeps the word beside it', tokenize('the cat').includes('cat'));
check('drops a stray letter', !tokenize('a x cat').includes('x'));
check('keeps a bare digit, which is a version', tokenize('python 3').includes('3'));

const identifier = tokenize('ERR_MODULE_NOT_FOUND');
check('an identifier survives whole', identifier.includes('err_module_not_found'));
check('and also comes apart', identifier.includes('module') && identifier.includes('found'));

const version = tokenize('upgrade to v1.2.3 today');
check('a version survives whole', version.includes('v1.2.3'), JSON.stringify(version));
check('and yields its patch number', version.includes('3'), JSON.stringify(version));

// The reason this file exists. Korean is agglutinative, so the document's
// `문서를` and the question's `문서` are different whitespace tokens and the
// same word. Bigrams are what make them meet.
const korean = tokenize('문서를');
check('Korean is cut into bigrams', korean.join() === '문서,서를', JSON.stringify(korean));
check('the question\'s bare stem is one of them', korean.includes('문서'));
check('a single CJK character stands alone', tokenize('산').join() === '산');
check('Japanese is cut the same way', tokenize('文書').join() === '文書');
check('CJK is detected', hasCJK('이것은 문서') && !hasCJK('plain ascii'));

// Mixed scripts are one string and have to yield both kinds of token.
const mixed = tokenize('ERR_404 오류가 발생했습니다');
check('a mixed line yields both alphabets',
  mixed.includes('err_404') && mixed.includes('오류'), JSON.stringify(mixed));

check('empty input is safe', tokenize('').length === 0 && tokenize(null).length === 0);
check('punctuation alone yields nothing', tokenize('!!! ... ---').length === 0);

// ---------------------------------------------------------------------- BM25
const CORPUS = [
  { id: 1, text: 'The cat sat on the mat in the kitchen' },
  { id: 2, text: 'The dog sat on the mat in the kitchen' },
  { id: 3, text: 'Error ERR_MODULE_NOT_FOUND is raised when a path is wrong' },
  { id: 4, text: 'Error ERR_MODULE_NOT_FOUND_V2 is a different error entirely' },
  { id: 5, text: '고양이에 관한 문서입니다' },
  { id: 6, text: '강아지에 관한 문서를 참고하세요' },
];
const index = buildLexicalIndex(CORPUS);

check('every entry is indexed', index.count === 6);
check('average length is positive', index.avgLength > 0);

const cat = lexicalSearch(index, 'cat');
check('finds the passage with the term', cat.length === 1 && cat[0].entry.id === 1,
  JSON.stringify(cat.map(h => h.entry.id)));

// The failure the whole hybrid path exists for: two near-identical identifiers
// that an embedding cannot reliably tell apart, and BM25 never confuses.
const exact = lexicalSearch(index, 'ERR_MODULE_NOT_FOUND_V2');
check('the exact identifier ranks first', exact[0].entry.id === 4,
  JSON.stringify(exact.map(h => h.entry.id)));
check('and its near-twin is still found, below it',
  exact.some(h => h.entry.id === 3) && exact[0].entry.id === 4);

const korean2 = lexicalSearch(index, '문서');
check('a Korean stem matches both inflections',
  korean2.length === 2 && korean2.every(h => h.entry.id === 5 || h.entry.id === 6),
  JSON.stringify(korean2.map(h => h.entry.id)));

const catDog = lexicalSearch(index, '고양이');
check('and the more specific Korean term picks one',
  catDog.length === 1 && catDog[0].entry.id === 5,
  JSON.stringify(catDog.map(h => h.entry.id)));

check('a query matching nothing returns nothing', lexicalSearch(index, 'helicopter').length === 0);
check('an empty query returns nothing', lexicalSearch(index, '   ').length === 0);
check('an empty index returns nothing', lexicalSearch(buildLexicalIndex([]), 'cat').length === 0);
check('the limit is respected', lexicalSearch(index, 'the kitchen mat', { limit: 1 }).length === 1);

// A term in almost every passage must not turn into a penalty. With the
// textbook idf, `error` -- in two of six -- is fine, but `is` in three of six
// goes negative and starts subtracting from real matches.
const common = lexicalSearch(index, 'error is');
check('a common term never scores below zero', common.every(h => h.score > 0),
  JSON.stringify(common.map(h => h.score)));

// Length normalisation: the same term in a shorter passage is worth more.
const short = buildLexicalIndex([
  { id: 'short', text: 'kitchen' },
  { id: 'long', text: `kitchen ${'filler '.repeat(60)}` },
]);
check('a shorter passage wins on the same term',
  lexicalSearch(short, 'kitchen')[0].entry.id === 'short');

// --------------------------------------------------------------------- fusion
//
// The property being bought: `x` tops the first list and is last in the
// second, `b` is second and first. Consistency beats one list's confidence,
// which is what stops a single retriever having a strong opinion from
// deciding the result on its own.
const fused = fuseRRF([['x', 'b', 'c', 'd', 'e'], ['b', 'c', 'd', 'e', 'x']]);
check('agreement wins over either list\'s first place', fused[0].entry === 'b',
  JSON.stringify(fused.map(f => f.entry)));
check('everything from both lists survives', fused.length === 5);
check('a hit records where it placed in each list',
  fused[0].ranks[0] === 2 && fused[0].ranks[1] === 1,
  JSON.stringify(fused[0].ranks));

const oneSided = fuseRRF([['a'], []]);
check('an empty list is not a problem', oneSided.length === 1 && oneSided[0].entry === 'a');
check('no lists at all is not a problem', fuseRRF([]).length === 0);

// The scale-free property, stated as a test: fusion must not change when one
// retriever's numbers do, because it never reads them.
const weighted = fuseRRF([['a', 'b'], ['b', 'a']], { weights: [3, 1] });
check('a weight can tip a tie', weighted[0].entry === 'a',
  JSON.stringify(weighted.map(f => f.entry)));

const objects = [{ id: 1 }, { id: 2 }];
const byKey = fuseRRF([[objects[0], objects[1]], [{ id: 2 }, { id: 1 }]], { keyOf: (o) => o.id });
check('keyOf merges equal entries from different lists', byKey.length === 2);

// --------------------------------------------------------------------- rerank
const HITS = [
  { text: 'nothing to do with the question' },
  { text: 'the answer is 42' },
  { text: 'the question is about the answer' },
];

const judge = (scores) => async () => ({
  ok: true,
  json: async () => ({ message: { content: JSON.stringify({ scores }) } }),
});

const reordered = await rerankHits('what is the answer', HITS, {
  model: 'test', fetchImpl: judge([{ id: 0, score: 0 }, { id: 1, score: 3 }, { id: 2, score: 1 }]),
});
check('the best-scoring passage leads', reordered[0].text === 'the answer is 42',
  JSON.stringify(reordered.map(h => h.text)));
check('a passage scored 0 is dropped', reordered.length === 2);
check('the score is carried back', reordered[0].rerank === 3);

const clamped = await rerankHits('q', HITS, {
  model: 'test', fetchImpl: judge([{ id: 0, score: 99 }, { id: 1, score: -5 }, { id: 2, score: 2 }]),
});
check('an out-of-range score is clamped, not trusted', clamped[0].rerank === 3);
check('a negative score is clamped to zero and dropped',
  !clamped.some(h => h.text === 'the answer is 42'), JSON.stringify(clamped.map(h => h.text)));

const ignored = await rerankHits('q', HITS, {
  model: 'test', fetchImpl: judge([{ id: 99, score: 3 }, { id: -1, score: 3 }]),
});
check('ids that were never offered are ignored', ignored.length === 3);

const silent = await rerankHits('q', HITS, {
  model: 'test', fetchImpl: judge([{ id: 1, score: 3 }]),
});
check('a passage the model did not mention keeps its place', silent.length === 3);
check('but the one it praised still moves to the front', silent[0].text === 'the answer is 42');

const allZero = await rerankHits('q', HITS, {
  model: 'test', fetchImpl: judge([{ id: 0, score: 0 }, { id: 1, score: 0 }, { id: 2, score: 0 }]),
});
check('a verdict of nothing-is-relevant is a failed judgement, not an empty result',
  allZero.length === 3);

// A transport-level failure is thrown rather than swallowed, because only the
// caller knows whether it is worth a line in the log. `safeRerank` in rag.js is
// that caller and turns it back into the ranking that went in -- which is what
// `scripts/rag.test.mjs` checks from the other side.
let garbage = null;
try {
  await rerankHits('q', HITS, {
    model: 'test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) }),
  });
} catch (e) { garbage = e; }
check('invalid JSON is reported, not guessed at', /valid JSON/.test(garbage?.message || ''));

let refused = null;
try {
  await rerankHits('q', HITS, { model: 'test', fetchImpl: async () => ({ ok: false, status: 503 }) });
} catch (e) { refused = e; }
check('a refused request is reported', /503/.test(refused?.message || ''));

check('no model means no pass', (await rerankHits('q', HITS, {})) === HITS);
check('one hit is not worth a round trip', (await rerankHits('q', [HITS[0]], { model: 'x' })).length === 1);

const topped = await rerankHits('q', HITS, {
  model: 'test', topK: 1,
  fetchImpl: judge([{ id: 0, score: 1 }, { id: 1, score: 3 }, { id: 2, score: 2 }]),
});
check('topK trims the result', topped.length === 1 && topped[0].text === 'the answer is 42');

let threw = null;
try {
  await rerankHits('q', HITS, {
    model: 'test',
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
} catch (e) { threw = e; }
check('an abort is not swallowed here', threw?.name === 'AbortError');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
