/**
 * Checking an answer against what it was given.
 *
 * The failure mode of a local model is not being wrong loudly. It is being
 * wrong in one sentence out of nine, in the same confident register as the
 * other eight — a version number, a function name, a date. Everything else in
 * this app makes answers *arrive*; nothing makes them checkable, and for a
 * model small enough to run on one machine that is the gap that matters.
 *
 * So: one button on an answer, and a second pass that does something the first
 * pass structurally could not. Writing is generative and forward-only; this is
 * a comparison, with both texts already in front of the model, which is a job
 * small models are markedly better at.
 *
 * ## Two different questions
 *
 * If the turn had evidence — retrieved passages, a fetched page, an attached
 * document, web results — then "is this supported?" is a real question with a
 * real answer, and the verdicts mean something.
 *
 * If it had none, the honest question is narrower: *which claims here are the
 * kind that could be wrong*. Specific, checkable, load-bearing. The model
 * cannot verify them from the same memory that produced them, and pretending
 * otherwise would produce a page of green ticks that means nothing at all —
 * which is worse than no feature, because it converts uncertainty into false
 * assurance. `hasEvidence` is what keeps those two apart.
 *
 * ## Quoting, not paraphrasing
 *
 * Every verdict has to quote the answer's own words. A verdict that
 * paraphrases cannot be located in the text it is about, so it cannot be
 * checked and cannot be highlighted — and the reader is left trusting a second
 * model's summary of a first model's summary.
 */

export const VERDICTS = ['supported', 'unsupported', 'contradicted', 'unchecked'];

/** How much of the answer and of the evidence is worth sending. */
export const ANSWER_BUDGET = 6000;
export const EVIDENCE_BUDGET = 8000;

/**
 * Where the injected material starts.
 *
 * Everything the app adds to a user message -- retrieved passages, web
 * results, a fetched page, an attached file -- is appended after the question
 * behind one of these markers. So the split is positional rather than a list
 * of block types that has to be kept in step with whatever adds them: the
 * question is what was typed, and everything from the first marker on is what
 * the turn was given.
 */
const INJECTED = /\n\n--- (?:\[|Attached File:)/;

/** A user message, in its two halves. */
export const splitTurn = (content) => {
  const text = String(content || '');
  const match = INJECTED.exec(text);
  if (!match) return { question: text.trim(), injected: '' };
  return {
    question: text.slice(0, match.index).trim(),
    injected: text.slice(match.index).trim(),
  };
};

/**
 * What the turn was actually given.
 *
 * The injected blocks are stripped from the history by `wireHistory` on the
 * way out — they are re-derived each turn — but they are still in the user
 * message as it was sent, which is exactly where a check has to read them
 * from. This is the one place that *wants* the re-derived material.
 */
export const evidenceFor = (messages = [], index = 0) => {
  const parts = [];

  // Whatever was injected into the question that produced this answer.
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const { injected } = splitTurn(message.content);
    if (injected) parts.push(injected);
    break;
  }

  // Citations carry the passage or the page they came from.
  const answer = messages[index];
  for (const citation of answer?.citations || []) {
    const label = citation.docName || citation.url || '';
    const text = String(citation.text || '').trim();
    if (text) parts.push(`--- [Source] ${label} ---\n${text}`);
  }

  return parts.join('\n\n').slice(0, EVIDENCE_BUDGET);
};

/** The question this answer was an answer to. */
export const questionFor = (messages = [], index = 0) => {
  for (let i = index - 1; i >= 0; i--) {
    // Without what was injected into it: that is the evidence, not the
    // question, and leaving it in would make the question five hundred words
    // of search results.
    if (messages[i]?.role === 'user') return splitTurn(messages[i].content).question;
  }
  return '';
};

/**
 * What the checking model is given.
 *
 * Two shapes, because there are two different questions — see the note at the
 * top. The rules exist to stop the two commonest failures of a check like
 * this: agreeing with everything, and inventing an objection to look useful.
 */
