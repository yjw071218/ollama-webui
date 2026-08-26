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
const v = normalise([3, 4]);
check('normalise gives unit length', Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-9);
check('normalise keeps direction', Math.abs(v[0] - 0.6) < 1e-9 && Math.abs(v[1] - 0.8) < 1e-9);
check('a zero vector does not divide by zero', normalise([0, 0]).every(n => n === 0));

check('dot of identical unit vectors is 1', Math.abs(dot(normalise([1, 1]), normalise([1, 1])) - 1) < 1e-9);
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

const none = await retrieve('cats', DOCS, { topK: 5, minScore: 1.5 });
check('an impossible floor returns nothing', none.length === 0);

check('an empty query retrieves nothing', (await retrieve('   ', DOCS)).length === 0);
check('an empty library retrieves nothing', (await retrieve('cats', [])).length === 0);

const formatted = formatContext(hits);
check('context is numbered', formatted.startsWith('[1] '));
check('context names the source', formatted.includes('guide.pdf'));
check('context carries the passage', formatted.includes('about cats'));

// ------------------------------------------------------------- file matching
check('accepts a pdf', isSupportedDocument({ name: 'Report.PDF' }));
check('accepts a docx', isSupportedDocument({ name: 'notes.docx' }));
check('accepts plain text', isSupportedDocument({ name: 'readme.md' }));
check('rejects an image', !isSupportedDocument({ name: 'photo.png' }));
check('rejects an executable', !isSupportedDocument({ name: 'setup.exe' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
