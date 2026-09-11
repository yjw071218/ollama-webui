/**
 * What has actually been done with this app.
 *
 * The system monitor answers "what is the machine doing". This answers the
 * other half of the same curiosity — what have *I* done — and the two are
 * genuinely different questions. A local model costs nothing per token, so
 * none of this is a bill; it is the record of a habit, and the useful parts
 * are the ones nobody can recall unaided:
 *
 *   * which of the eight installed models actually gets used, as opposed to
 *     which one was interesting enough to download;
 *   * whether the answers are getting slower over weeks, which no single
 *     turn's tokens-per-second can show;
 *   * when the work happens, which is the one figure that has ever made
 *     anybody change how they work;
 *   * how long the conversations run before they are abandoned.
 *
 * Everything is derived from the chats already in storage. Nothing new is
 * recorded, nothing is sent anywhere, and a chat that is deleted takes its
 * contribution with it — which is the only honest arrangement for a page whose
 * whole subject is the person reading it.
 *
 * ## Real counts where there are any
 *
 * Ollama reports `eval_count` and `prompt_eval_count` at the end of every
 * generation, and the app keeps them on the message. Those are the tokeniser's
 * own numbers and they are used wherever they exist. The estimate is only for
 * what has none — old messages, and everything the person typed — and it is
 * labelled as an estimate rather than quietly mixed in, because a total that
 * is half measured and half guessed should say so.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Roughly what a piece of text costs, for the messages carrying no count. */
export const estimateTokens = (text) => {
  if (!text) return 0;
  const str = String(text);
  let wide = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) wide++;
  }
  return Math.ceil((str.length - wide) / 4 + wide / 1.5);
};

/** Every message, flattened, with the chat it came from still attached. */
export const allMessages = (sessions = []) => {
  const out = [];
  for (const session of sessions || []) {
    if (!session || !Array.isArray(session.messages)) continue;
    // A draft has never been sent and is not a conversation yet.
    if (session.draft) continue;
    for (const message of session.messages) {
      if (!message || !message.role) continue;
      out.push({
        role: message.role,
        content: String(message.content || ''),
        // Undated messages predate timestamps. The chat's own date is the
        // closest true thing available, and dropping them would lose the
        // oldest history — which is exactly the part a trend needs.
        at: Number.isFinite(message.at) ? message.at : (session.createdAt || 0),
        model: message.model || session.lastModel || '',
        metrics: message.metrics || null,
        sessionId: session.id,
        title: session.title || '',
      });
    }
  }
  return out;
};

/** Tokens written by the model, measured where Ollama said so. */
const outTokensOf = (message) => {
  const counted = message.metrics?.evalCount ?? message.metrics?.outTokens;
  return Number.isFinite(counted) ? { tokens: counted, measured: true }
    : { tokens: estimateTokens(message.content), measured: false };
};

/**
 * The headline figures.
 *
 * `measuredShare` is reported rather than hidden: a total assembled from real
 * counts and estimates in unknown proportion is a number nobody should quote,
 * and one that says "84% measured" is.
 */
export const usageSummary = (sessions = [], now = Date.now()) => {
  const messages = allMessages(sessions);
  const answers = messages.filter(m => m.role === 'assistant');
  const asks = messages.filter(m => m.role === 'user');

  let outTokens = 0;
  let measured = 0;
  for (const answer of answers) {
    const { tokens, measured: real } = outTokensOf(answer);
    outTokens += tokens;
    if (real) measured++;
  }

  const chats = (sessions || []).filter(s => s && !s.draft && (s.messages || []).length > 0);
  const dates = messages.map(m => m.at).filter(Boolean);
  const speeds = answers
    .map(m => Number(m.metrics?.tokensPerSec))
    .filter(v => Number.isFinite(v) && v > 0);

  return {
    chats: chats.length,
    messages: messages.length,
    asks: asks.length,
    answers: answers.length,
    inTokens: asks.reduce((sum, m) => sum + estimateTokens(m.content), 0),
    outTokens,
    measuredShare: answers.length ? measured / answers.length : 0,
    firstAt: dates.length ? Math.min(...dates) : null,
    lastAt: dates.length ? Math.max(...dates) : null,
    // Not a mean: a run that happened while something else wanted the GPU is
    // several times slower than usual and there is no equally fast outlier to
    // balance it.
    medianSpeed: median(speeds),
    activeDays: new Set(messages.map(m => dayKey(m.at))).size,
    days: dates.length ? Math.max(1, Math.ceil((now - Math.min(...dates)) / DAY)) : 0,
  };
};

