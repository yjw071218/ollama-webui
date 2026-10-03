import localforage from 'localforage';
import { unzipSync, strFromU8 } from 'fflate';
import { safeTail, safeSlice } from './textCut.js';
import { buildLexicalIndex, lexicalSearch, fuseRRF } from './lexical.js';
import { rerankHits } from './rerank.js';

/**
 * Retrieval over documents the user attaches.
 *
 * Everything runs locally: text is extracted in the browser, embedded through
 * Ollama's /api/embed, and the vectors live in IndexedDB. Nothing leaves the
 * machine, and there is no vector database to run.
 *
 * Three stages, and each one is switchable because each costs something
 * different:
 *
 *  1. **Dense**, always. The question and every chunk as vectors, ranked by
 *     cosine. Good at "asked in different words from the document", bad at
 *     exact strings.
 *  2. **Lexical**, by default. BM25 over the same chunks, fused with the dense
 *     ranking by reciprocal rank. Good at exactly what stage 1 is bad at, and
 *     it costs no round trip at all — see `src/lexical.js` for why this
 *     matters far more in Korean than the English case suggests.
 *  3. **Rerank**, off by default. The model reads the shortlist and says which
 *     passages actually answer the question, dropping the ones that do not.
 *     One round trip before the answer starts, which is why it is a choice —
 *     see `src/rerank.js`.
 */

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'knowledge' });

/* Qwen3-Embedding 0.6B: multilingual, and far stronger on Korean than
 * nomic-embed-text, which was trained on English and ranked Korean passages
 * little better than chance. Small enough to sit beside a chat model. */
export const DEFAULT_EMBED_MODEL = 'qwen3-embedding:0.6b';
/* What documents embedded before a model was recorded on them were made with. */
export const LEGACY_EMBED_MODEL = 'nomic-embed-text';

/** True for a model that only makes vectors and cannot be chatted with. */
export const isEmbeddingModel = (m) => {
  const name = String(m?.name || m?.model || m || '').toLowerCase();
  const family = String(m?.details?.family || '').toLowerCase();
  return /embed|(^|[/:-])bge|(^|[/:-])gte|minilm|(^|[/:-])e5[-:]|nomic-bert|bert$/.test(name)
    || /bert|embed/.test(family);
};

/* =========================================================================
   Text extraction
   ========================================================================= */

/** pdf.js needs its worker; bundle it rather than reaching for a CDN. */
const loadPdfjs = async () => {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.toString();
  return pdfjs;
};

/* Everything `getDocument` needs to turn glyphs back into characters.
 *
 * A CID-keyed font -- which is how every CJK document embeds its text --
 * stores glyph ids, and mapping those to Unicode needs the character map for
 * the font's collection. Without `cMapUrl` pdf.js has no way to load one, so
 * `getTextContent()` hands back items whose `str` is empty and the document
 * looks like it contains no text at all. A Korean tuition invoice does that
 * exactly: its fonts are Adobe-Korea1, and the answer to "why is this PDF
 * blank" is a file called `Adobe-Korea1-UCS2.bcmap` that was never fetched.
 *
 * The files are copied into public/ by scripts/pdf-assets.mjs, which the dev
 * and build scripts run first. They are URLs rather than imports because
 * pdf.js picks one of 169 by name at run time. */
const PDF_ASSETS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
};

export const extractPdf = async (arrayBuffer, onProgress) => {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer, ...PDF_ASSETS }).promise;
  const pages = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();

    // pdf.js hands back positioned runs, not lines. Insert a break when the
    // vertical position jumps, otherwise the whole page becomes one line.
    let text = '';
    let lastY = null;
    for (const item of content.items) {
      if (!item.str) continue;
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
      text += item.str;
      if (y !== undefined) lastY = y;
    }

    pages.push({ page: n, text: text.replace(/[ \t]+/g, ' ').trim() });
    onProgress?.(n, doc.numPages);
  }

  return pages;
};

