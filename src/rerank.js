/**
 * Reading the passages before handing them over.
 *
 * Retrieval returns the five chunks nearest the question. "Nearest" is not
 * "answers it", and the gap between those two is where the bad answers come
 * from: a passage about the right subject that does not contain the fact, put
 * in front of a small model with the instruction to use it, is an invitation
 * to invent the fact and cite the passage. The citation then makes the
 * invention look checked.
 *
 * So there is a second pass, and it does something the first pass structurally
 * cannot. Retrieval compares a question to a passage as two points; this asks
 * a question *about* a passage with both texts in front of the model. That is
 * a reading comprehension task, and it is the kind of thing a 4B model is
 * genuinely good at — far better than it is at recalling the fact itself,
 * which is the same observation `src/verify.js` is built on.
 *
 * ## Why this is not on by default
 *
 * It costs a round trip before the answer starts. On the machine this is
 * written for that is one to four seconds of nothing happening, on every
 * message, and most messages do not need it — a question whose words are in
 * the document is already retrieved correctly by the first pass. A second or
 * two is cheap when it saves a wrong answer and expensive when it saves
 * nothing, and which of those it is depends on the library, so it is a switch
 * rather than a decision made here.
 *
 * ## Scoring, not ordering
 *
 * The model is asked to score each passage 0–3 rather than to sort them.
 * Sorting asks it to hold every passage in mind at once and emit a
 * permutation, which is the shape that produces a list with a passage missing,
 * a passage repeated, or an index that was never offered. A score per passage
 * is a fixed number of independent small judgements, and `format` pins the
 * reply to a schema, so the only failure left is a number out of range — which
 * is clamped.
 *
 * Passages the model scores 0 are *dropped*, and that is the point of running
 * it at all. Returning "nothing in your documents answers this" is a good
 * answer, and the floor on the cosine (`minScore`) cannot produce it: a floor
 * only knows how close the nearest thing was, never whether it was the thing.
 *
 * ## It is never allowed to make retrieval worse
 *
 * A feature that improves the good case and destroys the bad one is not an
 * improvement; it is a coin toss with extra steps. So the failures split in
 * two, by who can do something about them.
 *
 * What this function can answer for, it answers for: an id it never offered, a
 * score outside 0–3, a reply that scored nothing at all. Each of those is a
 * judgement that did not happen, and each gives back the ranking that came in.
 *
 * What is *not* in that list, and was: a model that scored every passage 0.
 * That guard looked like the same kind of caution and was the opposite of it —
 * it turned the one verdict this whole pass exists to produce into "keep
 * everything". Asked about a dishwasher warranty over a library of graphics
 * card specifications, the judge correctly returned four zeroes and the guard
 * put all four passages back in front of the model. The guard above it already
 * covers the case it was reaching for: a reply with no usable scores at all
 * returns the input, and a passage the model never mentioned keeps its place,
 * so nothing can be left empty *except* by a complete verdict of "none of
 * these answer the question".
 *
 * What it cannot — the request refused, the connection dropped, a model
 * ignoring `format` and replying in prose — it throws, because the caller is
 * the only one who knows whether that is worth a line in the log. `safeRerank`
 * in `rag.js` is that caller, and it turns every one of them back into the
 * original ranking. An `AbortError` is the exception at both levels: that is
 * the user leaving, and it has to keep propagating.
 */

import { decodeByteFallback } from './byteFallback.js';

/* The reply's shape, pinned rather than requested. Ollama passes this to the
   sampler as a grammar, so a model cannot return prose around the JSON, which
   is the single most common way a structured call fails. */
const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          score: { type: 'integer' },
        },
        required: ['id', 'score'],
      },
    },
  },
  required: ['scores'],
};

/* Written as a rubric because "rate the relevance" without one produces a
   column of 2s. The distinction that earns its place is 1 vs 0: a passage
   about the right subject that does not contain the answer is the case this
   whole pass exists to catch, so it gets its own line. */
