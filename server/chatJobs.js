import { noteFinished, sendPush } from './push.js';

// Bounded replay storage. Conversation history is persisted separately.
export const CHAT_LIMITS = Object.freeze({
  maxJobs: 128, maxBytes: 32 * 1024 * 1024, maxJobBytes: 4 * 1024 * 1024,
  maxFrames: 16000, retentionMs: 30 * 60 * 1000, maxRunMs: 0, // No generation deadline; cancellation and memory limits remain.
});

export const createChatJobStore = ({ limits = {}, now = Date.now, onFinished = null } = {}) => {
  const cap = { ...CHAT_LIMITS, ...limits };
  const jobs = new Map();
  let bytes = 0;
  const remove = id => {
    const job = jobs.get(id);
    if (!job) return;
    bytes -= job.bytes;
    jobs.delete(id);
  };
  const finish = id => {
    const job = jobs.get(id);
    if (!job || job.finished) return;
    job.finished = true;
    job.updatedAt = now();
    delete job.controller;
    /* And the reader is told, if they asked to be and are not looking. This is
       the one place that knows an answer has ended without a browser having to
       be open to notice -- see server/push.js. Never allowed to throw: an
       answer that finished has finished, whatever the push service says. */
    try { onFinished?.(job); } catch (e) { /* the answer is not the notification */ }
  };
  const stop = (id, reason = 'Generation cancelled') => {
    const job = jobs.get(id);
    if (!job || job.finished) return false;
    const controller = job.controller;
    // Reserve a small terminal frame so a recovering browser can stop polling.
    const frame = { error: reason, done: true, done_reason: 'error' };
    const value = job.format === 'object' ? frame : '\n' + JSON.stringify(frame) + '\n';
    const size = Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
    job.frames.push(value);
    job.bytes += size;
    bytes += size;
    finish(id);
    try {
      if (typeof controller?.destroy === 'function') controller.destroy(new Error(reason));
      else controller?.abort();
    } catch { /* The job is terminal even if the upstream already closed. */ }
    return true;
  };
  const prune = () => {
    for (const [id, job] of jobs) {
      if (!job.finished && cap.maxRunMs > 0 && now() - job.startedAt >= cap.maxRunMs) stop(id, 'Generation exceeded the time limit');
      if (job.finished && now() - job.updatedAt >= cap.retentionMs) remove(id);
    }
  };
  const evictFinished = (extra = 0, needSlot = false, except = '') => {
    for (const [id, job] of jobs) {
      if (bytes + extra <= cap.maxBytes && (!needSlot || jobs.size < cap.maxJobs)) break;
      if (job.finished && id !== except) remove(id);
    }
  };
  /* `meta` is who the answer is being written for and which conversation it
     belongs to: `{ owner, chat }`. Both are optional and neither affects the
     replay -- they are what `live` matches on, so a second device of the same
     reader's can find an answer already being written and follow it as it is
     typed rather than waiting for the conversation to sync. See `live`. */
  const begin = (id, meta = null) => {
    if (!id) return null;
    prune();
    if (jobs.has(id)) {
      const held = jobs.get(id);
      // A job can be begun twice -- the same turn retried, a second reader of
      // the same id -- and the second call is where the metadata may finally
      // be known. Never unset: '' would make it unfindable.
      if (meta?.owner !== undefined && meta.owner !== '') held.owner = String(meta.owner);
      if (meta?.chat) held.chat = String(meta.chat);
      return held;
    }
    evictFinished(0, true);
    if (jobs.size >= cap.maxJobs) throw new Error('Too many retained chat jobs');
    const job = {
      id, frames: [], bytes: 0, finished: false, startedAt: now(), updatedAt: now(), format: 'string',
      owner: String(meta?.owner || ''), chat: String(meta?.chat || ''),
    };
    jobs.set(id, job);
    return job;
  };
  const append = (id, frame, format) => {
    // Late chunks must never recreate an evicted or cancelled job.
    const job = jobs.get(id);
    if (!job || job.finished) return false;
    job.format = format;
    const size = Buffer.byteLength(typeof frame === 'string' ? frame : JSON.stringify(frame));
    evictFinished(size + 1024, false, id);
    if (job.bytes + size > cap.maxJobBytes - 1024 || bytes + size > cap.maxBytes - 1024 * cap.maxJobs
      || job.frames.length >= cap.maxFrames) {
      stop(id, 'Generation stopped because the response memory limit was reached');
      return false;
    }
    job.frames.push(frame);
    job.bytes += size;
    bytes += size;
    job.updatedAt = now();
    if (format === 'object' && frame?.done) finish(id);
    return true;
  };
  return {
    begin, finish, stop, prune,
    attach: (id, controller) => {
      const job = jobs.get(id) || begin(id);
      if (job?.finished) throw new Error('Chat job already finished; use a new job ID');
      if (job?.controller) throw new Error('Chat job is already running');
      if (job) job.controller = controller;
    },
    appendFrame: (id, frame) => append(id, frame, 'object'),
    appendChunk: (id, chunk) => append(id, String(chunk), 'string'),
    read: id => { prune(); return jobs.get(id) || null; },
    /**
     * Answers still being written for one conversation, for the account asking.
     *
     * The reply to "is another of my devices in the middle of this chat?". A
     * finished job is not live: its answer is in the conversation by then and
     * travels the ordinary way. Newest first, because a chat that somehow has
     * two is a chat where the newer one is the one on screen.
     *
     * Both halves are matched. A chat id here is a counter, not a secret, so
     * the owner is what stops one account following another's answer.
     */
    live: (owner, chat) => {
      prune();
      return [...jobs.values()]
        .filter(job => !job.finished && job.chat && job.chat === String(chat || '')
          && job.owner === String(owner || ''))
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(job => ({ id: job.id, chat: job.chat, startedAt: job.startedAt, bytes: job.bytes }));
    },
    stats: () => ({ jobs: jobs.size, bytes }),
  };
};

