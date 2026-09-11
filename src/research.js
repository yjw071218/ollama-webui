/**
 * Deep research: a question answered by going and finding out.
 *
 * The web-search that already exists runs one query, drops five snippets in
 * front of the model and asks it to answer. That is fine for "what time is the
 * match" and useless for "should I use X or Y", because the answer to the
 * second is not on any one page — it is assembled from several, and the useful
 * part is the assembly.
 *
 * So this is a loop rather than a lookup:
 *
 *   1. **Plan.** Ask the model to break the question into a handful of
 *      sub-questions. This is the step that makes the difference: a question
 *      worth researching is one whose search terms are not obvious from its
 *      wording, and planning is where "is X faster than Y" becomes "X
 *      benchmark", "Y benchmark", "X Y comparison".
 *   2. **Search** each sub-question.
 *   3. **Read** the most promising pages — actually fetch them, rather than
 *      trusting a search snippet, which is written by whoever wanted the
 *      click.
 *   4. **Write**, with every claim carrying the number of the source it came
 *      from, and the sources listed.
 *
 * ## Why the steps are values rather than console output
 *
 * A run takes minutes on a local model. Something that prints to a log and
 * returns at the end is something nobody can tell from a hang, so every step
 * is reported as it happens and the caller renders it — see `runResearch`'s
 * `onStep`. It is also what makes the work checkable afterwards: the report
 * says what it searched for and what it read, so a wrong answer can be traced
 * to the page that was wrong rather than being a mystery.
 *
 * ## What this deliberately does not do
 *
 * It does not recurse. A sub-question does not spawn its own sub-questions,
 * because the depth that buys is small and the cost is not: two levels of five
 * is twenty-five searches and twenty-five page loads, which on a local model is
 * long enough that nobody waits for it. Breadth once, then write.
 */

/** How much of a fetched page is worth keeping per source. */
export const PAGE_BUDGET = 4000;

/** Ceilings, so a run is long rather than unbounded. */
export const LIMITS = {
  questions: 6,
  resultsPerQuestion: 5,
  pagesPerQuestion: 2,
  totalPages: 10,
};

export const DEPTHS = {
  quick: { questions: 2, pagesPerQuestion: 1, totalPages: 3 },
  normal: { questions: 4, pagesPerQuestion: 2, totalPages: 7 },
  thorough: { questions: 6, pagesPerQuestion: 2, totalPages: 10 },
};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export const planFor = (depth) => {
  const chosen = DEPTHS[depth] || DEPTHS.normal;
  return {
    questions: clamp(chosen.questions, 1, LIMITS.questions),
    resultsPerQuestion: LIMITS.resultsPerQuestion,
    pagesPerQuestion: clamp(chosen.pagesPerQuestion, 1, LIMITS.pagesPerQuestion),
    totalPages: clamp(chosen.totalPages, 1, LIMITS.totalPages),
  };
};

/**
 * What to ask the model for a plan.
 *
 * Asked for one question per line rather than JSON. A 7B model asked for JSON
 * produces JSON most of the time, and the times it does not are a parse error
 * at the start of a five-minute run. Lines cannot fail to parse; the worst
 * case is a bad question, which costs one search.
 */
export const planPrompt = (question, count, language) => [
  `Break this research question into ${count} search queries that together would answer it.`,
  '',
  `QUESTION: ${question}`,
  '',
  'Rules:',
  '- One query per line, nothing else. No numbering, no explanation, no blank lines.',
  '- Each query is what you would type into a search engine, not a sentence.',
  '- Cover different angles rather than rewording the same one.',
  language ? `- Write the queries in ${language} if the answer is likely to be found in it, otherwise in English.` : '',
  '',
  'Queries:',
].filter(Boolean).join('\n');

/**
 * Read a plan back.
 *
 * Models decorate lists whatever they are told, so the numbering, bullets and
 * quotes come off here rather than being forbidden harder in the prompt.
 */
