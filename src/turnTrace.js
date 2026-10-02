/**
 * What a turn actually did, step by step.
 *
 * `src/turnMetrics.js` folds a turn into one line -- `12.4s ×3 · 31 tokens/s`.
 * That is the right summary and it is also the whole of what anybody could
 * find out. A turn is no longer one request: it can answer, call a search,
 * answer again, draw a picture in the middle of a sentence, and give the
 * graphics card back and take it again while doing it. When one takes two
 * minutes, "×3" is not an explanation of where the two minutes went.
 *
 * So this unfolds the same group of messages into the steps that made it. No
 * new data is recorded to do it: every leg already carries its own `metrics`
 * and `model`, every tool result already says which tools ran and which of
 * them failed, and the pictures are already on the message that drew them.
 * It was all there and nothing read it.
 *
 * Pure, and in its own file, for the reason `turnMetrics` is: the arithmetic
 * of "which leg was slow" has a wrong answer that looks perfectly reasonable
 * on screen, and a function that can only be exercised by rendering React
 * against a running model is one that never gets exercised.
 */

import { parseToolResults } from './toolResults.js';

const seconds = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

const whole = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * One step per thing that happened, in the order it happened.
 *
 * An `answer` step is one request to the model: which model, how long, how
 * many tokens and how fast, and whether those numbers were measured or are
 * this machine's own clock filling in for a server that did not say.
 *
 * A `tools` step is what ran between two answers. Failures are marked rather
 * than dropped: a turn that took ninety seconds because a search timed out
 * twice is exactly the turn somebody is asking about.
 *
 * Pictures belong to the answer whose call drew them -- `call` is stamped on
 * each when it is made -- and a picture from before that existed counts
 * towards the message it is on, which is where it has always been shown.
 */
export const traceOf = (group) => {
  const messages = Array.isArray(group) ? group : [];
  const steps = [];
  let answers = 0;

  for (const message of messages) {
    if (!message) continue;

    const isToolResult = message.role === 'user'
      && String(message.content || '').trim().startsWith('<TOOL_RESULT>');

    if (isToolResult) {
      const entries = parseToolResults(
        String(message.content).replace(/^\s*<TOOL_RESULT>/i, '').replace(/<\/TOOL_RESULT>\s*$/i, ''),
      );
      if (entries.length > 0) {
        steps.push({ kind: 'tools', tools: entries.map(e => ({ name: e.name, failed: !!e.failed })) });
      }
      continue;
    }

    if (message.role !== 'assistant') continue;

    answers += 1;
    const metrics = message.metrics || null;
    steps.push({
      kind: 'answer',
      leg: answers,
      model: message.model || '',
      seconds: seconds(metrics?.totalTime),
      tokens: whole(metrics?.evalCount),
      rate: seconds(metrics?.tokensPerSec),
      // A leg whose figures came from this machine's clock rather than from the
      // server. Marked everywhere else too; a trace that hid it would be the
      // one place implying they were measured.
      estimated: !!metrics?.estimated,
      pictures: (message.generated || []).length,
      songs: (message.songs || []).length,
      // Nothing was measured at all: a leg that was stopped, or one whose
      // whole output was a tool call.
      unmeasured: !metrics,
    });
  }

  return steps;
};

/**
 * The slowest answer in a turn, when there is a clear one.
 *
 * The question behind opening a trace is almost always "what took so long",
 * and on a turn of four legs that is a number to find by eye. Returns the leg
 * number, or null when nothing was measured or nothing stands out -- a leg is
 * only worth pointing at if it is most of the time spent.
 */
export const slowestLeg = (steps, share = 0.5) => {
  const answers = (steps || []).filter(s => s.kind === 'answer' && Number.isFinite(s.seconds));
  if (answers.length < 2) return null;
  const total = answers.reduce((n, s) => n + s.seconds, 0);
  if (total <= 0) return null;
  const worst = answers.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  // Strictly more than the share: two legs of equal length are not a turn with
  // a slow leg in it, and marking one of them would be an invention.
  return worst.seconds / total > share ? worst.leg : null;
};
