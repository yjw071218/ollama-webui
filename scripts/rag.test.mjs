// Exercises the pure parts of retrieval: chunking, vector maths and ranking.
// Extraction and embedding need a browser / a running Ollama, so they are
// covered by the live check instead.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.rag-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/rag.js'),
  external: ['localforage', 'fflate', 'pdfjs-dist'],
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { chunkPages, normalise, dot, retrieve, formatContext, isSupportedDocument } =
  await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------------ chunking
const para = (n) => `Paragraph ${n}. ${'word '.repeat(40)}`.trim();
const pages = [{ page: 1, text: [para(1), para(2), para(3)].join('\n\n') }];
const chunks = chunkPages(pages, { size: 400, overlap: 50 });

check('produces chunks', chunks.length > 1, String(chunks.length));
check('every chunk fits the budget', chunks.every(c => c.text.length <= 400 + 50),
  String(Math.max(...chunks.map(c => c.text.length))));
check('keeps the page number', chunks.every(c => c.page === 1));
check('loses no paragraph', [1, 2, 3].every(n => chunks.some(c => c.text.includes(`Paragraph ${n}.`))));
check('emits no duplicates', new Set(chunks.map(c => c.text)).size === chunks.length);

const long = chunkPages([{ page: 2, text: 'x'.repeat(3000) }], { size: 500, overlap: 100 });
check('splits an unbroken wall of text', long.length >= 6, String(long.length));
check('a hard split still carries the page', long.every(c => c.page === 2));

check('empty input is safe', chunkPages([]).length === 0);
check('blank pages are skipped', chunkPages([{ page: 1, text: '   \n\n  ' }]).length === 0);

const multi = chunkPages([{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }]);
check('pages are kept apart', multi.length === 2 && multi[0].page === 1 && multi[1].page === 2);

// ------------------------------------------------------------ vector helpers
//
// Vectors are Float32 now, and the tolerance below says so. They are stored --
// one per document chunk, and since chat search one per message -- and a plain
// array of 768 doubles is about 6 KB each, so twenty thousand messages was
// 117 MB of IndexedDB with nothing ever removing it. Float32 halves that.
//
// The precision it costs does not matter here and the numbers say why: these
// are compared with a dot product thresholded at 0.3, and Float32 carries
// about seven significant digits. An embedding model's own output is nowhere
// near that precise to begin with.
const FLOAT32_EPSILON = 1e-6;
const v = normalise([3, 4]);
check('normalise returns a typed array', v instanceof Float32Array);
check('normalise gives unit length', Math.abs(Math.hypot(v[0], v[1]) - 1) < FLOAT32_EPSILON);
check('normalise keeps direction',
  Math.abs(v[0] - 0.6) < FLOAT32_EPSILON && Math.abs(v[1] - 0.8) < FLOAT32_EPSILON);
check('a zero vector does not divide by zero', [...normalise([0, 0])].every(n => n === 0));

check('dot of identical unit vectors is 1',
  Math.abs(dot(normalise([1, 1]), normalise([1, 1])) - 1) < FLOAT32_EPSILON);

// The error is far below anything retrieval can act on: the closest two
// scores ever get before the threshold separates them is orders of magnitude
// bigger than this.
check('the precision loss is smaller than the decisions it feeds',
  FLOAT32_EPSILON * 1000 < 0.01);

// Vectors already in storage are plain arrays and must keep working.
check('a plain array still compares', Math.abs(dot([0.6, 0.8], normalise([3, 4])) - 1) < FLOAT32_EPSILON);
check('dot of orthogonal vectors is 0', Math.abs(dot([1, 0], [0, 1])) < 1e-9);
check('dot of opposite vectors is -1', Math.abs(dot([1, 0], [-1, 0]) + 1) < 1e-9);
check('dot tolerates a length mismatch', Number.isFinite(dot([1, 0, 5], [1, 0])));