/** DOCX is a zip; the body lives in word/document.xml. */
export const extractDocx = async (arrayBuffer) => {
  const files = unzipSync(new Uint8Array(arrayBuffer));
  const entry = files['word/document.xml'];
  if (!entry) throw new Error('Not a Word document (word/document.xml is missing)');

  const xml = strFromU8(entry);
  const text = xml
    .replace(/<w:p[ >][\s\S]*?(?=<w:p[ >]|$)/g, (block) => `${block}\n`)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return [{ page: 1, text }];
};

export const extractPlainText = async (file) => {
  const text = await file.text();
  return [{ page: 1, text }];
};

/**
 * Draw a PDF's pages and hand them back as images.
 *
 * For the documents that genuinely have no text: a scan, a photographed form,
 * a page exported as one flat picture. Telling somebody their invoice cannot
 * be read is true and useless when the model in front of them can see — so the
 * pages become images and go through the same path as a photograph.
 *
 * `arrayBuffer` is consumed by `getDocument`, so this takes its own copy: a
 * caller that already tried extraction is holding a detached buffer otherwise.
 */
export const renderPdfPages = async (arrayBuffer, { maxPages = 4, scale = 2 } = {}) => {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer.slice(0), ...PDF_ASSETS }).promise;
  const out = [];

  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    // Scale 2 is about 150dpi for a letter page: enough for a vision model to
    // read printed figures, without producing an image so large that encoding
    // it costs more than the answer.
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');
    // A PDF page is transparent where nothing is drawn, and transparent
    // becomes black in a JPEG. Paper is white.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport, background: '#fff' }).promise;
    // JPEG rather than PNG: a scanned page is a photograph, and a PNG of one
    // is several times the size for no gain.
    out.push({ page: n, dataUrl: canvas.toDataURL('image/jpeg', 0.85) });
    // Let go of the bitmap before drawing the next page.
    canvas.width = 0;
    canvas.height = 0;
  }

  return { pages: out, total: doc.numPages };
};

/* =========================================================================
   What kind of file is this?

   By content, not by name. The list of extensions this used to keep was wrong
   in both directions and could only ever be wrong in both directions: it
   refused `.env`, `.bat`, `.ini`, `.toml`, `.rs`, `.go`, `.vue`, `.kt`, `.sql`,
   `Dockerfile` and `Makefile` -- every one of them plainly text -- while a zip
   renamed to `.txt` would have sailed through and been decoded as mojibake.

   There is no list of text formats to write, because "text" is not a format.
   It is a property of the bytes, and the bytes are right here.
   ========================================================================= */

/** Enough of a file to tell text from not-text; the rest cannot disagree. */
const SNIFF_BYTES = 8192;

/**
 * Does this look like something other than text?
 *
 * Two signals, both cheap and both decisive:
 *
 *  - A NUL byte. Text files do not contain them, and practically every binary
 *    format does within the first few kilobytes. This alone catches
 *    executables, images, archives, databases and compiled objects.
 *  - A pile of U+FFFD after a *strict* UTF-8 decode. That is the decoder
 *    saying "these bytes are not UTF-8". A little of it is a Latin-1 file or a
 *    stray byte and worth keeping; a lot of it is the flood of mojibake that
 *    made a PDF read as text cost a hundred thousand junk tokens.
 *
 * Deliberately not a magic-number table. A table is another allowlist, wrong
 * for the next format nobody thought of, and these two tests do not care what
 * the format is called.
 */
export const looksBinary = (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = view.subarray(0, SNIFF_BYTES);
  if (head.length === 0) return false;

  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return true;
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(head);
  } catch (e) {
    return true;
  }
  let bad = 0;
  for (const ch of decoded) if (ch === '�') bad++;
  // A UTF-16 file, or a Latin-1 one with accents, sits well under this; a
  // binary decoded as UTF-8 sits far above it.
  return bad / Math.max(1, decoded.length) > 0.1;
};

/** The first bytes of a PDF and of every zip-based format, docx included. */
const startsWith = (bytes, signature) =>
  signature.every((b, i) => bytes[i] === b);

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];          // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];          // PK\x03\x04

