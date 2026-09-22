/**
 * Finding out whether a change helped.
 *
 * Everything in this app that alters an answer — the system prompt, the
 * sampling preset, the model, the retrieval settings that arrived with the
 * lexical half, whether reranking is on — is adjusted by trying it once and
 * deciding it felt better. On a machine where a reply takes forty seconds that
 * is one sample, read once, against a memory of the previous answer that is
 * already fading. It is not a measurement, and it is not even a fair
 * impression: the answer that was waited for longer is the one remembered as
 * better.
 *
 * So: a set of questions kept on purpose, run against whatever is being
 * changed, and scored. The apparatus already existed in pieces — `chains.js`
 * runs a sequence of prompts, `consensus.js` reads several answers at once,
 * `verify.js` grades an answer against evidence — and none of them held the
 * thing that is actually yours, which is *the questions you keep asking*.
 *
 * ## Judged against an expected answer, or not judged at all
 *
 * There is a version of this that asks a model "how good is this answer, out
 * of ten" with nothing to compare against. It produces a column of 7s and 8s
 * that moves with the answer's length and confidence rather than its
 * correctness, and a number that does not move when quality moves is worse
 * than no number, because it gets believed.
 *
 * A case therefore carries what a right answer contains — not the prose, which
 * nobody wants to write, but the facts it must have and, optionally, what it
 * must not say. Grading against that is a comparison, with both texts in front
 * of the model, which is the task small models are markedly better at. It is
 * the same observation `verify.js` is built on.
 *
 * A case with no expectation is still run and still shown, and is marked
 * unscored rather than given a number. Some questions are worth watching
 * without being gradeable, and a suite that refuses them is a suite people
 * stop adding to.
 *
 * ## The score is 0–3, and the rubric is the reason
 *
 * Wider scales do not survive contact with a small judge: ask for 0–100 and
 * the answers are 70, 85 and 90 whatever is in front of it. Four levels with
 * a sentence each is the most that can be asked for and got back reliably, and
 * the one distinction that earns its place is 1 against 0 — an answer that is
 * about the right thing and gets it wrong is not the same failure as an answer
 * that is about something else, and the two want different fixes.
 *
 * ## What a run is compared against
 *
 * The previous run of the same suite. Not an absolute threshold: "2.4 out of
 * 3" means nothing on its own, because it is a property of how hard the
 * questions are. What means something is that it was 2.1 before the system
 * prompt changed, and which four cases moved.
 */

/* The scale, with the rubric that makes the numbers repeatable. Written into
   the judge's prompt verbatim -- a rubric paraphrased in two places is two
   rubrics. */
export const SCALE = [
  '3 = correct and complete: every fact the expectation names is there, and nothing contradicts it',
  '2 = mostly right: the main point is correct, something named is missing or vague',
  '1 = on topic but wrong: it answers the right question with a wrong or unsupported answer',
  '0 = off topic, refused, empty, or contradicts the expectation outright',
];

export const MAX_SCORE = 3;

/** A case the judge cannot grade, because nothing said what right looks like. */
export const isScorable = (testCase) => Boolean(String(testCase?.expect || '').trim());

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    why: { type: 'string' },
  },
  required: ['score', 'why'],
};

export const judgeSchema = () => VERDICT_SCHEMA;

/**
 * What to ask the judge.
 *
 * The question is included as well as the expectation, because "complete"
 * cannot be decided without it: an expectation listing two facts does not say
 * whether a third was also asked for.
 *
 * `why` is required and capped at a sentence. Not decoration — it is the only
 * way to tell a case the model got wrong from a case whose *expectation* is
 * wrong, and on a suite anybody actually writes, several of them will be the
 * second. A score with no reason gets argued with; a score with a reason gets
 * one of the two fixed.
 */
export const buildJudgePrompt = (testCase, answer) => ([
  {
    role: 'system',
    content: [
      'You are marking one answer against what a correct answer must contain.',
      '',
      'Scale:',
      ...SCALE,
      '',
      'Mark only against the expectation. Do not use anything you know, do not',
      'reward length or confidence, and do not penalise an answer for saying',
      'more than was expected unless the extra part is wrong.',
      '',
      'Give one short sentence of reason. Name the specific thing that was',
      'missing or wrong, or say what made it complete.',
    ].join('\n'),
  },
  {
    role: 'user',
    content: [
      `QUESTION:\n${testCase.question}`,
      '',
      `A CORRECT ANSWER MUST CONTAIN:\n${testCase.expect}`,
      '',
      `THE ANSWER TO MARK:\n${String(answer || '').slice(0, 6000)}`,
    ].join('\n'),
  },
]);

