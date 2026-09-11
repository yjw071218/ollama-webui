// What each model actually does on this machine.
//
// Ollama reports precise numbers at the end of every generation and the app
// showed two of them under the answer, then forgot them. That is the wrong way
// round: a single answer's speed is noise — it depends on what else the GPU
// was doing, whether the model had just been loaded, and how long the prompt
// was — while the same measurement taken forty times is the only honest way to
// answer the question people actually have, which is "which of these models is
// worth running here".
//
// The numbers are worth keeping because they are not guessable. A 30B model
// that spills out of VRAM can be twenty times slower than one that fits, and
// nothing about the file size says which side of the line it falls on for a
// particular machine. Published benchmarks are someone else's hardware.
//
// Kept in this browser, per profile, and never synced: it describes a machine,
// not an account, and an account's copy would mix two computers' numbers into
// one meaningless average.

const KEY = 'perfRuns';
const LIMIT = 400;

/* What Ollama gives back, and what each part means:
 *
 *   load_duration        loading the weights. Zero once the model is resident,
 *                        tens of seconds when it is not — which is the whole
 *                        of the "why was the first message so slow" question.
 *   prompt_eval_duration reading the prompt. Grows with the conversation, and
 *                        is what makes a long chat feel slower than a new one
 *                        even though the answer is the same length.
 *   eval_duration        writing the answer. The number people mean by
 *                        "tokens per second".
 *   ttft                 measured here rather than reported: the wall clock
 *                        from pressing send to the first visible character.
 *                        It is the one that decides whether a model feels
 *                        responsive, and it is the sum of the two above.
 */

const readAll = (scopedKey) => {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    return [];
  }
};

/**
 * Record one finished generation.
 *
 * Silently ignores a run with no usable numbers: a turn stopped part-way, or a
 * model that reports no timings, would otherwise drag every average down with
 * a zero.
 */
export const recordRun = (scopedKey, run) => {
  if (!run || !run.model) return;
  const tokensPerSec = Number(run.tokensPerSec);
  if (!Number.isFinite(tokensPerSec) || tokensPerSec <= 0) return;

  const entry = {
    at: Date.now(),
    model: run.model,
    tokensPerSec,
    // Milliseconds throughout, because seconds-with-two-decimals reads as a
    // measurement and nanoseconds read as an integer nobody can compare.
    ttft: Number.isFinite(run.ttft) ? Math.round(run.ttft) : null,
    load: Number.isFinite(run.load) ? Math.round(run.load) : null,
    promptEval: Number.isFinite(run.promptEval) ? Math.round(run.promptEval) : null,
    outTokens: Number.isFinite(run.outTokens) ? run.outTokens : null,
    inTokens: Number.isFinite(run.inTokens) ? run.inTokens : null,
  };

  const runs = readAll(scopedKey);
  runs.push(entry);
  try {
    localStorage.setItem(scopedKey, JSON.stringify(runs.slice(-LIMIT)));
  } catch (err) { /* quota; the next write will find less to save */ }
};

export const loadRuns = (scopedKey) => readAll(scopedKey);

export const clearRuns = (scopedKey) => {
  try { localStorage.removeItem(scopedKey); } catch (err) { /* private mode */ }
};

/**
 * The middle value, not the mean.
 *
 * Generation speed has a long tail in one direction only: a run that happened
 * while something else wanted the GPU can be several times slower than usual,
 * and there is no equivalent run that is several times faster. A mean tracks
 * those outliers; a median describes the run you are actually going to get.
 */
export const median = (numbers) => {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * One row per model, ordered fastest first.
 *
 * `coldLoads` counts the runs that had to load the weights — the ones that
 * feel slow for a reason that has nothing to do with the model's speed. Shown
 * separately rather than folded in, because a model that is fast to run and
 * slow to load is a different proposition from one that is simply slow.
 */
export const summarise = (runs) => {
  const byModel = new Map();
  for (const run of runs) {
    if (!byModel.has(run.model)) byModel.set(run.model, []);
    byModel.get(run.model).push(run);
  }

  const rows = [...byModel.entries()].map(([model, entries]) => {
    const loads = entries.map(e => e.load).filter(v => Number.isFinite(v) && v > 0);
    return {
      model,
      runs: entries.length,
      tokensPerSec: median(entries.map(e => e.tokensPerSec)),
      ttft: median(entries.map(e => e.ttft).filter(Number.isFinite)),
      promptEval: median(entries.map(e => e.promptEval).filter(Number.isFinite)),
      coldLoads: loads.length,
      loadTime: median(loads),
      lastUsed: Math.max(...entries.map(e => e.at)),
      totalTokens: entries.reduce((sum, e) => sum + (e.outTokens || 0), 0),
    };
  });

  return rows.sort((a, b) => (b.tokensPerSec || 0) - (a.tokensPerSec || 0));
};

/**
 * Does this conversation's length appear to be slowing it down?
 *
 * Reading the prompt is work that grows with the conversation while the answer
 * stays the same size, so a long chat gets slower in a way that looks like the
 * model getting worse. Comparing the newest runs against the oldest for the
 * same model is enough to say so — and if it is true, compacting the chat is
 * the fix rather than changing model.
 *
 * Deliberately conservative: it wants a real sample on both sides and a large
 * difference before saying anything, because "your chat is too long" is
 * unwelcome advice to receive wrongly.
 */
export const promptCostTrend = (runs, model) => {
  const mine = runs.filter(r => r.model === model && Number.isFinite(r.promptEval));
  if (mine.length < 8) return null;

  const third = Math.floor(mine.length / 3);
  const early = median(mine.slice(0, third).map(r => r.promptEval));
  const late = median(mine.slice(-third).map(r => r.promptEval));
  if (!early || !late || early < 50) return null;

  const ratio = late / early;
  return ratio >= 2 ? { early, late, ratio } : null;
};
