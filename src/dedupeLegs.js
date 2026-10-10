/*
 * One answer, stored more than once.
 *
 * Seen in a saved chat: the moment an agy answer finished, the completed reply
 * was appended three times within a millisecond and once more nine seconds
 * later, after the half-written copy -- five assistant messages for one
 * question (two writers of the same job, each appending). Whatever appends
 * them, the transcript should not show it: consecutive assistant messages
 * from the same run (same cliStarted.startedAt), or with identical text, are
 * one answer. The most complete copy is kept: finished over unfinished, then
 * the longer, then the later.
 */
const runOf = (m) => m?.cliStarted?.startedAt ?? null;
const better = (a, b) => {
  const done = (m) => (m.metrics ? 1 : 0) + (m.cliActivity ? 0 : 1);
  if (done(b) !== done(a)) return done(b) > done(a) ? b : a;
  const la = String(a.content || '').length, lb = String(b.content || '').length;
  return lb >= la ? b : a;
};
const strip = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
const sameAnswer = (a, b) => {
  if (a?.role !== 'assistant' || b?.role !== 'assistant') return false;
  const ra = runOf(a), rb = runOf(b);
  if (ra != null && ra === rb) return true;
  const ta = strip(a.content), tb = strip(b.content);
  return ta.length > 40 && (ta === tb || (tb.startsWith(ta) && !a.metrics) || (ta.startsWith(tb) && !b.metrics));
};

export const dedupeLegs = (messages) => {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const out = [];
  let changed = false;
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && sameAnswer(prev, m)) { out[out.length - 1] = better(prev, m); changed = true; continue; }
    out.push(m);
  }
  return changed ? out : messages;
};

export const dedupeSession = (s) => {
  if (!s || !Array.isArray(s.messages)) return s;
  const messages = dedupeLegs(s.messages);
  return messages === s.messages ? s : { ...s, messages };
};
