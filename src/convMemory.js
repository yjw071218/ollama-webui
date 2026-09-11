/**
 * Why a long conversation gets slow, and what to do instead.
 *
 * Ollama re-reads the whole prompt on every turn. There is no server-side
 * cache of a conversation, so turn forty is not "the model remembering turn
 * one" — it is the model *reading turn one again*, along with the other
 * thirty-eight, before it writes a word. The cost is visible in the app's own
 * numbers as `prompt_eval_duration`, and it grows linearly while the answers
 * stay the same size:
 *
 *     turn 5:    1,800 tokens in →  0.4s before the first character
 *     turn 20:  14,000 tokens in →  3.1s
 *     turn 40:  31,000 tokens in →  7.9s, and the context window is nearly full
 *
 * Nothing about that is the model being slow. It is the transcript being sent
 * forty times.
 *
 * ## Three tiers, because they answer different questions
 *
 * **Recent turns, verbatim.** Coherence is local. "Do that again but shorter",
 * "why?", "the second one" — all of it refers to the last few exchanges, and
 * no summary or retrieval reconstructs a pronoun. This tier is never
 * compressed; it is the reason the conversation still works.
 *
 * **A rolling summary of everything older.** Retrieval alone loses the thread:
 * ask "so what did we decide?" and similarity search returns three passages
 * about the topic and nothing about the decision. A few hundred tokens of
 * summary keep continuity at a fixed cost that does not grow.
 *
 * **Retrieval over the older turns.** The summary is lossy by construction, so
 * the specific thing — the exact error message from turn nine, the version
 * number, the name — is fetched back on demand by embedding the current
 * question against the older turns. This is the tier that makes forgetting
 * recoverable rather than permanent.
 *
 * Together the prompt stops growing: recent turns are bounded, the summary is
 * bounded, retrieval is bounded. Turn forty costs about what turn ten did.
 *
 * ## What this must never do
 *
 * Silently lose something and let the model answer as though it had it. Every
 * compressed run is reported to the caller (`dropped`, `summarised`,
 * `retrieved`) so the transcript can say so — a model that has genuinely
 * forgotten turn nine is fine; a model that has forgotten turn nine while the
 * screen still shows it is a bug the reader cannot diagnose.
 *
 * ## Working without an embedding model
 *
 * `nomic-embed-text` may not be installed, and the whole thing has to degrade
 * rather than fail. With no embedder, retrieval falls back to word overlap,
 * which is worse and is still much better than dropping the turns entirely.
 */

/** Turns kept verbatim no matter what. Below this, coherence breaks. */
export const MIN_RECENT_TURNS = 4;

/** The share of the context window the history is allowed to occupy. */
export const HISTORY_BUDGET = 0.5;

/** How many older turns retrieval may bring back. */
export const MAX_RETRIEVED = 4;

/**
 * What recall is allowed to cost, in tokens, and per turn.
 *
 * Without a ceiling the recall tier undoes the whole feature. Four whole turns
 * pasted back is four turns' worth of tokens, so a prompt that had just been
 * cut from thirty turns to eight grows straight back — measured, on a real
 * run, as a system prompt climbing 1,100 → 6,065 characters over six turns
 * while the transcript itself was no longer growing at all.
 *
 * A recalled turn is *evidence that something was said*, not the record of it.
 * The record is on screen. So each one is trimmed, and the set is capped: what
 * comes back is the paragraph that matched, not the conversation.
 */
export const RECALL_BUDGET = 700;
export const RECALL_PER_TURN = 400;

/** On the keyword path, how far below the best match a turn may still score. */
export const KEYWORD_FLOOR = 0.5;

const estimate = (text) => {
  if (!text) return 0;
  const str = String(text);
  let wide = 0;
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) > 127) wide++;
  return Math.ceil((str.length - wide) / 4 + wide / 1.5);
};

export const tokensOf = estimate;

/**
 * The conversation as turns rather than as messages.
 *
 * A turn is a question and everything that answered it, which is the unit both
 * summarising and retrieval want: half an exchange retrieved on its own is a
 * question with no answer, or an answer to a question you cannot see.
 */
export const asTurns = (messages = []) => {
  const turns = [];
  let current = null;

  for (let i = 0; i < (messages || []).length; i++) {
    const message = messages[i];
    if (!message || !message.role) continue;
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      if (current) turns.push(current);
      current = { from: i, to: i, user: String(message.content || ''), assistant: '' };
    } else if (current) {
      current.to = i;
      current.assistant += (current.assistant ? '\n' : '') + String(message.content || '');
    } else {
      // An answer with no question in front of it: a greeting from a persona,
      // or a transcript that was edited. It is still content worth keeping.
      current = { from: i, to: i, user: '', assistant: String(message.content || '') };
    }
  }
  if (current) turns.push(current);

  return turns.map((turn, index) => ({
    ...turn,
    index,
    tokens: estimate(turn.user) + estimate(turn.assistant),
  }));
};