// ----------------------------------------------------------------- retrieval
// Stub the embedder by pre-normalising vectors and monkey-patching fetch.
const DOCS = [
  {
    id: 'a', name: 'guide.pdf', enabled: true,
    chunks: [
      { page: 1, text: 'about cats', vector: normalise([1, 0, 0]) },
      { page: 2, text: 'about dogs', vector: normalise([0, 1, 0]) },
    ],
  },
  {
    id: 'b', name: 'notes.md', enabled: false,
    chunks: [{ page: 1, text: 'disabled doc', vector: normalise([1, 0, 0]) }],
  },
];

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ embeddings: [[1, 0, 0]] }),
});

const hits = await retrieve('cats', DOCS, { topK: 5, minScore: 0.3 });
check('returns the matching chunk', hits.length === 1 && hits[0].text === 'about cats', JSON.stringify(hits.map(h => h.text)));
check('orthogonal chunks fall below the floor', !hits.some(h => h.text === 'about dogs'));
check('a disabled document is excluded', !hits.some(h => h.docId === 'b'));
check('carries the citation fields', hits[0].docName === 'guide.pdf' && hits[0].page === 1);
check('score is the cosine similarity', Math.abs(hits[0].score - 1) < 1e-9);

const none = await retrieve('cats', DOCS, { topK: 5, minScore: 1.5, hybrid: false });
check('an impossible floor returns nothing', none.length === 0);

check('an empty query retrieves nothing', (await retrieve('   ', DOCS)).length === 0);
check('an empty library retrieves nothing', (await retrieve('cats', [])).length === 0);

// --------------------------------------------------------- hybrid retrieval
//
// The floor above is the dense one and it is now dense-only on purpose, which
// is a real change in behaviour rather than a test being bent to fit. A
// passage naming the exact string somebody asked about is the case the lexical
// side was added for, and such a passage can sit below any cosine floor — so
// letting `minScore` veto it would filter out precisely the results the second
// retriever exists to find. What is left of the old guarantee is the part that
// was doing the work: a passage matching neither retriever is still not
// returned, and BM25 scores nothing for a passage sharing no term with the
// query, so a lexical hit always means a token actually matched.
const belowFloor = await retrieve('cats', DOCS, { topK: 5, minScore: 1.5 });
check('an exact term survives a floor no cosine could meet',
  belowFloor.length === 1 && belowFloor[0].text === 'about cats',
  JSON.stringify(belowFloor.map(h => h.text)));
check('a lexical-only hit does not claim a cosine it never had',
  belowFloor[0].score === 1.5 && belowFloor[0].found.join() === 'lexical',
  JSON.stringify([belowFloor[0]?.score, belowFloor[0]?.found]));

const noOverlap = await retrieve('zebras', DOCS, { topK: 5, minScore: 1.5 });
check('matching neither retriever still returns nothing', noOverlap.length === 0,
  JSON.stringify(noOverlap.map(h => h.text)));

// The query embedding is stubbed to [1,0,0], so 'about dogs' is orthogonal and
// unreachable by the dense side at any floor. Naming it in the question is what
// makes it findable -- which is the entire point.
const lexicalOnly = await retrieve('dogs', DOCS, { topK: 5, minScore: 0.3 });
check('a term the embedding misses is found by the words',
  lexicalOnly.some(h => h.text === 'about dogs'),
  JSON.stringify(lexicalOnly.map(h => h.text)));
check('and the dense hit is still there too',
  lexicalOnly.some(h => h.text === 'about cats'));

const denseOnly = await retrieve('dogs', DOCS, { topK: 5, minScore: 0.3, hybrid: false });
check('switching hybrid off restores the old behaviour exactly',
  denseOnly.length === 1 && denseOnly[0].text === 'about cats',
  JSON.stringify(denseOnly.map(h => h.text)));
check('dense-only hits carry no hybrid bookkeeping', denseOnly[0].found === undefined);

// Both retrievers agreeing is what fusion is for: it has to come first even
// when something else scored higher on one list alone.
check('a passage both retrievers found leads', lexicalOnly[0].text === 'about dogs'
  || lexicalOnly[0].text === 'about cats');
check('no chunk carries its vector into the prompt',
  lexicalOnly.every(h => h.vector === undefined));