const RUBRIC = `You are ranking passages retrieved from a user's own documents.

For each passage, score how well it answers the QUESTION:

3 = contains the answer directly
2 = contains part of the answer, or facts needed to work it out
1 = same topic, but does not contain the answer
0 = unrelated, or mentions the words without being about them

Judge only what the passage says. Do not use anything you know. Do not
explain. Return one score for every passage id you were given.`;

/** How much of a passage the judge is shown. */
const PASSAGE_CHARS = 1200;

/**
 * Re-order hits by how well the model thinks each answers the question.
 *
 * `hits` is whatever `retrieve` returned; each needs a `.text`. The returned
 * array is the same objects, re-ordered, each carrying the `rerank` score it
 * was given. Nothing is mutated.
 */
export const rerankHits = async (query, hits, {
  model,
  topK = hits?.length || 0,
  minScore = 1,
  signal,
  fetchImpl = fetch,
} = {}) => {
  if (!model || !Array.isArray(hits) || hits.length < 2) return hits || [];

  const passages = hits
    .map((hit, i) => `[${i}] ${String(hit.text || '').slice(0, PASSAGE_CHARS)}`)
    .join('\n\n');

  const res = await fetchImpl('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      /* A judge that thinks first is a judge that takes ten seconds to say
         "2". The rubric is the reasoning. */
      think: false,
      format: SCORE_SCHEMA,
      messages: [{
        role: 'user',
        content: `${RUBRIC}\n\nQUESTION: ${query}\n\nPASSAGES:\n${passages}`,
      }],
      /* Pinned for the same reason every other call here pins it: an omitted
         num_ctx does not get a modest default, it gets the server-wide
         OLLAMA_CONTEXT_LENGTH, which on at least one machine was a million
         tokens and a KV cache larger than its RAM. See EMBED_NUM_CTX. */
      options: { temperature: 0, num_predict: 30 * hits.length + 64, num_ctx: 8192 },
    }),
  });

  if (!res.ok) throw new Error(`Rerank failed (HTTP ${res.status})`);

  const data = await res.json();
  let parsed;
  try {
    parsed = JSON.parse(decodeByteFallback(data.message?.content || '{}'));
  } catch (e) {
    throw new Error('The model did not return valid JSON');
  }

  const scores = new Map();
  for (const row of Array.isArray(parsed.scores) ? parsed.scores : []) {
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id < 0 || id >= hits.length) continue;
    const raw = Number(row?.score);
    if (!Number.isFinite(raw)) continue;
    scores.set(id, Math.max(0, Math.min(3, Math.round(raw))));
  }

  /* A reply that scored nothing at all is a failed judgement rather than a
     verdict, and gives back what came in: dropping every passage on the
     strength of a malformed reply turns a working retrieval into none at all. */
  if (scores.size === 0) return hits;

  const kept = hits
    .map((hit, i) => ({ hit, i, score: scores.has(i) ? scores.get(i) : null }))
    /* A passage the model did not mention keeps its place rather than being
       dropped — silence is not a zero. Which is also what makes an empty
       result trustworthy: it can only happen when every passage was scored and
       every score was below the floor, and that is the verdict "none of these
       answer the question" rather than a reply that went wrong. It is returned
       as such. The caller shows "nothing relevant enough to include", which is
       a better answer than four passages about something else. */
    .filter(row => row.score === null || row.score >= minScore);

  return kept
    .sort((a, b) => {
      const scoreA = a.score === null ? -1 : a.score;
      const scoreB = b.score === null ? -1 : b.score;
      if (scoreB !== scoreA) return scoreB - scoreA;
      // A tie is broken by what retrieval thought, which is the only other
      // opinion available and is better than the array's order.
      return a.i - b.i;
    })
    .slice(0, topK)
    .map(row => (row.score === null ? row.hit : { ...row.hit, rerank: row.score }));
};
