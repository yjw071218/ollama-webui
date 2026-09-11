/**
 * Turning a file into something the model can be asked about.
 *
 * This is one routine used from two places, and it was in neither. The
 * knowledge panel had it inline; the composer had nothing at all and dealt
 * with a long attachment by cutting it off at thirty thousand characters and
 * apologising — so a fifty-page report arrived as its first ten pages and the
 * model answered confidently about a document it had only seen the start of.
 * That is a worse failure than refusing the file, because nothing about the
 * answer says which half it is based on.
 *
 * Embedding the whole thing instead is what the knowledge library already did.
 * All that was missing was a way to call it from the composer.
 */
import {
  extractDocument,
  chunkPages,
  embedTexts,
  normalise,
  addDocument,
  DEFAULT_EMBED_MODEL,
} from './rag.js';

// Embedding a large document in one request can time out; batch it.
export const EMBED_BATCH = 32;

/** A stable-enough id without pulling in a uuid dependency. */
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Read a file, split it, embed every piece, and put it in the library.
 *
 * `onProgress` is called with `{ stage, name, done, total }` throughout —
 * 'extract' while the file is being read, 'embed' while the vectors are being
 * computed. A fifty-page PDF takes a while at both, and a composer that looks
 * frozen is a composer people press twice.
 *
 * Throws with a message worth showing. The caller decides what to do about it;
 * in the composer that means falling back to sending an excerpt, because half
 * a document is still better than refusing to answer.
 */
export const ingestDocument = async (file, {
  userId,
  embedModel = DEFAULT_EMBED_MODEL,
  // Who the document belongs to. A `chatId` means it was attached to one
  // conversation and only that conversation may retrieve from it; a `folderId`
  // means it was pinned to a project; neither means it is the shared library,
  // which is what a document added in Settings is. See `visibleDocuments`.
  chatId = null,
  folderId = null,
  onProgress,
  signal,
} = {}) => {
  onProgress?.({ stage: 'extract', name: file.name, done: 0, total: 0 });
  const pages = await extractDocument(file, (done, total) => {
    onProgress?.({ stage: 'extract', name: file.name, done, total });
  });

  const chunks = chunkPages(pages);
  if (chunks.length === 0) {
    const err = new Error('no-text');
    err.code = 'no-text';
    throw err;
  }

  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    if (signal?.aborted) {
      const err = new Error('cancelled');
      err.code = 'cancelled';
      throw err;
    }
    onProgress?.({ stage: 'embed', name: file.name, done: i, total: chunks.length });
    const batch = chunks.slice(i, i + EMBED_BATCH).map(c => c.text);
    const embedded = await embedTexts(batch, embedModel, signal);
    // Stored normalised, so retrieval is a plain dot product.
    embedded.forEach(v => vectors.push(normalise(v)));
  }

  const doc = {
    id: newId(),
    name: file.name,
    size: file.size,
    pages: pages.length,
    addedAt: Date.now(),
    embedModel,
    enabled: true,
    // Absent for a library document, so `visibleDocuments` treats it as shared.
    ...(chatId ? { chatId: String(chatId) } : {}),
    ...(folderId ? { folderId: String(folderId) } : {}),
    chunks: chunks.map((c, i) => ({ page: c.page, text: c.text, vector: vectors[i] })),
  };

  const library = await addDocument(userId, doc);
  onProgress?.({ stage: 'done', name: file.name, done: chunks.length, total: chunks.length });
  return { doc, library };
};

/**
 * Text that arrived on the clipboard rather than as a file.
 *
 * Pasting four hundred lines of a stack trace into the composer buries the
 * question underneath it and makes the box unusable — you cannot see what you
 * are typing, and neither can you see what you pasted. Every chat interface
 * worth using turns that into an attachment instead.
 *
 * The threshold is in characters and lines both, because the two failures are
 * different shapes: one very long line of minified JSON is as unreadable in a
 * composer as three hundred short ones.
 */
export const PASTE_AS_FILE_CHARS = 1800;
export const PASTE_AS_FILE_LINES = 18;

export const shouldPasteAsFile = (text) => {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (s.length >= PASTE_AS_FILE_CHARS) return true;
  return s.split('\n').length >= PASTE_AS_FILE_LINES;
};

/**
 * What to call a pasted block.
 *
 * A name is the only thing the chip can show, so it should say what the thing
 * is. The language is guessed from the shape of the text rather than from a
 * parser: the guess only picks a file extension, and a wrong extension costs
 * nothing but a slightly odd label.
 */
export const namePastedText = (text, { prefix = 'pasted' } = {}) => {
  const s = String(text ?? '');
  const head = s.slice(0, 4000);

  const looks = [
    ['json', () => /^\s*[[{][\s\S]*[\]}]\s*$/.test(s.trim())],
    ['py', () => /^\s*(?:def |class |import |from \w+ import )/m.test(head)],
    ['ts', () => /\b(?:interface|type)\s+\w+\s*[={]|:\s*(?:string|number|boolean)\b/.test(head)],
    ['jsx', () => /<\/?[A-Z]\w*[\s/>]/.test(head) && /\b(?:const|function|import)\b/.test(head)],
    ['js', () => /\b(?:function|const|let|var|=>|require\(|import .* from)\b/.test(head)],
    ['java', () => /\b(?:public|private)\s+(?:static\s+)?(?:class|void|int|String)\b/.test(head)],
    ['sql', () => /\b(?:SELECT|INSERT INTO|UPDATE|CREATE TABLE)\b/i.test(head)],
    ['html', () => /<(?:!doctype|html|div|span|p)\b/i.test(head)],
    ['css', () => /[.#]?[\w-]+\s*\{[^}]*:[^}]*;[\s\S]*\}/.test(head)],
    ['sh', () => /^\s*(?:#!\/|\$ |sudo |npm |git |cd )/m.test(head)],
    ['log', () => /^\s*(?:Traceback|Error|Exception|\w+Error:|at \w+)/m.test(head)],
  ];

  const hit = looks.find(([, test]) => { try { return test(); } catch { return false; } });
  return `${prefix}.${hit ? hit[0] : 'txt'}`;
};