/** One turn as the text that gets embedded, summarised or shown. */
export const turnText = (turn) => [
  turn.user ? `Q: ${turn.user}` : '',
  turn.assistant ? `A: ${turn.assistant}` : '',
].filter(Boolean).join('\n');

/**
 * A turn cut down to what is worth pasting back into a prompt.
 *
 * The question is kept whole where it fits -- it is short and it is what makes
 * the answer legible -- and the answer is cut from the end. Cut rather than
 * summarised because summarising it is what the summary tier already does;
 * this tier exists to bring back the *exact* words, and half of the exact
 * words beats a paraphrase of all of them.
 */
export const trimTurn = (turn, budget = RECALL_PER_TURN) => {
  const question = String(turn.user || '');
  const answer = String(turn.assistant || '');
  const room = Math.max(0, budget * 4 - question.length);      // budget is tokens
  const cut = answer.length > room;
  return [
    question ? `Q: ${question.slice(0, budget * 4)}` : '',
    answer ? `A: ${answer.slice(0, room)}${cut ? ' […]' : ''}` : '',
  ].filter(Boolean).join('\n');
};

/**
 * How to spend the budget.
 *
 * Works backwards from the newest turn, keeping whole turns until the budget
 * is gone. Backwards because the newest are the ones that cannot be replaced
 * by anything — and whole turns because a truncated one is worse than an
 * absent one: the model reads half an answer as the whole answer.
 *
 * `MIN_RECENT_TURNS` overrides the budget. A context so small that four turns
 * do not fit is a context where compressing will not save the conversation
 * either, and sending too much beats sending something incoherent.
 */
export const planHistory = (turns = [], { numCtx = 8192, reserve = 0 } = {}) => {
  const budget = Math.max(0, Math.floor(numCtx * HISTORY_BUDGET) - reserve);
  const recent = [];
  let used = 0;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const fits = used + turn.tokens <= budget;
    const required = recent.length < MIN_RECENT_TURNS;
    if (!fits && !required) break;
    recent.unshift(turn);
    used += turn.tokens;
  }

  const older = turns.slice(0, turns.length - recent.length);
  return {
    recent,
    older,
    usedTokens: used,
    budget,
    // Nothing to gain from summarising one short turn; the summary would cost
    // as much as the turn.
    shouldCompress: older.length > 0 && older.reduce((sum, t) => sum + t.tokens, 0) > 400,
  };
};

/**
 * What the model is asked to write as the running summary.
 *
 * The rules are the design. A summary that reads like minutes — decisions,
 * facts, open threads — is one that answers "what did we decide"; a summary
 * that reads like a book blurb answers nothing and costs the same.
 */
export const summaryPrompt = (turns, previousSummary = '', language = '') => [
  previousSummary
    ? 'Update the running summary of a conversation with what has happened since.'
    : 'Write a running summary of a conversation so far.',
  '',
  ...(previousSummary ? ['SUMMARY SO FAR:', previousSummary, ''] : []),
  'NEW EXCHANGES:',
  turns.map(turnText).join('\n\n'),
  '',
  'Rules:',
  '- Keep it under 200 words.',
  '- Record decisions, established facts, names, numbers and anything still unresolved.',
  '- Written for the assistant to read before answering the next question, not for a person.',
  '- Keep anything from the previous summary that is still true; drop what has been superseded.',
  '- No preamble. Start with the first fact.',
  language ? `- Write in ${language}.` : '',
].filter(Boolean).join('\n');

const WORD = /[\p{L}\p{N}]{2,}/gu;

/**
 * Retrieval without an embedding model.
 *
 * Word overlap, weighted towards rarer words so that "the" and "이" do not
 * decide the ranking. Much worse than embeddings and much better than dropping
 * the turns — and it is the path that runs on a machine where nobody has
 * installed `nomic-embed-text`, which is most of them.
 */