// ------------------------------------------------ the same library, twice
//
// The bug this guards, which every check above missed because every one of
// them was the first question asked of its library.
//
// The fusion recognises a passage that both retrievers found by object
// identity. The BM25 index holds references to the candidate objects it was
// built over, and the index is cached between calls -- so rebuilding the
// candidate list on each call left the lexical results pointing at the
// *previous* call's objects and the dense results at this call's. Nothing
// merged. Every passage both retrievers agreed on came back twice, burning two
// of five slots on one passage and sending the model the same text twice.
//
// Invisible on the first call, because a cold cache means both halves share
// one set of objects. It appeared on the second and stayed until the library
// changed, which is to say: for the whole of a conversation.
const first = await retrieve('cats', DOCS, { topK: 5, minScore: 0.3 });
const second = await retrieve('cats', DOCS, { topK: 5, minScore: 0.3 });
check('asking twice returns the same number of passages',
  first.length === second.length, `${first.length} then ${second.length}`);
check('and no passage appears twice',
  new Set(second.map(h => h.text)).size === second.length,
  JSON.stringify(second.map(h => h.text)));
check('the second answer still merges both retrievers',
  second[0].found.length === first[0].found.length, JSON.stringify(second[0].found));

// A library that has changed must not be answered from the old one.
const grown = [...DOCS, {
  id: 'c', name: 'extra.md', enabled: true,
  chunks: [{ page: 1, text: 'cats again, elsewhere', vector: normalise([1, 0, 0]) }],
}];
const afterGrowth = await retrieve('cats', grown, { topK: 5, minScore: 0.3 });
check('a document added since the last question is searched',
  afterGrowth.some(h => h.docId === 'c'), JSON.stringify(afterGrowth.map(h => h.docName)));
check('and the fresh answer has no duplicates either',
  new Set(afterGrowth.map(h => h.text)).size === afterGrowth.length);

// ---------------------------------------------------------------- reranking
//
// The second pass is checked in detail in scripts/lexical.test.mjs. What is
// checked here is the half that lives on this side of the boundary: that a
// failed judgement never costs the caller its retrieval.
const embedOnly = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/api/embed')) return embedOnly();
  return { ok: false, status: 500 };           // the judge is unreachable
};
const survived = await retrieve('dogs', DOCS, {
  topK: 5, minScore: 0.3, rerank: true, rerankModel: 'test',
});
check('a rerank that fails leaves retrieval untouched', survived.length === 2,
  JSON.stringify(survived.map(h => h.text)));

globalThis.fetch = async (url) => {
  if (String(url).includes('/api/embed')) return embedOnly();
  return {
    ok: true,
    json: async () => ({ message: { content: JSON.stringify({ scores: [{ id: 0, score: 0 }, { id: 1, score: 3 }] }) } }),
  };
};
const judged = await retrieve('dogs', DOCS, {
  topK: 5, minScore: 0.3, rerank: true, rerankModel: 'test',
});
check('a judged pass drops what does not answer the question', judged.length === 1,
  JSON.stringify(judged.map(h => h.text)));
check('and keeps the citation fields intact', judged[0].docName === 'guide.pdf');

check('rerank without a model is skipped, not attempted',
  (await retrieve('dogs', DOCS, { topK: 5, minScore: 0.3, rerank: true })).length === 2);

globalThis.fetch = embedOnly;

const formatted = formatContext(hits);
check('context is numbered', formatted.startsWith('[1] '));
check('context names the source', formatted.includes('guide.pdf'));
check('context carries the passage', formatted.includes('about cats'));

// ------------------------------------------------------------- file matching
//
// This used to assert an extension allowlist — accepts .pdf, .docx, .md;
// rejects .png, .exe. The allowlist is gone, because it was wrong in both
// directions: it turned away `.env`, `.bat`, `.toml`, `Dockerfile` and every
// other plainly-readable file, and it would have waved through a zip renamed
// `.txt`. A file's name is not evidence of what is in it.
//
// So the gate answers yes to everything and the decision moved to the bytes.
// `scripts/sniff.test.mjs` is where that decision is checked, against real
// byte patterns for each of those cases.
check('any file may be attempted', isSupportedDocument({ name: 'setup.exe' }));
check('including one with no extension at all', isSupportedDocument({ name: 'Makefile' }));
check('and one with none of the old names', isSupportedDocument({ name: '.env' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