export const parsePlan = (text, count) => {
  const lines = String(text || '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    .split('\n')
    .map(line => line
      .replace(/^\s*[-*•]\s+/, '')
      .replace(/^\s*\d+[.)]\s*/, '')
      .replace(/^["'`]|["'`]$/g, '')
      .trim())
    // Two, not three: "AI" and "C#" are real queries. A single character is
    // not one, and is what a stray bullet or a numbering artefact leaves.
    .filter(line => line.length >= 2 && line.length <= 200)
    // A model that ignores "no explanation" tends to add a sentence about what
    // it is about to do. A query does not end in a colon.
    .filter(line => !/^(here|these|i will|sure|okay|queries)\b/i.test(line))
    .filter(line => !line.endsWith(':'));

  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique.slice(0, count);
};

/**
 * Which steps are worth showing.
 *
 * Every step is reported twice -- once as it starts, once as it finishes --
 * because the UI needs the first to say what is happening now and the second
 * to say what happened. A list that renders both is twice as long and says
 * nothing extra, so the start is dropped once its own completion has arrived.
 * The one still in flight stays: it is the only line worth watching.
 */
export const visibleSteps = (steps = []) => {
  const key = (step) => `${step.kind}\u0000${step.url || step.query || ''}`;
  return steps.filter((step, i) => {
    if (step.state !== 'running') return true;
    return !steps.some((other, j) => j > i && other.state !== 'running' && key(other) === key(step));
  });
};

/** One numbered source, as the report will cite it. */
const asSource = (result, text) => ({
  url: result.url,
  title: result.title || result.url,
  snippet: result.snippet || '',
  text: text || '',
  read: !!text,
});

/**
 * Which results are worth actually fetching.
 *
 * A page already read for another sub-question is skipped rather than fetched
 * twice: research questions overlap by design, so the same three pages come
 * back for several of them, and re-reading is the difference between a run
 * that takes two minutes and one that takes six.
 */
export const worthReading = (results, alreadyRead, limit) => {
  const out = [];
  for (const result of results) {
    if (out.length >= limit) break;
    if (!result?.url || alreadyRead.has(result.url)) continue;
    out.push(result);
  }
  return out;
};

/**
 * How many snippet-only sources are worth carrying into the brief.
 *
 * Every search result becomes a source whether or not it could be read, which
 * is right — a snippet is weak evidence rather than none. But six queries at
 * five results each is thirty of them, and thirty snippets in front of a model
 * that read seven pages is thirty invitations to cite the thing it did not
 * read. The pages are the research; a handful of snippets is context.
 */
export const UNREAD_BUDGET = 6;

/** Read pages first, then a few snippets, and nothing after that. */
export const forTheBrief = (sources, unreadBudget = UNREAD_BUDGET) => {
  const read = sources.filter(s => s.read);
  const unread = sources.filter(s => !s.read).slice(0, unreadBudget);
  return [...read, ...unread];
};

/**
 * What the model is given to write from.
 *
 * Numbered, because the numbers are the citations. The reader can press `[3]`
 * and see source three, so source three has to be the third thing here.
 */
export const buildBrief = (question, sources, language) => {
  const body = sources.map((source, i) => [
    `[${i + 1}] ${source.title}`,
    source.url,
    source.read ? source.text.slice(0, PAGE_BUDGET) : `(not read; search result only) ${source.snippet}`,
  ].join('\n')).join('\n\n---\n\n');

  return [
    `Write a researched answer to this question, using only the sources below.`,
    '',
    `QUESTION: ${question}`,
    '',
    'SOURCES:',
    body,
    '',
    'Rules:',
    '- Cite every claim with the source number in brackets, like [2]. A paragraph with no citation is not acceptable.',
    '- Where sources disagree, say so and cite both rather than picking one silently.',
    '- If the sources do not answer part of the question, say which part and stop. Do not fill it in from memory.',
    /* Without this, a question that asks for something to be *made* is refused.
       Asked to write a page using what the research turned up, a model told
       "use only the sources below" reported that none of the sources contained
       a finished page — which is true, and useless. Sources inform work; they
       do not have to already contain it. */
    '- If the question asks you to produce something — code, a plan, a comparison table —'
      + ' then produce it, using the sources for the facts and choices behind it. Cite the'
      + ' sources for those facts. Do not refuse on the grounds that no source contains the'
      + ' finished artefact.',
    '- Lead with the answer. Put the reasoning under it, not before it.',
    language ? `- Write in ${language}.` : '',
  ].filter(Boolean).join('\n');
};

/**
 * Run the whole thing.
 *
 * Everything it talks to is injected: `ask` for a model turn, `search` for a
 * query, `fetchPage` for a URL. That is not ceremony — it is what makes this
 * testable without a network or a GPU, and this is precisely the kind of code
 * that is never exercised otherwise because running it for real takes minutes.
 *
 * `onStep` is called with each step as it starts and again as it finishes, so
 * the UI can show the work rather than a spinner.
 */
export const runResearch = async ({
  question,
  depth = 'normal',
  language = '',
  ask,
  search,
  fetchPage,
  onStep = () => {},
  signal,
}) => {
  const plan = planFor(depth);
  const steps = [];
  const step = (entry) => {
    const record = { at: Date.now(), ...entry };
    steps.push(record);
    onStep(record, steps);
    return record;
  };
  const stopped = () => signal?.aborted;

  /* ------------------------------------------------------------- 1. plan */

  step({ kind: 'plan', state: 'running', label: question });
  let queries = [];
  try {
    const planned = await ask(planPrompt(question, plan.questions, language), { signal });
    queries = parsePlan(planned, plan.questions);
  } catch (e) {
    if (stopped()) return { cancelled: true, steps, sources: [], report: '' };
  }
  // A model that produced nothing usable has still told us what to search for:
  // the question itself. One search is a worse answer than five, and much
  // better than an error.
  if (queries.length === 0) queries = [question];
  step({ kind: 'plan', state: 'done', queries });

  /* --------------------------------------------------- 2 and 3. find, read */

  const sources = [];
  const readUrls = new Set();
  const seenUrls = new Set();

  for (const query of queries) {
    if (stopped()) break;
    if (sources.length >= plan.totalPages * 2) break;

    const searching = step({ kind: 'search', state: 'running', query });
    let results = [];
    try {
      results = await search(query, plan.resultsPerQuestion);
    } catch (e) {
      searching.error = e.message;
    }
    step({ kind: 'search', state: 'done', query, found: results.length, error: searching.error || null });

    // Kept even when not read, so a run whose fetches all fail still has
    // something to cite -- a snippet is weak evidence, not no evidence.
    for (const result of results) {
      if (!result?.url || seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      sources.push(asSource(result, ''));
    }

    /* Every result this query turned up, in order, rather than only the first
       two. The budget below decides how many are actually read; the point of
       the longer list is that a refusal moves on to the next candidate instead
       of costing the query its whole allowance. A site that answers 403 to a
       reader is not a reason to research one page less. */
    const candidates = worthReading(results, readUrls, plan.resultsPerQuestion);
    let readHere = 0;

    for (const result of candidates) {
      if (stopped()) break;
      if (readHere >= plan.pagesPerQuestion) break;
      if (readUrls.size >= plan.totalPages) break;

      step({ kind: 'read', state: 'running', url: result.url, title: result.title });
      try {
        const page = await fetchPage(result.url, PAGE_BUDGET, signal);
        // A page that answered with nothing readable has not been read, and
        // counting it would spend the budget on an empty source.
        const text = page?.text || '';
        readUrls.add(result.url);
        const held = sources.find(s => s.url === result.url);
        if (held) { held.text = text; held.read = !!text; }
        if (text) readHere++;
        step({ kind: 'read', state: 'done', url: result.url, title: result.title, chars: text.length });
      } catch (e) {
        // Not added to `readUrls`: another query may turn the same page up and
        // a transient failure deserves the second attempt.
        step({ kind: 'read', state: 'failed', url: result.url, title: result.title, error: e.message });
      }
    }
  }

  if (stopped()) return { cancelled: true, steps, sources, report: '' };

  /* ------------------------------------------------------------ 4. write */

  // Read pages first: the numbering is the citation order, and a source the
  // model actually read should be [1] rather than [7]. The snippets that did
  // not get read are capped, because thirty of them behind seven real pages is
  // thirty invitations to cite something nobody opened.
  const ordered = forTheBrief([...sources].sort((a, b) => Number(b.read) - Number(a.read)));
  if (ordered.length === 0) {
    step({ kind: 'write', state: 'failed', error: 'nothing found' });
    return { steps, sources: [], report: '', empty: true };
  }

  step({ kind: 'write', state: 'running', sources: ordered.length });
  let report = '';
  try {
    report = await ask(buildBrief(question, ordered, language), { signal, long: true });
  } catch (e) {
    step({ kind: 'write', state: 'failed', error: e.message });
    return { steps, sources: ordered, report: '', failed: e.message };
  }
  step({ kind: 'write', state: 'done', chars: report.length });

  return {
    steps,
    sources: ordered,
    report,
    /* The shape the transcript's citation panel already understands, so `[3]`
       in the report is pressable without a second mechanism. */
    citations: ordered.map(s => ({
      url: s.url,
      docName: s.title,
      text: s.read ? s.text.slice(0, 1200) : s.snippet,
    })),
  };
};