export const median = (numbers) => {
  const sorted = (numbers || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Local date, not UTC: the question is which day *you* were working. */
export const dayKey = (at) => {
  const d = new Date(at || 0);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * One row per day, including the days with nothing on them.
 *
 * The gaps are the point. A chart drawn only from the days that have data
 * shows a smooth line of constant activity no matter how sporadic the use
 * actually was, which is the opposite of what happened.
 */
export const activityByDay = (sessions = [], days = 30, now = Date.now()) => {
  const messages = allMessages(sessions);
  const counts = new Map();
  for (const message of messages) {
    const key = dayKey(message.at);
    const held = counts.get(key) || { messages: 0, chats: new Set() };
    held.messages++;
    held.chats.add(message.sessionId);
    counts.set(key, held);
  }

  const out = [];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(start.getTime() - i * DAY);
    const key = dayKey(day.getTime());
    const held = counts.get(key);
    out.push({ day: key, at: day.getTime(), messages: held?.messages || 0, chats: held?.chats.size || 0 });
  }
  return out;
};

/**
 * Which models are actually used.
 *
 * Sorted by answers rather than by tokens: the question behind this table is
 * "which of these am I keeping", and a model used twice for two enormous
 * answers is not one that has earned its disk space.
 */
export const byModel = (sessions = []) => {
  const answers = allMessages(sessions).filter(m => m.role === 'assistant' && m.model);
  const grouped = new Map();
  for (const answer of answers) {
    if (!grouped.has(answer.model)) grouped.set(answer.model, []);
    grouped.get(answer.model).push(answer);
  }

  const total = answers.length || 1;
  return [...grouped.entries()]
    .map(([model, entries]) => ({
      model,
      answers: entries.length,
      share: entries.length / total,
      outTokens: entries.reduce((sum, m) => sum + outTokensOf(m).tokens, 0),
      medianSpeed: median(entries.map(m => Number(m.metrics?.tokensPerSec)).filter(Number.isFinite)),
      lastUsed: Math.max(...entries.map(m => m.at)),
    }))
    .sort((a, b) => b.answers - a.answers);
};

/** Twenty-four buckets: when the work actually happens. */
export const byHour = (sessions = []) => {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: 0 }));
  for (const message of allMessages(sessions)) {
    if (!message.at) continue;
    hours[new Date(message.at).getHours()].messages++;
  }
  return hours;
};

/**
 * Is the same model getting slower over weeks?
 *
 * Compares the oldest third of its answers against the newest. Conservative
 * on purpose -- it wants a real sample on both sides and a difference big
 * enough not to be the weather -- because "your machine is degrading" is
 * unwelcome advice to receive wrongly. A driver change, a new background
 * process or a card that has started throttling all show up here first.
 */
export const speedDrift = (sessions = [], model = '') => {
  const speeds = allMessages(sessions)
    .filter(m => m.role === 'assistant' && (!model || m.model === model))
    .filter(m => Number.isFinite(Number(m.metrics?.tokensPerSec)))
    .sort((a, b) => a.at - b.at)
    .map(m => ({ at: m.at, value: Number(m.metrics.tokensPerSec) }));

  if (speeds.length < 12) return null;
  const third = Math.floor(speeds.length / 3);
  const early = median(speeds.slice(0, third).map(s => s.value));
  const late = median(speeds.slice(-third).map(s => s.value));
  if (!early || !late) return null;

  const ratio = late / early;
  if (ratio > 0.75 && ratio < 1.33) return null;
  return { early, late, ratio, direction: ratio < 1 ? 'slower' : 'faster', samples: speeds.length };
};

/** The conversations worth going back to, by how much is in them. */
export const biggestChats = (sessions = [], limit = 5) =>
  (sessions || [])
    .filter(s => s && !s.draft && (s.messages || []).length > 0)
    .map(s => ({
      id: s.id,
      title: s.title || '',
      messages: s.messages.length,
      tokens: s.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
      updatedAt: s.updatedAt || s.createdAt || 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);

/**
 * Consecutive days with something on them, counting back from today.
 *
 * Yesterday counts as unbroken: a streak that resets at midnight punishes
 * somebody for not having opened the app yet this morning, which is a
 * scoreboard rather than a fact about their use.
 */
export const streaks = (sessions = [], now = Date.now()) => {
  const active = new Set(allMessages(sessions).map(m => dayKey(m.at)));
  if (active.size === 0) return { current: 0, longest: 0 };

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  let current = 0;
  const startsToday = active.has(dayKey(today.getTime()));
  for (let i = startsToday ? 0 : 1; ; i++) {
    if (!active.has(dayKey(today.getTime() - i * DAY))) break;
    current++;
  }

  const sorted = [...active].sort();
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const key of sorted) {
    const at = new Date(`${key}T00:00:00`).getTime();
    run = previous !== null && at - previous === DAY ? run + 1 : 1;
    previous = at;
    if (run > longest) longest = run;
  }

  return { current, longest };
};
