/**
 * Finding a passage by the words in it.
 *
 * Retrieval here has always been one thing: embed the question, embed every
 * chunk, keep the closest. That is the right default and it fails in one
 * specific, recurring way — a question whose answer turns on an *exact*
 * string. A model number, an error code, a function name, a person, a clause
 * number, a date. An embedding is a summary of meaning, and a summary is
 * precisely the thing that throws away which of two near-identical tokens was
 * written. `ERR_MODULE_NOT_FOUND` and `ERR_MODULE_NOT_FOUND_V2` sit on top of
 * each other in vector space; the paragraph that names the one you asked about
 * is not reliably nearer than the paragraph that names the other.
 *
 * And it fails worse in Korean, which is the language this app is mostly used
 * in. `nomic-embed-text` — the default, and what most people will leave it on
 * — is an English model. Korean goes through it and comes out approximately.
 *
 * BM25 does not have that failure, because it never generalises: a passage
 * containing the token scores, one not containing it does not. It has the
 * opposite failure — ask it a question in different words from the document
 * and it finds nothing at all. The two are wrong about different things, which
 * is the whole argument for running both. See `fuseRRF` below for how the two
 * answers are put together without either one being allowed to overrule.
 *
 * ## Tokens, and why Korean needs its own rule
 *
 * Splitting on whitespace is fine for English and close to useless for
 * Korean. Korean is agglutinative: the document says `문서를`, `문서가`,
 * `문서에서`, and the question says `문서`. Those are four different
 * whitespace tokens and one word, so whitespace matching scores zero on a
 * passage that is about exactly what was asked.
 *
 * The fix is the one Lucene's CJK analyser has used for twenty years, and it
 * needs no dictionary, no morphological analyser and no download: index
 * overlapping **character bigrams** for CJK runs. `문서를` becomes `문서`,
 * `서를`; the question's `문서` is a token the passage has. It over-matches
 * slightly — two characters that happen to sit next to each other in an
 * unrelated word also match — and that is an acceptable trade against scoring
 * zero, especially since the dense side is voting too.
 *
 * Latin runs keep whole-word tokens, and an identifier keeps *both* its dotted
 * whole and its pieces: `v1.2.3` is one token and also `v1`, `2`, `3`, so
 * asking for the exact version finds the exact version, and asking about
 * version 2 still finds it.
 *
 * ## No stored index
 *
 * Nothing here is persisted. The chunks are already in memory — the library is
 * loaded into the browser before a turn can use it — and counting terms over a
 * few thousand short strings takes single-digit milliseconds. A stored index
 * would mean a migration for every document anybody has already added, a
 * second thing to keep in sync with the first, and a new way for the two to
 * disagree. The index is built on demand and cached by a signature of what
 * went into it (see `rag.js`), so a run of questions against an unchanged
 * library builds it once.
 */

/* Runs of CJK: Hiragana, Katakana, CJK ideographs (both planes' BMP ranges)
   and Hangul syllables. Hangul Jamo is deliberately left out — a decomposed
   jamo sequence is not what a browser hands you from a PDF or a keyboard. */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힣]/;
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿가-힣]+/g;

/* A Latin/digit run, allowing the separators that hold an identifier or a
   version number together. Trailing separators are trimmed by the pattern
   itself, so `end.` does not yield `end.`. */
const WORD_RUN = /[a-z0-9]+(?:[._\-/][a-z0-9]+)*/g;

/* Words carrying no information about which passage is wanted. Kept short and
   English-only on purpose: this list exists to stop `the` dominating an idf
   calculation, not to be a linguistic resource. Korean particles are not here
   because bigrams make them harmless — `를` never becomes a token on its own. */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'how', 'i', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why',
  'will', 'with', 'you', 'your',
]);

/**
 * The tokens of a string, in no particular order and with duplicates kept.
 *
 * Duplicates matter: BM25 is a term-*frequency* model, so a passage that says
 * the word six times has to be distinguishable from one that says it once.
 */
export const tokenize = (text) => {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const out = [];

  for (const match of lower.matchAll(WORD_RUN)) {
    const token = match[0];
    if (token.length === 1 && !/[0-9]/.test(token)) continue;  // a stray letter
    if (STOP.has(token)) continue;
    out.push(token);
    /* A compound also contributes its parts, so `error-code-42` answers a
       question about `error code`. Only when there were separators — otherwise
       this pushes the same token twice and doubles its term frequency. */
    if (/[._\-/]/.test(token)) {
      for (const piece of token.split(/[._\-/]+/)) {
        if (!piece || STOP.has(piece)) continue;
        // Same rule as above: a single letter is noise, a single digit is the
        // patch number somebody asked about.
        if (piece.length === 1 && !/[0-9]/.test(piece)) continue;
        out.push(piece);
      }
    }
  }

  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }

  return out;
};

