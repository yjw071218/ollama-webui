/**
 * What of a long document the model is shown, and in what shape.
 *
 * ## What went wrong
 *
 * A long attachment is split into 1,200-character pieces and embedded (see
 * rag.js `chunkPages`), and a question used to be answered from the five
 * pieces closest to it -- about six thousand characters, in order of score,
 * each cut mid-sentence where the chunker happened to stop. Three failures
 * came out of that, all of them "the AI did not understand the document":
 *
 *  - A question about the whole document -- 요약해줘, 무슨 내용이야, what is
 *    this about -- has no "closest five pieces". It got five arbitrary ones
 *    and the answer described a fraction of the file as if it were all of it.
 *  - A passage that answered the question continued in the next piece, which
 *    was not retrieved: the model saw the start of the explanation only.
 *  - The pieces arrived shuffled by score, so a procedure came back as step 4,
 *    step 1, step 3.
 *  - And a document only a little over the fixed 30,000-character limit was
 *    split at all, even with a model -- a CLI model, or a local one with a big
 *    `num_ctx` -- that could have read every word of it.
 *
 * ## What this does instead
 *
 *  - Sends the whole document whenever the context window can hold it
 *    (`fitsWhole`), sized from the context actually configured.
 *  - For a specific question: each retrieved piece brings its neighbours,
 *    pieces are put back in document order, and adjacent pieces are joined
 *    into one passage with the chunker's overlap removed (`assemblePassages`).
 *    The amount is a token budget derived from the context, not a count of
 *    five.
 *  - For a question about the whole document (`isOverviewQuestion`): the
 *    whole document if it fits, else a summary built part by part over all of
 *    it (App.jsx, `digestDocument`), else -- if that fails -- pieces spread
 *    evenly across the whole document (`coverageSections`).
 *
 * Everything here is pure, so it is tested without a model
 * (scripts/doccontext.test.mjs).
 */

/* ------------------------------------------------------------ token sizes */

/* Hangul, kana and CJK ideographs come out at about one token per character in
   the tokenizers these models use; Latin text at about one per 3.6. An estimate
   is enough: it decides what to send, and errs towards sending less. */
const WIDE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/g;

/** Rough token count of `text`. */
export const estimateTokens = (text) => {
  const s = String(text || '');
  if (!s) return 0;
  const wide = (s.match(WIDE) || []).length;
  return Math.ceil(wide / 1.1 + (s.length - wide) / 3.6);
};

/** What a CLI model (Claude, GPT, Gemini through their CLIs) is given to read. Their
    windows are 200k tokens and up; this leaves the rest for the conversation. */
export const CLI_PROMPT_TOKENS = 120000;

/** Below this a document is always sent whole, as it always was. */
export const MIN_INLINE_CHARS = 30000;

/**
 * Tokens available to the prompt: the context window less what the answer
 * needs. The answer's reserve is capped at a third of the window so that a
 * large `maxTokens` does not leave nothing to read.
 */
export const promptBudget = ({ numCtx, maxTokens, cli = false } = {}) => {
  if (cli) return CLI_PROMPT_TOKENS;
  const ctx = Number(numCtx) > 0 ? Number(numCtx) : 16384;
  const reserve = Math.min(Number(maxTokens) > 0 ? Number(maxTokens) : 4096, Math.floor(ctx / 3));
  return Math.max(1024, ctx - reserve);
};

/** Whether a document can go into the message whole rather than be indexed. */
export const fitsWhole = (text, opts = {}) => {
  const s = String(text || '');
  if (s.length <= MIN_INLINE_CHARS) return true;
  // Most of the window, not all of it: the conversation and the question are there too.
  return estimateTokens(s) <= Math.floor(promptBudget(opts) * 0.7);
};

/** Tokens retrieved passages may take up in one turn. */
export const passageBudget = (opts = {}) => Math.max(1500, Math.floor(promptBudget(opts) * 0.5));

/* ------------------------------------------------------- question shape */

/* A question about the document as a whole rather than a fact in it. Korean
   first, because that is how this app is mostly used. */
