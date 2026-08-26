import localforage from 'localforage';
import { unzipSync, strFromU8 } from 'fflate';

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

export const extractPdf = async (arrayBuffer, onProgress) => {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
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

export const isSupportedDocument = (file) => {
  const name = (file.name || '').toLowerCase();
  return /\.(pdf|docx|txt|md|markdown|csv|json|log|ya?ml|xml|html?|tsv)$/.test(name);
};

export const extractDocument = async (file, onProgress) => {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return extractPdf(await file.arrayBuffer(), onProgress);
  if (name.endsWith('.docx')) return extractDocx(await file.arrayBuffer());
  return extractPlainText(file);
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
      buffer = trimmed.length > overlap ? trimmed.slice(-overlap) : '';
      bufferHasNewText = false;
    };

    for (const paragraph of paragraphs) {
      const piece = paragraph.trim();
      if (!piece) continue;

      // A paragraph longer than the budget gets a hard split of its own.
      if (piece.length > size) {
        if (bufferHasNewText) flush();
        for (let i = 0; i < piece.length; i += size - overlap) {
          const slice = piece.slice(i, i + size).trim();
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
export const normalise = (vector) => {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const length = Math.sqrt(sum);
  if (!length) return vector.slice();
  return vector.map(v => v / length);
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
export const retrieve = async (query, docs, {
  model = DEFAULT_EMBED_MODEL,
  topK = 5,
  minScore = 0.35,
  signal,
} = {}) => {
  const active = docs.filter(d => d.enabled !== false && Array.isArray(d.chunks) && d.chunks.length);
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
