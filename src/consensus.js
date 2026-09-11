/**
 * Reading several answers at once.
 *
 * Side-by-side comparison already exists and it is genuinely useful for one
 * thing: seeing that a 3B model is fast and shallow. It is much less useful
 * for the case people actually reach for it — a factual question where no
 * single local model is reliable — because three columns of four paragraphs
 * is not something anybody reads three times. What you want to know is
 * narrow:
 *
 *   * where do they agree? (probably true, or at least the common training
 *     data's version of true)
 *   * where do they differ, and which said what? (the part to check)
 *   * did any of them notice something the others missed?
 *
 * That is a reading task, and a model is adequate at it in a way it is not
 * adequate at the original question — comparing three texts in front of it is
 * far easier than recalling a fact.
 *
 * ## Attribution by name, not number
 *
 * The columns are labelled with model names, so the synthesis says
 * "llama3:8b says X, qwen3:14b says Y". Numbered sources would be a second
 * mapping to hold in your head while reading, and the whole point of this
 * step is that it is less work than reading the columns.
 *
 * ## What it must not do
 *
 * Vote. Three models agreeing is three samples from overlapping training
 * data, not three witnesses — a shared misconception is exactly the thing
 * they will all report confidently. So the prompt asks for agreement to be
 * *reported*, never for a winner to be declared, and asks explicitly for the
 * question of whether agreement here means much.
 */

/** Reasoning is not an answer; it is the model talking to itself. */
export const stripThinking = (content) => String(content || '')
  .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
  .trim();

/**
 * The runs worth synthesising.
 *
 * A run that failed, was stopped or produced nothing is not an opinion, and
 * including it would invite the model to explain the silence.
 */
export const answersFor = (runs = []) => (runs || [])
  .filter(run => run && run.model && run.status === 'done' && !run.error)
  .map(run => ({ model: run.model, answer: stripThinking(run.content) }))
  .filter(entry => entry.answer.length > 0);

/** Two is the minimum: one answer has nothing to be compared with. */
export const canSynthesise = (runs = []) => answersFor(runs).length >= 2;

const WORD = /[\p{L}\p{N}]{3,}/gu;

/**
 * How much two answers even resemble each other, by wording.
 *
 * Explicitly *not* a measure of agreement — two answers can say the opposite
 * thing in near-identical words, and the same thing in none. It is a cheap
 * signal for one decision only: whether reading a synthesis is likely to be
 * worth the wait. Answers with almost no words in common are usually answers
 * to different readings of the question, which is the most useful thing this
 * whole screen can tell you and the fastest to compute.
 *
 * There is no stoplist. "the" counts towards the overlap exactly as "CSS"
 * does, which inflates it a little for any two texts in the same language --
 * and a list of function words would have to exist in all twelve of this
 * app's languages before it was fair to anybody. Living with the inflation is
 * the reason this is labelled as wording and never as agreement.
 */
export const wordOverlap = (answers = []) => {
  const sets = answers
    .map(entry => new Set((entry.answer.toLowerCase().match(WORD) || [])))
    .filter(set => set.size > 0);
  if (sets.length < 2) return null;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let shared = 0;
      for (const word of sets[i]) if (sets[j].has(word)) shared++;
      const union = sets[i].size + sets[j].size - shared;
      if (union > 0) { total += shared / union; pairs++; }
    }
  }
  return pairs ? total / pairs : null;
};

/** Long answers are trimmed rather than dropped, so every model is heard. */
export const ANSWER_BUDGET = 3000;

/**
 * What the reading model is given.
 *
 * The rules are the whole design. "Report agreement, do not treat it as
 * proof" is there because three models agreeing is three samples of
 * overlapping training data and not three witnesses; a shared misconception
 * is precisely what they will all state confidently.
 */
export const consensusPrompt = (question, answers, language = '') => {
  const body = answers
    .map(entry => `### ${entry.model}\n${entry.answer.slice(0, ANSWER_BUDGET)}`)
    .join('\n\n');

  return [
    'Several models were asked the same question. Read their answers and report what they add up to.',
    '',
    `QUESTION: ${question}`,
    '',
    'ANSWERS:',
    body,
    '',
    'Write:',
    '1. **Agreed** — what every answer says, in one short paragraph.',
    '2. **Disagreed** — each point they differ on, naming which model said what.',
    '3. **Only one noticed** — anything raised by a single answer that looks worth keeping.',
    '4. **Worth checking** — the specific claims a reader should verify before relying on them.',
    '',
    'Rules:',
    '- Refer to the models by name, exactly as written above.',
    '- Agreement is not proof. These are models with overlapping training data, not independent witnesses, so report agreement as agreement and say so where a shared claim is the kind that could be a shared mistake.',
    '- Do not answer the question yourself, and do not add facts none of the answers contain.',
    '- Do not declare a winner. If one answer is better argued, say what makes it so instead.',
    '- If they all say essentially the same thing, say that in one line rather than manufacturing differences.',
    language ? `- Write in ${language}.` : '',
  ].filter(Boolean).join('\n');
};

/**
 * Which model should do the reading.
 *
 * The fastest of the ones that answered, because this is a second wait after
 * a wait people have already sat through, and comparing three texts that are
 * in front of you is a much easier job than the original question was. A
 * caller with a better idea passes `preferred`.
 */
export const pickJudge = (runs = [], preferred = '') => {
  const answered = answersFor(runs).map(entry => entry.model);
  if (preferred && answered.includes(preferred)) return preferred;
  if (answered.length === 0) return '';

  const speedOf = (model) => {
    const run = (runs || []).find(r => r.model === model);
    const speed = Number(run?.metrics?.tokensPerSec);
    return Number.isFinite(speed) ? speed : -1;
  };
  return answered.slice().sort((a, b) => speedOf(b) - speedOf(a))[0];
};