const OVERVIEW = new RegExp([
  '요약', '요점', '정리\\s*(해|좀|하)', '개요', '전체\\s*(적|적으로|를|내용|요지)', '전반',
  '핵심\\s*(내용|만|을|이|정리|포인트)', '줄거리', '목차', '총평', '훑어',
  '(무슨|어떤|뭔|무엇에\\s*관한)\\s*(내용|문서|파일|글|자료)', '내용\\s*(이|을|좀)?\\s*(뭐|무엇|알려|설명)',
  '(다|전부|끝까지)\\s*읽', '처음부터\\s*끝까지',
  'summar', 'overview', 'outline', 'tl;?dr', '\\bgist\\b', 'main\\s+(points|ideas|takeaways)',
  'key\\s+(points|takeaways|findings)', "what('?s|\\s+is)\\s+(this|it|the)(\\s+(file|document|pdf|paper|report|article))?\\s+about",
  'table\\s+of\\s+contents',
].join('|'), 'i');

export const isOverviewQuestion = (question) => OVERVIEW.test(String(question || ''));

/* ---------------------------------------------------- joining pieces */

/**
 * `a` followed by `b`, with the text they share written once.
 *
 * The chunker seeds each piece with the last ~200 characters of the one before
 * (rag.js `chunkPages`), so neighbours overlap; shown as they are, every seam
 * repeats a sentence. Found by locating the start of `b` in the end of `a`.
 */
export const joinOverlap = (a, b) => {
  if (!a) return b || '';
  if (!b) return a;
  const tail = a.slice(-600);
  const head = b.slice(0, 24);
  if (head.length >= 12) {
    for (let at = tail.indexOf(head); at >= 0; at = tail.indexOf(head, at + 1)) {
      const shared = tail.slice(at);
      if (b.startsWith(shared)) return a + b.slice(shared.length);
    }
  }
  return `${a}\n\n${b}`;
};

const GAP = '[…]';

/** Consecutive runs of the chosen piece indexes, ascending. */
const runsOf = (indexes) => {
  const sorted = [...new Set(indexes)].sort((x, y) => x - y);
  const runs = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
};

/** One passage per run: its text, pages and best score. */
const sectionsFor = (doc, indexes, scores = new Map()) => runsOf(indexes).map((run) => {
  const pieces = run.map(i => doc.chunks[i]);
  const best = run.map(i => scores.get(i)).filter(v => typeof v === 'number');
  return {
    docId: doc.id,
    docName: doc.name,
    page: pieces[0]?.page ?? 1,
    pageEnd: pieces[pieces.length - 1]?.page ?? 1,
    from: run[0],
    to: run[run.length - 1],
    total: doc.chunks.length,
    text: pieces.reduce((acc, p) => joinOverlap(acc, p?.text || ''), ''),
    score: best.length ? Math.max(...best) : null,
  };
});

/**
 * Retrieved pieces, put back into the document they came from.
 *
 * Each hit (with `docId` and `index`, its position in the document) is taken
 * in rank order, then its neighbours, nearest first, while the budget lasts.
 * The result is grouped by document -- best document first -- and, within one,
 * in reading order, with adjacent pieces joined into a single passage.
 */
export const assemblePassages = ({ hits, docs, budgetTokens, neighbours = 1, minScore = 0.35 }) => {
  const byId = new Map((docs || []).map(d => [d.id, d]));
  const chosen = new Map();     // docId -> Map(index -> score|null)
  const order = [];             // docIds, best first
  let used = 0;

  const take = (doc, i, score) => {
    if (!doc || i < 0 || i >= doc.chunks.length) return true;
    let picked = chosen.get(doc.id);
    if (picked?.has(i)) {
      if (typeof score === 'number' && !(picked.get(i) >= score)) picked.set(i, score);
      return true;
    }
    const cost = estimateTokens(doc.chunks[i].text);
    if (used > 0 && used + cost > budgetTokens) return false;
    if (!picked) { picked = new Map(); chosen.set(doc.id, picked); order.push(doc.id); }
    picked.set(i, score);
    used += cost;
    return true;
  };

  const anchors = (hits || []).filter(h => byId.has(h.docId) && Number.isInteger(h.index));
  for (const h of anchors) if (!take(byId.get(h.docId), h.index, h.score)) break;
  outer: for (let d = 1; d <= neighbours; d++) {
    for (const h of anchors) {
      const doc = byId.get(h.docId);
      if (!take(doc, h.index - d, null) || !take(doc, h.index + d, null)) break outer;
    }
  }

  const sections = [];
  for (const id of order) {
    const doc = byId.get(id);
    for (const s of sectionsFor(doc, [...chosen.get(id).keys()], chosen.get(id))) {
      sections.push({ ...s, score: s.score ?? minScore });
    }
  }
  return sections;
};