/** Does this text contain anything the CJK rule applies to? */
export const hasCJK = (text) => CJK.test(String(text || ''));

/* BM25's two constants, at the values the literature settles on. `k1` is how
   fast term frequency saturates — a word said ten times is worth more than
   once, but nowhere near ten times as much. `b` is how hard a long passage is
   penalised for its length. Neither is tuned here and neither should be: a
   number chosen by trying it on one library is a number that is wrong on the
   next one. */
const K1 = 1.2;
const B = 0.75;

/**
 * Term statistics over a set of chunks.
 *
 * `entries` is whatever the caller wants back out of a search; only `.text` is
 * read here. The index holds one `Map` of term → count per entry plus the
 * document frequencies, which is the whole of BM25's state.
 */
export const buildLexicalIndex = (entries) => {
  const docs = [];
  const df = new Map();
  let totalLength = 0;

  for (const entry of entries || []) {
    const tokens = tokenize(entry?.text);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    docs.push({ entry, tf, length: tokens.length });
    totalLength += tokens.length;
  }

  return {
    docs,
    df,
    count: docs.length,
    avgLength: docs.length ? totalLength / docs.length : 0,
  };
};

/**
 * Inverse document frequency, in the form that cannot go negative.
 *
 * The textbook BM25 idf turns negative for a term in more than half the
 * documents, which means a passage is *punished* for containing a common word
 * — and on a library of forty chunks from one manual, "the product's name" is
 * in more than half of them. The `1 +` form is the standard correction and it
 * bottoms out at zero instead.
 */
const idf = (index, term) => {
  const seen = index.df.get(term) || 0;
  if (!seen) return 0;
  return Math.log(1 + (index.count - seen + 0.5) / (seen + 0.5));
};

/**
 * The chunks matching a query, best first.
 *
 * A chunk that matches nothing is not returned at all, rather than returned
 * with a score of zero: the caller fuses this list by *rank*, and a tail of
 * ten thousand zero-scoring passages in an arbitrary order is not a ranking.
 */
export const lexicalSearch = (index, query, { limit = 50 } = {}) => {
  const terms = [...new Set(tokenize(query))];
  if (!index || !index.count || terms.length === 0) return [];

  const weights = terms.map(term => [term, idf(index, term)]).filter(([, w]) => w > 0);
  if (weights.length === 0) return [];

  const hits = [];
  for (const doc of index.docs) {
    let score = 0;
    let matched = 0;
    for (const [term, weight] of weights) {
      const freq = doc.tf.get(term);
      if (!freq) continue;
      matched++;
      const norm = 1 - B + B * (doc.length / (index.avgLength || 1));
      score += weight * ((freq * (K1 + 1)) / (freq + K1 * norm));
    }
    if (score > 0) hits.push({ entry: doc.entry, score, matched });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
};

/* Reciprocal rank fusion's one constant. 60 is the value from the paper the
   method comes from, and its job is to stop the top of any single list from
   being decisive: at k=60 the difference between rank 1 and rank 2 is about
   1.6%, so a passage has to do well in *both* lists to beat one that did well
   in one. That is the property being bought — lowering k towards zero turns
   this back into "whichever list was more confident wins". */
const RRF_K = 60;

/**
 * One ranking out of several, without comparing their scores.
 *
 * This is the part that makes running two retrievers safe. A cosine similarity
 * of 0.71 and a BM25 score of 8.3 are not on the same scale, are not on *any*
 * shared scale, and every attempt to put them on one — min-max over the batch,
 * z-scores, a tuned alpha — is a knob that is wrong whenever the batch is
 * unusual. A single irrelevant passage that happens to score 40 on BM25 will
 * flatten every real score to near zero under min-max normalisation.
 *
 * Rank has none of that. Position 1 in a list means the same thing whatever
 * the numbers were, so fusing by position needs nothing to be calibrated and
 * cannot be broken by an outlier.
 *
 * `lists` is a list of lists of entries, each already sorted best-first, and
 * `keyOf` says when an entry from one list is the same thing as an entry from
 * another. `weights` scales a list's contribution for a caller that knows one
 * of its retrievers is better; it defaults to equal, which is the honest
 * position when nobody has measured.
 */
export const fuseRRF = (lists, { keyOf = (x) => x, weights = null, k = RRF_K } = {}) => {
  const merged = new Map();

  lists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    (list || []).forEach((entry, rank) => {
      const key = keyOf(entry);
      const existing = merged.get(key);
      const contribution = weight / (k + rank + 1);
      if (existing) {
        existing.score += contribution;
        existing.ranks[listIndex] = rank + 1;
      } else {
        const ranks = [];
        ranks[listIndex] = rank + 1;
        merged.set(key, { entry, score: contribution, ranks });
      }
    });
  });

  return [...merged.values()].sort((a, b) => b.score - a.score);
};
