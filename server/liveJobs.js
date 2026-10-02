/**
 * What this server has queued, and who for.
 *
 * Its own module because three kinds of work end up here -- pictures and video
 * from ComfyUI (server/studio.js), what is done *to* a picture, and songs from
 * ACE-Step (server/music.js) -- and one register is the difference between
 * "what is this machine doing" having an answer and having three.
 *
 * ## Why it is in the database
 *
 * Reported first as: a picture started on the desktop, the phone opened while
 * it was drawing, and the phone showed an empty bubble with three dots for the
 * whole two minutes. Nothing was broken on the phone -- the job was running,
 * and `/studio/events` would have streamed every step of it to anyone who
 * asked. It just had no way to learn the id: the browser that queues a job
 * keeps that id in its own localStorage, which is exactly the one thing that
 * does not travel between devices. So a job writes down which conversation it
 * is for, here, where any device signed into the same account can ask.
 *
 * That register was a Map, on the reasoning that losing it on a restart costs
 * a progress bar and not a picture. Which is true and still leaves the wrong
 * thing happening: **the work outlives this process**. ComfyUI goes on drawing
 * across a restart of this app -- and `npm start` after an edit is a restart --
 * so what was lost was the phone's card, the answer to "what is being made",
 * and the notification when it finished. The job itself carried on, unwatched
 * and unannounced.
 *
 * So the register is a table, and at startup it is reconciled against ComfyUI's
 * own queue: anything no longer running or waiting there is finished, and it is
 * the queue that knows, not this process's memory.
 */

import { database } from './db.js';

/* Half an hour. A job this server never heard the end of -- ComfyUI killed, a
   browser closed mid-generation, a reconcile that could not reach ComfyUI --
   must not leave a card counting up on a phone for the rest of the day. */
const LIVE_MEMORY_MS = 30 * 60 * 1000;
const LIVE_MAX = 32;

const pruneLive = (now) => {
  const db = database();
  db.prepare('DELETE FROM live_jobs WHERE ? - started_at > ?').run(now, LIVE_MEMORY_MS);
  /* Oldest out first, the same rule the Map had, so one runaway caller cannot
     fill the table. `rowid` breaks the tie: several jobs queued inside one
     millisecond have the same `started_at`, and without it which of them was
     dropped came down to whatever order SQLite felt like. */
  db.prepare(`
    DELETE FROM live_jobs WHERE id IN (
      SELECT id FROM live_jobs ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )
  `).run(LIVE_MAX);
};

const rowToJob = (row) => (row ? {
  id: row.id,
  owner: row.user_id,
  chat: row.chat,
  kind: row.kind,
  prompt: row.prompt,
  model: row.model,
  aspect: row.aspect ?? null,
  startedAt: row.started_at,
} : null);

/* Every job this server queued, not only the ones a conversation asked for.
   The chat-less ones -- the Studio panel's own work -- are here for
   `/studio/queue`, which is the one place where "what is ComfyUI actually
   working on" is the question. They are never returned by `liveJobsFor`,
   which matches on a conversation and so can never match them. */
export const rememberLiveJob = (job, now = Date.now()) => {
  if (!job?.id) return null;
  const entry = {
    id: String(job.id),
    // Which account queued it. '' is the guest, which is the same scope the
    // rest of the app gives a browser that has not signed in.
    owner: String(job.owner || ''),
    chat: String(job.chat || ''),
    kind: job.kind || 'image',
    prompt: String(job.prompt || ''),
    model: job.model || '',
    aspect: Number(job.aspect) > 0 ? Number(job.aspect) : null,
    startedAt: now,
  };
  database().prepare(`
    INSERT INTO live_jobs (id, user_id, chat, kind, prompt, model, aspect, started_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id, chat = excluded.chat, kind = excluded.kind,
      prompt = excluded.prompt, model = excluded.model, aspect = excluded.aspect
  `).run(entry.id, entry.owner, entry.chat, entry.kind, entry.prompt, entry.model, entry.aspect, entry.startedAt);
  pruneLive(now);
  return entry;
};

/** It finished, failed, or was taken out of the queue. Either way it is not live. */
export const forgetLiveJob = (id) =>
  database().prepare('DELETE FROM live_jobs WHERE id = ?').run(String(id || '')).changes > 0;

/**
 * What is running in one conversation, for the account asking.
 *
 * Both halves are checked. The chat id alone is not a secret -- it is a
 * counter -- so without the owner an account could ask what another one was
 * drawing, and the prompt is in the answer.
 */
export const liveJobsFor = (owner, chat, now = Date.now()) => {
  pruneLive(now);
  if (!chat) return [];
  return database()
    // Oldest first, and inserted-first within a millisecond -- see `pruneLive`.
    .prepare('SELECT * FROM live_jobs WHERE user_id = ? AND chat = ? ORDER BY started_at ASC, rowid ASC')
    .all(String(owner || ''), String(chat))
    .map(rowToJob);
};

/**
 * What is known about the ids in ComfyUI's queue, for the account asking.
 *
 * The queue itself is ComfyUI's answer and is the same for everybody: it is a
 * list of prompt ids. This is the half that turns an id into a line somebody
 * can read -- what it is drawing, which model, whose it is -- and it is given
 * only for the account that queued it. Another account's job is still in the
 * list, because it is still in front of yours and that is the useful fact; what
 * it is a picture of is not theirs to tell.
 */
export const describeQueued = (owner, id, now = Date.now()) => {
  pruneLive(now);
  const job = rowToJob(database().prepare('SELECT * FROM live_jobs WHERE id = ?').get(String(id || '')));
  if (!job || job.owner !== String(owner || '')) return null;
  return { kind: job.kind, prompt: job.prompt, model: job.model, chat: job.chat, startedAt: job.startedAt };
};

/**
 * Drop everything ComfyUI is no longer working on.
 *
 * Called once at startup with the ids ComfyUI says are running or waiting. A
 * job that survived this process but finished while it was down is in the
 * table and in nobody's queue, and without this it would offer a phone a
 * progress bar for a picture that is already in the conversation.
 *
 * Only ComfyUI's jobs are judged: a song is ACE-Step's and is not in that
 * queue, so it keeps its half-hour. Returns how many were dropped.
 */
export const reconcileLiveJobs = (queuedIds, { kinds = ['image', 'video', 'edit'] } = {}) => {
  const alive = new Set((queuedIds || []).map(String));
  const rows = database().prepare('SELECT id, kind FROM live_jobs').all();
  let dropped = 0;
  for (const row of rows) {
    if (!kinds.includes(row.kind) || alive.has(String(row.id))) continue;
    forgetLiveJob(row.id);
    dropped += 1;
  }
  return dropped;
};

/** For the tests. */
export const forgetLiveJobs = () => { database().prepare('DELETE FROM live_jobs').run(); };