/**
 * A verdict, out of whatever the model returned.
 *
 * A score outside the scale is clamped rather than dropped: a judge that says
 * 5 has said "as good as it gets" and throwing that away loses a real
 * judgement over a formatting mistake. A reply with no usable score at all is
 * `null`, which the caller shows as a failed marking rather than as a zero —
 * the difference between "this answer is bad" and "the marking did not
 * happen", which must never be flattened, because the first is a result and
 * the second is a bug.
 */
export const parseVerdict = (raw) => {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }
  const score = Number(parsed?.score);
  if (!Number.isFinite(score)) return null;
  return {
    score: Math.max(0, Math.min(MAX_SCORE, Math.round(score))),
    why: String(parsed?.why || '').trim().slice(0, 400),
  };
};

/**
 * What a run came to.
 *
 * `scored` and `total` are both reported because the mean is over the scored
 * cases only, and a suite whose expectations were half written would otherwise
 * look like it got a much better average than it did.
 */
export const summarise = (results) => {
  const rows = results || [];
  const scored = rows.filter(row => Number.isFinite(row?.score));
  const failed = rows.filter(row => row?.error).length;
  const unscored = rows.filter(row => !row?.error && !Number.isFinite(row?.score)).length;

  const sum = scored.reduce((total, row) => total + row.score, 0);
  const mean = scored.length ? sum / scored.length : null;

  return {
    total: rows.length,
    scored: scored.length,
    unscored,
    failed,
    mean,
    /* As a percentage of the best possible, because "2.4" needs the scale
       carried with it everywhere and "80%" does not. */
    percent: mean === null ? null : Math.round((mean / MAX_SCORE) * 100),
    perfect: scored.filter(row => row.score === MAX_SCORE).length,
    /* The cases worth looking at first. */
    worst: [...scored].sort((a, b) => a.score - b.score).slice(0, 5),
    ms: rows.reduce((total, row) => total + (row?.ms || 0), 0),
  };
};

/**
 * What changed between two runs.
 *
 * By case id, not by position: a suite gains and loses questions between runs
 * and comparing the fourth row of one against the fourth of the other is how a
 * deleted question makes every later case look like it moved.
 *
 * A case that only one run has is reported as such rather than counted as a
 * change, because it is not one.
 */
export const compareRuns = (before, after) => {
  const previous = new Map((before?.results || []).map(row => [row.caseId, row]));
  const current = new Map((after?.results || []).map(row => [row.caseId, row]));

  const moved = [];
  let better = 0;
  let worse = 0;
  let same = 0;

  for (const [caseId, now] of current) {
    const was = previous.get(caseId);
    if (!was) continue;
    if (!Number.isFinite(was.score) || !Number.isFinite(now.score)) continue;
    if (now.score > was.score) better++;
    else if (now.score < was.score) worse++;
    else { same++; continue; }
    moved.push({ caseId, from: was.score, to: now.score, question: now.question });
  }

  const beforeMean = summarise(before?.results).mean;
  const afterMean = summarise(after?.results).mean;

  return {
    better,
    worse,
    same,
    added: [...current.keys()].filter(id => !previous.has(id)).length,
    dropped: [...previous.keys()].filter(id => !current.has(id)).length,
    delta: beforeMean === null || afterMean === null ? null : afterMean - beforeMean,
    moved: moved.sort((a, b) => (a.to - a.from) - (b.to - b.from)),
  };
};

/** What was being tested, as one line, so a run says what it was. */
export const describeRun = (run) => [
  run?.model,
  run?.promptName ? `prompt: ${run.promptName}` : null,
  run?.settings?.temperature !== undefined ? `temp ${run.settings.temperature}` : null,
].filter(Boolean).join(' · ');

/** A stable-enough id, matching the one ingest.js uses. */
export const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A suite from a plain text file.
 *
 * Two lines per case — the question, then the expectation prefixed with `>` —
 * separated by blank lines. Chosen because a suite is written in whatever the
 * person already uses to keep notes, and a format that needs a UI to produce
 * is a format nobody fills in. It round-trips with `formatSuite`.
 */
export const parseSuite = (text) => {
  const cases = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const question = lines.filter(line => !line.startsWith('>')).join(' ').trim();
    const expect = lines.filter(line => line.startsWith('>')).map(line => line.slice(1).trim()).join(' ').trim();
    if (!question) continue;
    cases.push({ id: newId(), question, expect });
  }
  return cases;
};

export const formatSuite = (cases) => (cases || [])
  .map(row => `${row.question}${row.expect ? `\n> ${row.expect}` : ''}`)
  .join('\n\n');