export const verifyPrompt = ({ question, answer, evidence = '', language = '' }) => {
  const hasEvidence = evidence.trim().length > 0;

  const head = hasEvidence
    ? [
      'Check the answer below against the sources it was given. Do not use anything else you know.',
      '',
      `QUESTION: ${question}`,
      '',
      'SOURCES:',
      evidence,
    ]
    : [
      'The answer below was written from memory, with no sources.',
      'You cannot verify it — you would be checking memory against the same memory.',
      'Instead, find the claims in it that are specific enough to be wrong, and say which.',
      '',
      `QUESTION: ${question}`,
    ];

  return [
    ...head,
    '',
    'ANSWER:',
    answer.slice(0, ANSWER_BUDGET),
    '',
    'For each claim worth checking, write one line, exactly like this:',
    hasEvidence
      ? '[supported] "the exact words from the answer" — which source, and why'
      : '[unchecked] "the exact words from the answer" — why this one could be wrong and how to check it',
    ...(hasEvidence ? [
      '[unsupported] "the exact words from the answer" — no source says this',
      '[contradicted] "the exact words from the answer" — the source says otherwise, and what it says',
    ] : []),
    '',
    'Rules:',
    '- Quote the answer word for word inside the double quotes. A paraphrase cannot be found in the text and cannot be checked.',
    '- Only claims. Skip the framing, the hedges, and anything that is a matter of taste.',
    '- Say nothing about a claim you cannot decide. An invented objection is worse than a missing one.',
    hasEvidence
      ? '- "Not mentioned by any source" is unsupported, not contradicted. They are different findings.'
      : '- Do not mark anything as supported. There is nothing here to support it.',
    '- If nothing needs checking, write exactly: NOTHING TO CHECK',
    language ? `- Write the explanations in ${language}.` : '',
  ].filter(Boolean).join('\n');
};

const LINE = /^\s*[-*]?\s*\[(supported|unsupported|contradicted|unchecked)\]\s*["“](.+?)["”]\s*(?:[—–-]\s*)?(.*)$/i;

/**
 * Read the verdicts back.
 *
 * Line-based for the same reason the research planner is: a 7B asked for JSON
 * produces JSON most of the time, and the other times are a parse error at the
 * end of a slow pass. A malformed line here costs one verdict, not the page.
 */
export const parseVerdicts = (text) => {
  const body = String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  if (/NOTHING TO CHECK/i.test(body)) return [];

  const out = [];
  const seen = new Set();
  for (const line of body.split('\n')) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const quote = match[2].trim();
    // Two verdicts on the same words is the model repeating itself, which it
    // does when it has run out of things to say and has budget left.
    if (!quote || seen.has(quote.toLowerCase())) continue;
    seen.add(quote.toLowerCase());
    out.push({
      verdict: match[1].toLowerCase(),
      quote,
      note: match[3].trim(),
    });
  }
  return out;
};

/**
 * Whether each quoted claim is actually in the answer.
 *
 * A verdict about words the answer does not contain is a verdict about
 * something the checking model made up, and it is the single likeliest way
 * this whole feature misleads somebody. Marked rather than dropped: "the
 * checker quoted something that is not there" is itself worth seeing.
 */
export const locateQuotes = (verdicts = [], answer = '') => {
  const haystack = String(answer || '').toLowerCase().replace(/\s+/g, ' ');
  return verdicts.map(entry => ({
    ...entry,
    found: haystack.includes(entry.quote.toLowerCase().replace(/\s+/g, ' ')),
  }));
};

/** The one-line summary, and whether it is worth reading the detail. */
export const summariseVerdicts = (verdicts = []) => {
  const count = (kind) => verdicts.filter(v => v.verdict === kind).length;
  const problems = count('unsupported') + count('contradicted');
  return {
    total: verdicts.length,
    supported: count('supported'),
    unsupported: count('unsupported'),
    contradicted: count('contradicted'),
    unchecked: count('unchecked'),
    problems,
    // Not "the answer is wrong". A claim no source covers is very often true
    // and simply outside what this turn was given.
    //
    // And `supported > 0` is load-bearing: without it, a pass whose every
    // verdict is "unchecked" -- which is every pass on an answer written from
    // memory -- would report itself as clean. "Nothing was found wrong" and
    // "nothing was checked" are opposite findings that happen to have the same
    // problem count.
    clean: problems === 0 && count('supported') > 0,
  };
};