/**
 * Which reader a file needs: 'pdf', 'docx', 'text' or 'binary'.
 *
 * The signature decides where there is one, so a PDF saved without an
 * extension still reads as a PDF. The name is consulted only to tell a `.docx`
 * from every other zip, because they share a signature and a spreadsheet is
 * not something `extractDocx` can do anything with.
 */
export const sniffKind = (bytes, name = '') => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (startsWith(view, PDF_MAGIC)) return 'pdf';
  if (startsWith(view, ZIP_MAGIC)) {
    return /\.docx$/i.test(name) ? 'docx' : 'binary';
  }
  return looksBinary(view) ? 'binary' : 'text';
};

/**
 * Anything may be attempted.
 *
 * Kept as a function because two callers ask, and because "try it" is now the
 * honest answer to all of them: whether a file can be read is decided by
 * reading it, and the failure that matters arrives with a message that says
 * what actually went wrong.
 */
export const isSupportedDocument = () => true;

export const extractDocument = async (file, onProgress) => {
  const buffer = await file.arrayBuffer();
  const kind = sniffKind(new Uint8Array(buffer), file.name || '');

  if (kind === 'pdf') return extractPdf(buffer, onProgress);
  if (kind === 'docx') return extractDocx(buffer);
  if (kind === 'binary') {
    const err = new Error('binary');
    err.code = 'binary';
    throw err;
  }

  // Decoded from the bytes already in hand rather than by reading the file a
  // second time — and non-fatally, so one bad byte in an otherwise readable
  // config file costs that byte and not the file.
  return [{ page: 1, text: new TextDecoder('utf-8').decode(buffer) }];
};

/* =========================================================================
   Chunking
   ========================================================================= */

const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 200;

/**
 * Splits on paragraph boundaries, falling back to a hard cut for a wall of
 * text. Overlap keeps a sentence that straddles a boundary retrievable.
 */
export const chunkPages = (pages, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) => {
  const chunks = [];

  for (const { page, text } of pages) {
    if (!text || !text.trim()) continue;
    const paragraphs = text.split(/\n\s*\n/);

    let buffer = '';
    // The overlap tail is seeded back into the buffer after a flush. Without
    // this flag the trailing push would emit that tail again as its own chunk.
    let bufferHasNewText = false;

    const flush = () => {
      const trimmed = buffer.trim();
      if (trimmed) chunks.push({ page, text: trimmed });
      // Character boundaries, not code-unit ones: the overlap tail is fed back
      // into the next chunk and then into a prompt, so half an emoji here
      // becomes U+FFFD in the passages the model is shown. See src/textCut.js.
      buffer = trimmed.length > overlap ? safeTail(trimmed, overlap) : '';
      bufferHasNewText = false;
    };

    for (const paragraph of paragraphs) {
      const piece = paragraph.trim();
      if (!piece) continue;

      // A paragraph longer than the budget gets a hard split of its own.
      if (piece.length > size) {
        if (bufferHasNewText) flush();
        for (let i = 0; i < piece.length; i += size - overlap) {
          const slice = safeSlice(piece, i, i + size).trim();
          if (slice) chunks.push({ page, text: slice });
        }
        buffer = '';
        bufferHasNewText = false;
        continue;
      }

      if (buffer.length + piece.length + 2 > size) flush();
      buffer += (buffer ? '\n\n' : '') + piece;
      bufferHasNewText = true;
    }

    if (bufferHasNewText && buffer.trim()) chunks.push({ page, text: buffer.trim() });
  }

  return chunks;
};

/* =========================================================================
   Embeddings
   ========================================================================= */

/* How much context an embedding model is loaded with.
 *
 * Generously more than any chunk this app makes (see CHUNK_CHARS) and nothing
 * like a default. It has to be said out loud, because an Ollama request that
 * omits `num_ctx` does not get a modest default -- it gets
 * `OLLAMA_CONTEXT_LENGTH`, the server-wide one, and on the machine this was
 * found on that was set to 1,048,560 tokens.
 *
 * What that costs is not theoretical: a KV cache is bytes per token per layer,
 * so a million-token cache for a small embedding model is still tens of
 * gigabytes of commit. On a machine whose committed memory already exceeds its
 * RAM, an allocation like that is the whole system paging to disk -- which is
 * not an error anybody sees, it is the computer stopping for ten minutes.
 *
 * Every other call this app makes pins `num_ctx` for the same reason. This one
 * was the exception. */
