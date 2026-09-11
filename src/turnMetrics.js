/**
 * What a turn cost, when a turn is more than one request.
 *
 * The footer under a reply — `12.4s · 31.4 tokens/s · 222 + 100 tok` — used to
 * read `group[group.length - 1].metrics`, the last message in the run of
 * bubbles that make up one answer. That is right exactly when an answer is one
 * request, and an answer stops being one request the moment the model calls a
 * tool: the run then ends with a tool result (which has no metrics) or with a
 * second reply (whose metrics describe only the last leg).
 *
 * So the numbers appeared when the first leg finished and vanished a tenth of
 * a second later when the tool result was appended — and if they came back at
 * all they said "3.0s" about a turn that had taken fifteen.
 *
 * A turn is the whole thing, so this adds the legs up. The three fields are
 * combined differently on purpose:
 *
 *   * time is summed, because that is what the reader waited;
 *   * the rate is weighted by how long each leg spent generating, so a
 *     five-token leg does not count as much as a five-hundred-token one;
 *   * the prompt size is the *last* leg's rather than the sum, because it is
 *     read as "how full is the context now" — the composer's context gauge
 *     uses the same field — and adding the legs would count one conversation
 *     several times over.
 */

const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Fold one group of messages into the numbers to show under it.
 *
 * Returns null when no leg was measured, which is what the caller wants: a
 * stream that was stopped part-way has nothing honest to report.
 */
export const turnMetrics = (group) => {
  const legs = (Array.isArray(group) ? group : [])
    .map(m => m?.metrics)
    .filter(m => m && (m.totalTime != null || m.tokensPerSec != null || m.promptTokens != null));

  if (legs.length === 0) return null;
  if (legs.length === 1) return legs[0];

  const evalCount = legs.reduce((n, m) => n + count(m.evalCount), 0);

  // `evalCount / tokensPerSec` recovers the seconds that leg spent generating,
  // which is the weight the average needs and the only one we still have —
  // Ollama's `eval_duration` is not kept per message.
  const generating = legs.reduce((n, m) => {
    const rate = num(m.tokensPerSec);
    const tokens = count(m.evalCount);
    return rate > 0 && tokens > 0 ? n + tokens / rate : n;
  }, 0);

  const last = legs[legs.length - 1];
  const summed = (field) => {
    const values = legs.map(m => m[field]).filter(v => Number.isFinite(v));
    return values.length ? values.reduce((a, b) => a + b, 0) : last[field];
  };

  return {
    ...last,
    totalTime: legs.reduce((n, m) => n + num(m.totalTime), 0).toFixed(2),
    tokensPerSec: generating > 0 && evalCount > 0 ? (evalCount / generating).toFixed(2) : null,
    evalCount,
    promptTokens: last.promptTokens,
    // One estimated leg makes the total an estimate: a sum of a measurement
    // and a guess is a guess, and the footer marks it as one.
    estimated: legs.some(m => m.estimated),
    // When the reader first saw anything, which is the first leg's business
    // and not the last one's.
    ttft: legs.find(m => Number.isFinite(m.ttft))?.ttft ?? last.ttft,
    load: summed('load'),
    promptEval: summed('promptEval'),
    // How many requests this took. The footer says so when it is more than
    // one, because "18.3s" for a single question otherwise looks like a lie.
    legs: legs.length,
  };
};
