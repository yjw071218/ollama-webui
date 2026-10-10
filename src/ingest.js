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
  /* Where the file came from, when it came from a watched folder: the path,
     its size and its modification time. It is what a later scan compares
     against to decide whether this document is still current -- and its
     absence is what marks a document as somebody's own, which is why a folder
     sync may never delete a document that has none. See src/watchFolders.js. */
  source = null,
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
    ...(source ? { source } : {}),
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
  const head = s.slice(0, 6000);
  const lines = head.split('\n').filter(l => l.trim());
  const n = Math.max(1, lines.length);
  const share = (re) => lines.filter(l => re.test(l)).length / n;

  /* Prose first. One word that happens to be a keyword ("const", "=>",
     "SELECT" inside a sentence) used to name a Korean answer `pasted.js`.
     Code is now recognised by how many *lines* look like code. */
  const letters = (head.match(/[A-Za-z\uAC00-\uD7A3]/g) || []).length || 1;
  const hangul = (head.match(/[\uAC00-\uD7A3]/g) || []).length / letters;
  const codeLine = /(?:[;{}]\s*$|^\s*(?:import|export|const|let|var|function|def|class|return|if\s*\(|for\s*\(|while\s*\(|public|private|#include|package)\b|^\s*[}\])]|=>\s*[{(]?\s*$)/;
  const code = share(codeLine);
  const markdown = share(/^\s*(?:#{1,6}\s|[*+-]\s+\S|\d+\.\s+\S|>\s|```|\|.*\|)|\*\*[^*]+\*\*/);
  const trimmed = s.trim();
  if (/^[[{][\s\S]*[\]}]$/.test(trimmed)) { try { JSON.parse(trimmed); return `${prefix}.json`; } catch { /* not json */ } }
  if (/^\s*(?:Traceback \(most recent call last\)|\w*(?:Error|Exception)\b.*:)/m.test(head) && share(/^\s*(?:at |File "|\w*Error|\w*Exception)/) > 0.15) return `${prefix}.log`;
  // Markup and shell sessions are not "code lines" by the measure above.
  if (/^\s*<(?:!doctype html|html)\b/i.test(head) || share(/^\s*<\/?[a-z][\w-]*[\s>]/i) > 0.5) return `${prefix}.html`;
  if (share(/^\s*(?:#!\/|\$ )/) > 0.5) return `${prefix}.sh`;
  if (code < 0.3) return `${prefix}.${markdown >= 0.08 ? 'md' : 'txt'}`;
  if (hangul > 0.35 && code < 0.5) return `${prefix}.${markdown >= 0.08 ? 'md' : 'txt'}`;

  const looks = [
    ['py', () => share(/^\s*(?:def |class \w+.*:\s*$|import \w|from \w+ import |elif |print\()/) > 0.1],
    ['tsx', () => /<\/?[A-Z]\w*[\s/>]/.test(head) && /:\s*(?:string|number|boolean|React\.)/.test(head)],
    ['ts', () => share(/^\s*(?:export\s+)?(?:interface|type)\s+\w+|:\s*(?:string|number|boolean)\b[;,)=]/) > 0.05],
    ['jsx', () => /<\/?[A-Z]\w*[\s/>]/.test(head) && share(/^\s*(?:const|function|import|export)\b/) > 0.03],
    ['java', () => share(/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|void|int|String|[A-Z]\w*)\b/) > 0.05],
    ['sql', () => share(/^\s*(?:SELECT|FROM|WHERE|INSERT INTO|UPDATE|CREATE TABLE|JOIN|GROUP BY|ORDER BY)\b/i) > 0.2],
    ['html', () => share(/^\s*<\/?[a-z][\w-]*[\s>]/i) > 0.3],
    ['css', () => share(/^\s*(?:[.#@]?[\w-][\w\s.#:>,-]*\{|[\w-]+\s*:\s*[^;]+;\s*$)/) > 0.4],
    ['sh', () => share(/^\s*(?:#!\/|\$ |sudo |npm |git |cd |echo |export \w+=)/) > 0.3],
    ['js', () => share(/^\s*(?:const|let|var|function|import|export|module\.exports|require\()\b|=>/) > 0.08],
  ];
  const hit = looks.find(([, test]) => { try { return test(); } catch { return false; } });
  return `${prefix}.${hit ? hit[0] : 'txt'}`;
};