export const EMBED_NUM_CTX = 8192;

export const embedTexts = async (texts, model = DEFAULT_EMBED_MODEL, signal) => {
  const res = await fetch('/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts, options: { num_ctx: EMBED_NUM_CTX } }),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Embedding failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await res.json();
  const vectors = data.embeddings || (data.embedding ? [data.embedding] : []);
  if (vectors.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, received ${vectors.length}`);
  }
  return vectors;
};

/** Vectors are stored normalised, so similarity is a plain dot product. */
/**
 * A unit vector, as `Float32Array`.
 *
 * The type is the point. These are stored — one per document chunk and, since
 * chat search, one per message — and a plain JS array of 768 numbers is 768
 * *doubles*: about 6 KB each, so twenty thousand messages is 117 MB of
 * IndexedDB quietly accumulating with nothing ever removing it.
 *
 * Float32 halves that, and the precision it costs is irrelevant here: these
 * are compared with a dot product whose result is thresholded at 0.3, and an
 * embedding model's own output is nowhere near seven significant figures of
 * meaningful. Everything that reads a vector iterates it by index, so a typed
 * array is a drop-in — including the ones already in storage as plain arrays,
 * which keep working untouched.
 */
export const normalise = (vector) => {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (!length) {
    for (let i = 0; i < vector.length; i++) out[i] = vector[i];
    return out;
  }
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / length;
  return out;
};

export const dot = (a, b) => {
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) total += a[i] * b[i];
  return total;
};

/* =========================================================================
   Store
   ========================================================================= */

const keyFor = (userId) => `knowledge:${userId || 'guest'}`;

export const loadLibrary = async (userId) => {
  const docs = await store.getItem(keyFor(userId));
  return Array.isArray(docs) ? docs : [];
};

export const saveLibrary = (userId, docs) => store.setItem(keyFor(userId), docs);

export const addDocument = async (userId, doc) => {
  const docs = await loadLibrary(userId);
  const next = [...docs.filter(d => d.id !== doc.id), doc];
  await saveLibrary(userId, next);
  return next;
};

export const removeDocument = async (userId, docId) => {
  const docs = await loadLibrary(userId);
  const next = docs.filter(d => d.id !== docId);
  await saveLibrary(userId, next);
  return next;
};

/* =========================================================================
   Retrieval
   ========================================================================= */

/**
 * Top-k chunks across the enabled documents.
 *
 * `minScore` keeps an unrelated question from dragging in random passages —
 * without it every message would carry whatever happened to be closest.
 */
/**
 * Which documents a given chat is allowed to see.
 *
 * Three kinds live in one library and they must not be searched as one:
 *
 *  - A document added in Settings is the *library*. It has no owner and every
 *    chat may use it, which is what somebody putting a manual there intends.
 *  - A document pinned to a folder belongs to that folder's chats. That is
 *    what makes a folder a project rather than a colour.
 *  - A document that arrived as an attachment belongs to the chat it was
 *    attached to, and to nothing else.
 *
 * The third is the one that needed saying. A long attachment is indexed rather
 * than truncated now, so attaching a tuition invoice on Monday used to mean
 * its paragraphs were still being retrieved into an unrelated question about
 * code on Friday — silently, because retrieval never says what it declined to
 * find. Every document was global because nothing recorded where it came from.
 */
export const visibleDocuments = (docs, { chatId = null, folderId = null } = {}) => (
  (docs || []).filter(doc => {
    if (!doc || doc.enabled === false) return false;
    // Belongs to one chat: only that chat.
    if (doc.chatId) return String(doc.chatId) === String(chatId);
    // Pinned to a folder: only chats in it.
    if (doc.folderId) return folderId != null && String(doc.folderId) === String(folderId);
    // Neither: it is the shared library.
    return true;
  })
);

/* The BM25 index, kept for as long as the thing it describes has not changed.
 *
 * Only the last one: retrieval runs against the same library over and over
 * within a conversation, and the case worth avoiding is rebuilding on every
 * message, not rebuilding after the user switches chat. Holding several would
 * mean holding every chunk of every scope in memory twice for the sake of a
 * few milliseconds. */
let searchCache = null;

/* What the cache was built from, cheaply enough to compute per message.
 *
 * Document ids and chunk counts, not the text. The text cannot change without
 * the chunk count changing *or* the document being re-added under a new id —
 * both of which this catches — and hashing a few megabytes of prose on every
 * turn to be sure about a case that does not arise is not a trade worth
 * making. */
const signatureOf = (docs) => docs.map(d => `${d.id}/${d.chunks.length}`).join(',');

/**
 * The passages to search, and the term statistics over them.
 *
 * **The candidates are cached with the index, and that is not an optimisation
 * — it is the correctness condition.** The fusion recognises a passage that
 * both retrievers found by object identity, which is the only thing that can
 * identify it: two chunks of one document can hold the same text, and a
 * position is not stable across a library that has changed.
 *
 * Caching the index alone was therefore a bug, and a quiet one. The index
 * holds references to the candidate objects it was built from; rebuilding the
 * candidate list on every call while reusing that index left the lexical
 * results pointing at *last call's* objects and the dense results at this
 * call's. Nothing merged, so every passage both retrievers agreed on came back
 * twice — burning two of five slots on one passage and sending the model the
 * same text twice. It is invisible on the first question asked of a library,
 * because the cache is cold and both halves then share one set of objects; it
 * appears on the second and stays until the library changes.
 *
 * One entry, not several: retrieval runs against the same library over and
 * over within a conversation, and the case worth avoiding is rebuilding on
 * every message rather than rebuilding after switching chat.
 */
const searchSetFor = (docs) => {
  const signature = signatureOf(docs);
  if (searchCache?.signature === signature) return searchCache;

  const candidates = [];
  for (const doc of docs) {
    for (const chunk of doc.chunks) {
      candidates.push({
        docId: doc.id,
        docName: doc.name,
        page: chunk.page,
        text: chunk.text,
        vector: chunk.vector,
        embedModel: doc.embedModel || LEGACY_EMBED_MODEL,
      });
    }
  }
  // Built on first use rather than here: a library searched with the lexical
  // half switched off should not pay for term statistics nothing reads.
  searchCache = { signature, candidates, index: null };
  return searchCache;
};

export const retrieve = async (query, docs, {
  model = DEFAULT_EMBED_MODEL,
  topK = 5,
  minScore = 0.35,
  chatId = null,
  folderId = null,
  /* Both default to the cheaper answer being on and the expensive one off.
     Lexical matching costs arithmetic over text already in memory; reranking
     costs a round trip to the model before the reply starts. */
  hybrid = true,
  rerank = false,
  rerankModel = null,
  signal,
} = {}) => {
  const active = visibleDocuments(docs, { chatId, folderId })
    .filter(d => Array.isArray(d.chunks) && d.chunks.length);
  if (active.length === 0 || !query.trim()) return [];

  /* One flat list of candidates, referred to by identity from here on. Both
     rankings hand back these same objects, which is what lets the fusion
     recognise a passage that both retrievers found -- see `searchSetFor` for
     why they are cached alongside the index rather than rebuilt here. */
  const searchSet = searchSetFor(active);
  const { candidates } = searchSet;

  /* The query is embedded once per model the library was built with: a
     document indexed by the previous embedder keeps working (vectors of two
     models are not comparable, so each is scored against its own). A model
     that is gone only loses its dense half; the lexical half still finds it. */
  const queryVectors = new Map();
  for (const name of new Set(candidates.map(c => c.embedModel || model))) {
    try {
      // Qwen3-Embedding is trained with an instruction on the query side
      // (never the passage side); with it the answer pulls clearly ahead of
      // passages that merely share the topic.
      const text = /qwen3-embedding/i.test(name)
        ? `Instruct: Given a question, retrieve passages that answer it\nQuery: ${query}`
        : query;
      const [raw] = await embedTexts([text], name, signal);
      queryVectors.set(name, normalise(raw));
    } catch (err) {
      if (signal?.aborted) throw err;
      if (name === model && !hybrid) throw err;
    }
  }

  const dense = candidates
    .filter(c => c.vector && queryVectors.has(c.embedModel || model))
    .map(c => ({ candidate: c, score: dot(queryVectors.get(c.embedModel || model), c.vector) }))
    .filter(hit => hit.score >= minScore)
    .sort((a, b) => b.score - a.score);

  const strip = ({ vector, ...rest }) => rest;   // the vector is not context

  if (!hybrid) {
    const hits = dense.slice(0, topK).map(hit => ({ ...strip(hit.candidate), score: hit.score }));
    return rerank ? await safeRerank(query, hits, { model: rerankModel, topK, signal }) : hits;
  }

  /* BM25 over the same candidates.
   *
   * Note what is *not* here: the dense floor. A passage naming the exact error
   * code being asked about can sit below `minScore` — that is the failure this
   * whole path exists for, and applying the cosine's floor to the lexical list
   * would filter out precisely the results it was added to find. The lexical
   * side has its own floor, and it is inherent rather than configured: BM25
   * returns nothing for a passage that contains none of the query's terms, so
   * a hit here always means a real token matched. */
  if (!searchSet.index) searchSet.index = buildLexicalIndex(candidates);
  const index = searchSet.index;
  const lexical = lexicalSearch(index, query, { limit: Math.max(topK * 4, 20) });

  /* More than topK goes into the fusion, because a passage's whole value here
     may be that it placed eighth on one list and second on the other. */
  const fused = fuseRRF(
    [dense.slice(0, Math.max(topK * 4, 20)).map(h => h.candidate), lexical.map(h => h.entry)],
    { keyOf: (candidate) => candidate },
  );

  const denseScores = new Map(dense.map(h => [h.candidate, h.score]));
  const lexicalScores = new Map(lexical.map(h => [h.entry, h.score]));

  const hits = fused.slice(0, topK).map(row => ({
    ...strip(row.entry),
    /* `score` stays the cosine wherever there is one, because that is what the
       citation footer and `formatContext` show and a reciprocal-rank sum is
       not a number anybody can read. A lexical-only hit has no cosine, so it
       gets the floor: honest about being below it, and not a fabricated 0.9. */
    score: denseScores.has(row.entry) ? denseScores.get(row.entry) : minScore,
    lexical: lexicalScores.get(row.entry) ?? 0,
    /* Which retrievers found it, so the log line can say so. */
    found: [denseScores.has(row.entry) && 'dense', lexicalScores.has(row.entry) && 'lexical'].filter(Boolean),
  }));

  return rerank ? await safeRerank(query, hits, { model: rerankModel, topK, signal }) : hits;
};

/**
 * The rerank, with its failures spent rather than passed on.
 *
 * A second pass that can leave the caller with nothing is worse than no second
 * pass. Everything that can go wrong here — no model named, the request
 * refused, invalid JSON, a model that ignores `format` — is the same outcome:
 * the ranking that went in comes back out. The one exception is an abort,
 * which is the user leaving and has to keep propagating.
 */
const safeRerank = async (query, hits, options) => {
  if (!options?.model || hits.length < 2) return hits;
  try {
    return await rerankHits(query, hits, options);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return hits;
  }
};

/** Formats hits for injection, with citations the model can quote back. */
export const formatContext = (hits) => hits
  .map((hit, i) => `[${i + 1}] ${hit.docName}${hit.page > 1 ? `, p.${hit.page}` : ''} (relevance ${hit.score.toFixed(2)})\n${hit.text}`)
  .join('\n\n');