export const keywordRank = (query, turns) => {
  const asked = new Set((String(query || '').toLowerCase().match(WORD) || []));
  if (asked.size === 0) return [];

  const frequency = new Map();
  const bags = turns.map(turn => {
    const words = new Set((turnText(turn).toLowerCase().match(WORD) || []));
    for (const word of words) frequency.set(word, (frequency.get(word) || 0) + 1);
    return words;
  });

  return turns
    .map((turn, i) => {
      let score = 0;
      for (const word of asked) {
        if (!bags[i].has(word)) continue;
        // A word in every turn tells you nothing about which turn to pick.
        score += 1 / Math.log2(2 + (frequency.get(word) || 0));
      }
      return { turn, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
};

/**
 * Take the best matches until the budget is gone.
 *
 * Best-first, so what the ceiling costs is always the weakest match rather
 * than whichever happened to be last. At least one always survives: a recall
 * tier that returns nothing because the single relevant turn is long is a
 * recall tier that fails on exactly the turns worth recalling.
 */
const withinBudget = (scored, budget = RECALL_BUDGET) => {
  const out = [];
  let used = 0;
  for (const entry of scored) {
    const cost = estimate(trimTurn(entry.turn));
    if (out.length > 0 && used + cost > budget) continue;
    out.push(entry.turn);
    used += cost;
  }
  return out;
};

const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
};

/**
 * Which older turns to bring back.
 *
 * `embed` is injected and may be absent — see the note about degrading at the
 * top. When it throws, that is a missing model or a stopped Ollama rather than
 * a reason to fail the message, so the keyword path takes over silently and
 * the caller is told which was used.
 */
export const retrieveTurns = async (query, older, {
  embed = null,
  limit = MAX_RETRIEVED,
  minScore = 0.25,
} = {}) => {
  if (older.length === 0 || !String(query || '').trim()) return { turns: [], how: 'none' };

  if (embed) {
    try {
      const vectors = await embed([query, ...older.map(turnText)]);
      if (Array.isArray(vectors) && vectors.length === older.length + 1) {
        const [asked, ...rest] = vectors;
        const scored = older
          .map((turn, i) => ({ turn, score: dot(asked, rest[i]) }))
          .filter(entry => entry.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        // Chronological once chosen: three passages shown newest-first read as
        // a conversation running backwards.
        return { turns: withinBudget(scored).sort((a, b) => a.index - b.index), how: 'embedding' };
      }
    } catch (e) {
      // Falls through to keywords.
    }
  }

  /* A floor relative to the best match, not an absolute one.
     Word-overlap scores are not comparable between questions -- a long
     question scores higher against everything -- so the only meaningful
     threshold is "clearly worse than the best thing found". Without it,
     asking about a linker error also recalls the turn about Peru, because
     both contain the word "what". */
  const ranked = keywordRank(query, older);
  const best = ranked[0]?.score || 0;
  const kept = withinBudget(
    ranked.filter(entry => entry.score >= best * KEYWORD_FLOOR).slice(0, limit),
  );
  return {
    turns: kept.sort((a, b) => a.index - b.index),
    how: kept.length ? 'keyword' : 'none',
  };
};

/** The retrieved turns, as a block for the system prompt. */
export const formatRecalled = (turns) => {
  if (turns.length === 0) return '';
  /* Budgeted here as well as in `retrieveTurns`.
     The bug this tier nearly shipped with was an unbounded recall block, and a
     formatter that pastes whatever it is handed is a second way to bring it
     back. Belt and braces on the thing that has already broken once. */
  const kept = withinBudget(turns.map(turn => ({ turn })));
  return [
    '[Earlier in this conversation]',
    'These exchanges are from further back than what follows. They are here',
    'because they look relevant to the question being asked now.',
    '',
    // Trimmed: this tier is here to bring back the exact words that matched,
    // not to put the conversation back into the prompt it was cut from.
    ...kept.map(turn => `--- turn ${turn.index + 1} ---\n${trimTurn(turn)}`),
  ].join('\n');
};

export const formatSummary = (summary) => {
  const text = String(summary || '').trim();
  if (!text) return '';
  return [
    '[The conversation so far]',
    text,
    'This is a summary. Where it is vague and the detail matters, say so rather',
    'than inventing the detail.',
  ].join('\n');
};

/**
 * Everything, in one call.
 *
 * Returns the messages to send plus a record of what was done to get there.
 * The record is not diagnostics: the transcript shows it, because a model that
 * has forgotten turn nine while the screen still displays turn nine is a bug
 * nobody can diagnose from the outside.
 */
export const buildContext = async ({
  messages = [],
  question = '',
  numCtx = 8192,
  reserve = 0,
  summary = '',
  embed = null,
  enabled = true,
} = {}) => {
  const turns = asTurns(messages);
  if (!enabled) {
    return { turns, recent: turns, older: [], recalled: [], summary: '', compressed: false, how: 'off' };
  }

  const plan = planHistory(turns, { numCtx, reserve });
  if (!plan.shouldCompress) {
    return {
      turns, recent: plan.recent, older: plan.older, recalled: [],
      summary: '', compressed: false, how: 'none',
      usedTokens: plan.usedTokens, budget: plan.budget,
    };
  }

  const { turns: recalled, how } = await retrieveTurns(question, plan.older, { embed });
  // A turn that is already going verbatim must not also arrive as a recalled
  // excerpt: the model reads the repetition as emphasis.
  const inRecent = new Set(plan.recent.map(t => t.index));

  return {
    turns,
    recent: plan.recent,
    older: plan.older,
    recalled: recalled.filter(t => !inRecent.has(t.index)),
    summary: String(summary || '').trim(),
    compressed: true,
    how,
    usedTokens: plan.usedTokens,
    budget: plan.budget,
  };
};

/**
 * What was saved, for the note in the transcript.
 *
 * The honest number: what the whole history would have cost against what is
 * actually being sent. Anything else is a marketing figure.
 */
export const savings = (context) => {
  const whole = (context.turns || []).reduce((sum, t) => sum + t.tokens, 0);
  const sending = (context.recent || []).reduce((sum, t) => sum + t.tokens, 0)
    + estimate(context.summary)
    + (context.recalled || []).reduce((sum, t) => sum + estimate(trimTurn(t)), 0);
  return { whole, sending, saved: Math.max(0, whole - sending) };
};