/* The notification, wired here rather than at the three servers that call
   `finish`: one of them is the Ollama proxy, one is the card guard and one is
   the llama.cpp translation, and a fact only two of them report is a feature
   that works on some installs. */
const store = createChatJobStore({
  onFinished: (job) => {
    if (!job?.chat) return;
    noteFinished(job.owner, 'answer');
    sendPush(job.owner).catch(() => {});
  },
});
const sweep = setInterval(() => store.prune(), 30000);
sweep.unref?.();
export const beginChatJob = store.begin;
export const attachChatController = store.attach;
export const cancelChatJob = store.stop;
export const appendChatFrame = store.appendFrame;
export const appendChatChunk = store.appendChunk;
export const finishChatJob = store.finish;
export const readChatJob = store.read;
export const liveChatJobs = store.live;
export const replayChatJob = job => job.frames.map(frame =>
  typeof frame === 'string' ? frame : JSON.stringify(frame) + '\n').join('');

// A subscriber owns only this HTTP connection, never the model request.
// Byte offsets allow reconnecting even in the middle of a UTF-8 character.
export const followChatJob = (req, res, job, offset = 0) => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  let index = 0, skip = Math.max(0, Number(offset) || 0), blocked = false;
  const pump = () => {
    if (res.destroyed || blocked) return;
    while (index < job.frames.length) {
      const frame = job.frames[index++];
      let chunk = Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame) + '\n');
      if (skip >= chunk.length) { skip -= chunk.length; continue; }
      chunk = chunk.subarray(skip); skip = 0;
      if (!res.write(chunk)) { blocked = true; return; }
    }
    if (job.finished) { clearInterval(timer); res.end(); }
  };
  const timer = setInterval(pump, 40);
  timer.unref?.();
  res.on('drain', () => { blocked = false; pump(); });
  res.on('close', () => clearInterval(timer));
  res.on('error', () => clearInterval(timer));
  pump();
};
