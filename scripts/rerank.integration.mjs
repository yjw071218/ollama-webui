// Hybrid retrieval and the second pass, against the real models.
//
// The offline tests (scripts/rag.test.mjs, scripts/lexical.test.mjs) prove the
// arithmetic and the failure handling with the embedder and the judge stubbed.
// What they cannot show is the thing the feature was built for: that a real
// embedding model misses an exact string, that BM25 finds it anyway, and that
// a real small model can tell a passage that answers a question from one that
// merely mentions its subject.
//
//   node scripts/rerank.integration.mjs [chat-model] [embed-model]
//
// The corpus is written so that every paragraph becomes its own passage. That
// is not tidiness: with a chunk size that swallows three paragraphs whole, a
// question about the 4080 is "answered" by a chunk that also contains the
// 4090, and every assertion below would pass without testing anything.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.rerank-live-bundle.mjs');
const CHAT = process.argv[2] || 'qwen3.6:35b-a3b';
const EMBED = process.argv[3] || 'nomic-embed-text';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/rag.js'),
  external: ['localforage', 'fflate', 'pdfjs-dist'],
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { embedTexts, normalise, retrieve } = await import(pathToFileURL(OUT).href);

// Both modules call the relative paths the dev server proxies.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) =>
  realFetch(typeof url === 'string' && url.startsWith('/') ? `${OLLAMA}${url}` : url, init);