/** The pieces of a document and their total size. */
export const documentTokens = (doc) => (doc?.chunks || []).reduce((n, c) => n + estimateTokens(c.text), 0);

/**
 * The document read front to back within a budget.
 *
 * All of it if it fits. Otherwise pieces spaced evenly from the first to the
 * last, so every part of the document is represented rather than only its
 * opening -- the fallback for a whole-document question when a summary could
 * not be made.
 */
export const coverageSections = (doc, budgetTokens) => {
  const n = doc?.chunks?.length || 0;
  if (!n) return [];
  const costs = doc.chunks.map(c => estimateTokens(c.text));
  const total = costs.reduce((a, b) => a + b, 0);
  if (total <= budgetTokens) return sectionsFor(doc, [...Array(n).keys()]);

  const average = total / n;
  const k = Math.max(1, Math.min(n, Math.floor(budgetTokens / average)));
  const picked = new Set();
  let used = 0;
  for (let j = 0; j < k; j++) {
    const i = k === 1 ? 0 : Math.round((j * (n - 1)) / (k - 1));
    if (picked.has(i)) continue;
    if (used > 0 && used + costs[i] > budgetTokens) break;
    picked.add(i); used += costs[i];
  }
  return sectionsFor(doc, [...picked]);
};

/**
 * The document cut into consecutive parts of at most `partTokens` each, for
 * summarising part by part. Every piece lands in exactly one part.
 */
export const documentParts = (doc, partTokens) => {
  const parts = [];
  let run = [], used = 0;
  (doc?.chunks || []).forEach((c, i) => {
    const cost = estimateTokens(c.text);
    if (run.length && used + cost > partTokens) { parts.push(run); run = []; used = 0; }
    run.push(i); used += cost;
  });
  if (run.length) parts.push(run);
  return parts.map(run => sectionsFor(doc, run)[0]);
};

/* ------------------------------------------------------------ formatting */

const where = (s) => {
  const pages = s.page > 1 || s.pageEnd > 1
    ? (s.pageEnd && s.pageEnd !== s.page ? `, pp.${s.page}-${s.pageEnd}` : `, p.${s.page}`)
    : '';
  const part = s.total > 1 && s.from !== undefined
    ? (s.from === 0 && s.to === s.total - 1 ? ', whole document' : `, part ${s.from + 1}-${s.to + 1} of ${s.total}`)
    : '';
  return pages + part;
};

/** Passages as the model reads them, numbered for citation. */
export const formatSections = (sections) => {
  let last = null;
  return sections.map((s, i) => {
    // A skipped stretch between two passages of one document is marked, so
    // the model does not read them as continuous.
    const gap = last && last.docId === s.docId && s.from > last.to + 1 ? `${GAP}\n` : '';
    last = s;
    const score = typeof s.score === 'number' && s.kind !== 'digest' && s.kind !== 'whole' ? ` (relevance ${s.score.toFixed(2)})` : '';
    const label = s.kind === 'digest' ? ' — summary of the whole document, part by part' : '';
    return `${gap}[${i + 1}] ${s.docName}${where(s)}${label}${score}\n${s.text}`;
  }).join('\n\n');
};

/** The prompt that summarises one part of a long document. */
export const partSummaryPrompt = ({ name, part, of, text, maxWords }) => [
  `This is part ${part} of ${of} of the document "${name}".`,
  `Summarise this part in at most ${maxWords} words, in the same language as the document.`,
  'Keep headings, names, numbers, dates, definitions, decisions and conclusions exactly as written.',
  'Use short bullet points. Do not add anything that is not in the text, and do not comment on the task.',
  '',
  '<<<',
  text,
  '>>>',
].join('\n');
