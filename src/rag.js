import localforage from 'localforage';
import { unzipSync, strFromU8 } from 'fflate';
import { safeTail, safeSlice } from './textCut.js';

/**
 * Retrieval over documents the user attaches.
 *
 * Everything runs locally: text is extracted in the browser, embedded through
 * Ollama's /api/embed, and the vectors live in IndexedDB. Nothing leaves the
 * machine, and there is no vector database to run.
 */

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'knowledge' });

export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

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

export const embedTexts = async (texts, model = DEFAULT_EMBED_MODEL, signal) => {
  const res = await fetch('/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
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

export const retrieve = async (query, docs, {
  model = DEFAULT_EMBED_MODEL,
  topK = 5,
  minScore = 0.35,
  chatId = null,
  folderId = null,
  signal,
} = {}) => {
  const active = visibleDocuments(docs, { chatId, folderId })
    .filter(d => Array.isArray(d.chunks) && d.chunks.length);
  if (active.length === 0 || !query.trim()) return [];

  const [queryVector] = await embedTexts([query], model, signal);
  const normalised = normalise(queryVector);

  const scored = [];
  for (const doc of active) {
    for (const chunk of doc.chunks) {
      if (!chunk.vector) continue;
      scored.push({
        score: dot(normalised, chunk.vector),
        docId: doc.id,
        docName: doc.name,
        page: chunk.page,
        text: chunk.text,
      });
    }
  }

  return scored
    .filter(hit => hit.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
};

/** Formats hits for injection, with citations the model can quote back. */
export const formatContext = (hits) => hits
  .map((hit, i) => `[${i + 1}] ${hit.docName}${hit.page > 1 ? `, p.${hit.page}` : ''} (relevance ${hit.score.toFixed(2)})\n${hit.text}`)
  .join('\n\n');