try {
  const probe = await realFetch(`${OLLAMA}/api/tags`);
  if (!probe.ok) throw new Error(String(probe.status));
} catch (e) {
  console.log(`SKIP  no Ollama at ${OLLAMA}; live retrieval cannot be tested`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

/* One passage per fact, written out rather than chunked, so that what is being
   measured is retrieval and not the chunker. The identifiers are the point:
   two near-identical strings in prose that is otherwise about the same thing
   is precisely where a summary of meaning cannot tell them apart. */
const PASSAGES = [
  ['errors.md', 'ERR_MODULE_NOT_FOUND is raised when a relative import names a file that is not present on disk. Check the extension: an ESM import must write the .js out in full.'],
  ['errors.md', 'ERR_MODULE_NOT_FOUND_V2 is raised only by the experimental loader, and means a loader hook returned a specifier the resolver could not use. It never indicates a missing file.'],
  ['errors.md', 'ERR_UNSUPPORTED_DIR_IMPORT is raised when an import points at a directory rather than at a file. Name the index file explicitly to fix it.'],
  ['cards.md', 'The RTX 4090 is built on AD102 and draws up to 450 watts under a sustained load.'],
  ['cards.md', 'The RTX 4080 ships with 16 GB of memory on a 256-bit bus.'],
  ['cards.md', 'Memory bandwidth matters more than core count when running a language model, because generation is bound by reading the weights once per token.'],
  ['garden.md', 'Tomato plants prefer a deep soak two or three times a week rather than a light daily sprinkle, which encourages shallow roots.'],
  ['garden.md', 'Pinch basil above a leaf pair to force branching, and remove flower spikes early to keep the leaves sweet.'],
];

const vectors = await embedTexts(PASSAGES.map(([, text]) => text), EMBED);
const docs = [];
PASSAGES.forEach(([name, text], i) => {
  let doc = docs.find(d => d.id === name);
  if (!doc) { doc = { id: name, name, enabled: true, chunks: [] }; docs.push(doc); }
  doc.chunks.push({ page: 1, text, vector: normalise(vectors[i]) });
});
console.log(`indexed ${docs.length} documents, ${PASSAGES.length} passages, with ${EMBED}`);
console.log(`judge: ${CHAT}\n`);

const brief = (hits) => hits.map(h => h.text.slice(0, 46).replace(/\s+/g, ' ') + '…');
const rankOf = (hits, needle) => hits.findIndex(h => h.text.includes(needle));
const show = (label, hits) => {
  console.log(`  ${label}`);
  hits.forEach((h, i) => console.log(
    `    [${i}] ${h.score.toFixed(3)}${h.rerank !== undefined ? ` r=${h.rerank}` : ''}`
    + ` ${(h.found || ['dense']).join('+').padEnd(13)} ${brief([h])[0]}`,
  ));
};

// ================================================== the exact-string failure
const QUERY = 'What causes ERR_MODULE_NOT_FOUND_V2?';
console.log(`Q: ${QUERY}`);

const dense = await retrieve(QUERY, docs, { model: EMBED, topK: 3, minScore: 0.3, hybrid: false });
const hybrid = await retrieve(QUERY, docs, { model: EMBED, topK: 3, minScore: 0.3 });
show('dense only', dense);
show('hybrid', hybrid);

const denseRank = rankOf(dense, '_V2');
const hybridRank = rankOf(hybrid, '_V2');

check('hybrid retrieval returns the passage naming the exact identifier', hybridRank >= 0,
  JSON.stringify(brief(hybrid)));
check('and ranks it no worse than the embedder alone did',
  denseRank < 0 || hybridRank <= denseRank, `dense ${denseRank}, hybrid ${hybridRank}`);
check('the lexical half contributed to this question',
  hybrid.some(h => h.found.includes('lexical')), JSON.stringify(hybrid.map(h => h.found)));
check('no passage is returned twice',
  new Set(hybrid.map(h => h.text)).size === hybrid.length, JSON.stringify(brief(hybrid)));

console.log(denseRank === 0
  ? '  note: the embedder ranked it first unaided this time\n'
  : `  note: the embedder alone put the right passage at ${denseRank < 0 ? 'nowhere' : denseRank}\n`);

// The same library, a second time. This is the shape that hid a real bug: the
// lexical index is cached, and caching it apart from the candidates it indexes
// made every agreed passage come back twice from the second question onward.
const again = await retrieve(QUERY, docs, { model: EMBED, topK: 3, minScore: 0.3 });
check('a second question against the same library is not duplicated',
  new Set(again.map(h => h.text)).size === again.length, JSON.stringify(brief(again)));
check('and returns the same passages as the first',
  JSON.stringify(brief(again)) === JSON.stringify(brief(hybrid)));

// ============================================================ the second pass
const CARD = 'How much memory does the RTX 4080 have?';
console.log(`\nQ: ${CARD}`);

const plain = await retrieve(CARD, docs, { model: EMBED, topK: 4, minScore: 0.3 });
const judged = await retrieve(CARD, docs, {
  model: EMBED, topK: 4, minScore: 0.3, rerank: true, rerankModel: CHAT,
});
show('retrieved', plain);
show('reranked', judged);

check('the reranked list leads with the passage that holds the answer',
  judged[0]?.text.includes('4080'), brief(judged)[0]);
check('the passage that answers it is scored top marks',
  judged.find(h => h.text.includes('4080'))?.rerank === 3,
  JSON.stringify(judged.map(h => h.rerank)));
check('reranking removed passages that answer nothing',
  judged.length < plain.length, `${plain.length} in, ${judged.length} out`);
check('the gardening did not survive the judge',
  !judged.some(h => /Tomato|basil/.test(h.text)), JSON.stringify(brief(judged)));

// ============================== the verdict a similarity floor cannot reach
const ABSENT = 'What is the warranty period on a Samsung dishwasher?';
console.log(`\nQ: ${ABSENT}   (nothing in the library answers this)`);

const floorOnly = await retrieve(ABSENT, docs, { model: EMBED, topK: 4, minScore: 0.3 });
const rejected = await retrieve(ABSENT, docs, {
  model: EMBED, topK: 4, minScore: 0.3, rerank: true, rerankModel: CHAT,
});
show('retrieved', floorOnly);
show('reranked', rejected);

/* The floor cannot produce "nothing here answers this": it only knows how near
   the nearest thing was. The judge can, and this is the case it exists for --
   so this is asserted rather than merely reported. Anything it keeps must at
   least not be scored as containing the answer. */
check('an unanswerable question keeps fewer passages than the floor did',
  rejected.length < floorOnly.length, `${floorOnly.length} -> ${rejected.length}`);
check('and nothing is marked as containing the answer',
  !rejected.some(h => h.rerank === 3), JSON.stringify(rejected.map(h => h.rerank)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
