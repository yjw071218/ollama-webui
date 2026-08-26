// End-to-end retrieval against the real embedding model: index a small corpus,
// then check that each question pulls back the passage that actually answers it.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.rag-test-bundle.mjs');
const MODEL = process.argv[2] || 'nomic-embed-text';

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/rag.js'),
  external: ['localforage', 'fflate', 'pdfjs-dist'],
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { chunkPages, embedTexts, normalise, retrieve, formatContext } =
  await import(pathToFileURL(OUT).href);

// rag.js calls the relative /api/embed the dev server proxies; point it at Ollama.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  realFetch(typeof url === 'string' && url.startsWith('/') ? `http://localhost:11434${url}` : url, init);

const CORPUS = [
  {
    name: 'ollama-notes.md',
    pages: [{ page: 1, text: [
      'Keeping a model resident.',
      'The keep_alive parameter controls how long Ollama holds a model in VRAM after a request. Send it as a number: -1 keeps the model loaded until Ollama restarts, and 0 evicts it immediately. A duration string such as "30m" sets an explicit window.',
      '',
      'Choosing a quantisation.',
      'Q4_K_M is the usual default because it halves memory against Q8_0 while losing very little quality. Prefer Q8_0 only when the model is small enough that VRAM is not the constraint.',
    ].join('\n\n') }],
  },
  {
    name: 'gardening.txt',
    pages: [{ page: 1, text: [
      'Watering tomatoes.',
      'Tomato plants prefer a deep soak two or three times a week rather than a light daily sprinkle, which encourages shallow roots and leaves the plant vulnerable in hot weather.',
      '',
      'Pruning basil.',
      'Pinch basil above a leaf pair to force branching. Removing flower spikes early keeps the leaves sweet for far longer into the season.',
    ].join('\n\n') }],
  },
];

console.log(`Indexing with ${MODEL}...`);
const docs = [];
for (const source of CORPUS) {
  const chunks = chunkPages(source.pages, { size: 400, overlap: 60 });
  const vectors = await embedTexts(chunks.map(c => c.text), MODEL);
  docs.push({
    id: source.name,
    name: source.name,
    enabled: true,
    chunks: chunks.map((c, i) => ({ ...c, vector: normalise(vectors[i]) })),
  });
  console.log(`  ${source.name}: ${chunks.length} passages`);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const ask = (q) => retrieve(q, docs, { model: MODEL, topK: 3, minScore: 0.3 });

const keepAlive = await ask('How do I stop Ollama unloading my model between requests?');
check('finds the keep_alive passage',
  keepAlive.length > 0 && /keep_alive/i.test(keepAlive[0].text),
  keepAlive[0]?.text.slice(0, 60));
check('attributes it to the right document', keepAlive[0]?.docName === 'ollama-notes.md');

const quant = await ask('Which quantisation should I pick to save memory?');
check('finds the quantisation passage',
  quant.length > 0 && /Q4_K_M|quantisation/i.test(quant[0].text),
  quant[0]?.text.slice(0, 60));

const tomatoes = await ask('how often should I water my tomato plants');
check('finds the watering passage',
  tomatoes.length > 0 && /tomato/i.test(tomatoes[0].text),
  tomatoes[0]?.text.slice(0, 60));
check('does not cross documents', tomatoes[0]?.docName === 'gardening.txt');

// The floor is what stops an unrelated question dragging in random passages.
const unrelated = await retrieve(
  'What is the capital city of Peru and when was it founded?',
  docs,
  { model: MODEL, topK: 3, minScore: 0.6 },
);
check('an unrelated question retrieves nothing at a strict floor',
  unrelated.length === 0,
  unrelated.map(h => `${h.docName}:${h.score.toFixed(2)}`).join(', '));

const disabled = await retrieve('keep_alive', docs.map(d => ({ ...d, enabled: false })), { model: MODEL });
check('disabling every document returns nothing', disabled.length === 0);

const context = formatContext(keepAlive);
check('context carries a citation marker', context.startsWith('[1] '));
check('context names the source file', context.includes('ollama-notes.md'));

console.log('\n--- what the model would receive ---');
console.log(context.slice(0, 320));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
