/**
 * A question that could not be sent, kept rather than lost.
 *
 * The failure this exists for is ordinary and happens weekly: the phone is on
 * the far side of the house and the wifi drops for four seconds, or Ollama is
 * still loading a 30B model and refuses the connection, or the laptop went to
 * sleep. What the app did was replace the answer with `**Error:** Failed to
 * fetch` — and the question you had just spent two minutes writing was gone,
 * because it had already been cleared from the composer.
 *
 * So a failed send is written down. It survives a reload, because the failures
 * that matter most are the ones where you give up and refresh; and it retries
 * on its own when the network comes back, because the moment connectivity
 * returns is exactly when nobody is watching.
 *
 * Deliberately not a general job queue. One question per entry, retried in
 * order, given up on after a few attempts and then left visible for you to
 * decide about — the alternative being an app that silently sends something
 * you wrote an hour ago.
 */

const KEY = 'sendQueue';

/** Attempts before it stops trying and waits to be asked. */
export const MAX_ATTEMPTS = 4;

/**
 * How long to wait before attempt `n`.
 *
 * Doubling, from two seconds, capped at half a minute. The cap matters more
 * than the curve: a laptop that is asleep will not wake sooner for being asked
 * every four minutes, and a person watching wants to see it try again while
 * they are still looking at it.
 */
export const backoffMs = (attempt) => Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempt - 1)));

const scopedKey = (scope) => (scope ? `${KEY}@${scope}` : KEY);

export const loadQueue = (scope) => {
  try {
    const raw = localStorage.getItem(scopedKey(scope));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
};

export const saveQueue = (scope, queue) => {
  try {
    if (!queue.length) localStorage.removeItem(scopedKey(scope));
    else localStorage.setItem(scopedKey(scope), JSON.stringify(queue));
  } catch (e) {
    // Out of quota. The queue is a convenience; losing it is not worth
    // throwing from a catch block that is already handling a failure.
  }
};

/**
 * Should this failure be retried at all?
 *
 * Only the ones that might work next time. A network error, a refused
 * connection, a gateway timeout, a model still loading: those are worth
 * waiting on. A 400 because the request was malformed will be malformed again
 * in four seconds, and retrying it four times only delays telling you.
 *
 * Aborting is not a failure — it is the stop button — and must never queue.
 */
export const isRetryable = (error) => {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  const status = Number(error.status || 0);
  if (status) {
    // 408 request timeout, 429 too many, 5xx server side.
    return status === 408 || status === 429 || status >= 500;
  }
  const text = String(error.message || error).toLowerCase();
  return /failed to fetch|networkerror|network error|load failed|econnrefused|econnreset|etimedout|timeout|unreachable|502|503|504/.test(text);
};

/** A queue entry from a turn that failed. */
export const makeEntry = ({ sessionId, model, text, attachments = [], at = Date.now() }) => ({
  id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
  sessionId,
  model,
  text,
  // Images are data URLs and a queue in localStorage is not the place for
  // several megabytes of them, so only what is small enough to be worth
  // keeping travels. The rest is described, so the retry can say what it lost.
  attachments: attachments.filter(a => a?.type === 'text' || a?.type === 'pasted'),
  droppedAttachments: attachments.filter(a => !(a?.type === 'text' || a?.type === 'pasted')).map(a => a?.name).filter(Boolean),
  attempts: 0,
  at,
  lastError: '',
});

export const enqueue = (scope, entry) => {
  const queue = loadQueue(scope);
  queue.push(entry);
  saveQueue(scope, queue);
  return queue;
};

export const removeEntry = (scope, id) => {
  const queue = loadQueue(scope).filter(e => e.id !== id);
  saveQueue(scope, queue);
  return queue;
};

export const noteAttempt = (scope, id, error, at = Date.now()) => {
  const queue = loadQueue(scope).map(e => (
    e.id === id
      ? {
          ...e,
          attempts: (e.attempts || 0) + 1,
          // Read by `nextDue` to space the retries out. Without it every
          // attempt would be due the instant the last one failed, and four
          // attempts would burn through in the time it takes wifi to notice
          // it has dropped.
          lastTriedAt: at,
          lastError: String(error?.message || error || '').slice(0, 200),
        }
      : e
  ));
  saveQueue(scope, queue);
  return queue;
};

/**
 * The next entry worth trying, and nothing if none is.
 *
 * `now` is a parameter so this is a pure function of the queue and the clock,
 * which is the only way to test a backoff without waiting for it.
 */
export const nextDue = (queue, now = Date.now()) => (
  (queue || [])
    .filter(e => (e.attempts || 0) < MAX_ATTEMPTS)
    .find(e => {
      // Never tried: due now, and said so rather than left to arithmetic.
      // Treating an absent `lastTriedAt` as zero happens to give the right
      // answer against a real clock only because `Date.now()` is enormous —
      // which is not a reason, it is a coincidence, and it is exactly the kind
      // that stops being true the moment anything passes a smaller clock in.
      if (!e.lastTriedAt) return true;
      return now - e.lastTriedAt >= backoffMs(e.attempts || 0);
    })
  || null
);

/** Entries that have run out of attempts and are waiting to be asked about. */
export const stalled = (queue) => (queue || []).filter(e => (e.attempts || 0) >= MAX_ATTEMPTS);
