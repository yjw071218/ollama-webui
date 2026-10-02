/**
 * How long a workflow's nodes took last time, so the next run can say how far
 * along it is.
 *
 * The progress bar used to count nodes. These graphs have sixty of them and
 * three that matter: Krea 2's text encoder writing out a prompt (a minute, most
 * of it with nothing else to report), the sampler, and the PiD decoder. Counted
 * by node the bar was at 40% after the loaders -- five seconds in -- and "about
 * 8 seconds left" sat on the screen for two minutes.
 *
 * So each finished run leaves behind when each of its nodes started and how
 * long it took, per profile (a workflow at a size, and a length for video), and
 * a run in progress is placed on that timeline: the furthest node it has
 * finished, plus the share of the current one it has done. Blended rather than
 * replaced, so one cold start or one slow run moves the estimate without
 * becoming it.
 */

import fs from 'node:fs';
import path from 'node:path';

const KEEP = 0.6;           // how much of the old figure a new run keeps
const MAX_PROFILES = 60;

const blend = (old, sample) => (Number.isFinite(old) ? Math.round(old * KEEP + sample * (1 - KEEP)) : Math.round(sample));

/**
 * One finished run as a sample: its length, and each node's start and duration
 * in milliseconds from the start. Null for a run that cannot be timed.
 */
export const sampleOf = (job, endedAt) => {
  if (!job?.startedAt || !(endedAt > job.startedAt)) return null;
  const nodes = {};
  for (const [id, time] of Object.entries(job.nodeTimes || {})) {
    if (Number.isFinite(time?.start) && Number.isFinite(time?.dur)) nodes[id] = { start: time.start, dur: time.dur };
  }
  return { total: endedAt - job.startedAt, nodes };
};

/** A sample folded into what was known. */
export const blendHistory = (history, sample) => {
  const nodes = { ...(history?.nodes || {}) };
  for (const [id, time] of Object.entries(sample.nodes)) {
    const old = nodes[id];
    nodes[id] = { start: blend(old?.start, time.start), dur: blend(old?.dur, time.dur) };
  }
  return { runs: (history?.runs || 0) + 1, total: blend(history?.total, sample.total), nodes, at: Date.now() };
};

/**
 * How far through its steps the running node is, counting the step under way.
 *
 * The counter only moves when a step ends, and a video's steps are a minute
 * each: the bar sat still for that minute, then jumped. The step under way is
 * credited with the share of a usual step it has run for -- never all of it, so
 * the bar does not reach the next mark before the counter does. `stepMs` and
 * `stepSince` are kept by `reduce` in server/comfyEvents.js.
 */
export const withinStep = (job, now = Date.now()) => {
  if (!job?.steps) return 0;
  const partial = job.stepMs > 0 && job.stepSince && job.step < job.steps
    ? Math.min(0.9, Math.max(0, (now - job.stepSince) / job.stepMs))
    : 0;
  return Math.min((job.step + partial) / job.steps, 1);
};

/**
 * Where a run stands against what it took before.
 *
 * `pos` is how far through the old run's timeline this one has got: the latest
 * end of any node it has finished -- cached ones included, which is right,
 * because a cached text encoder is a minute of the old run that this one will
 * not spend -- and, for the node running now, its share done: steps where it
 * reports them, time where it does not, never quite the whole node.
 *
 * Time left is what the old run had left from there. Stretched when this run
 * is going slower than the old one did (a model that no longer fits on the
 * card), never shrunk: a run that skipped half its work is not going faster.
 */
export const estimate = (history, job, now = Date.now()) => {
  if (!history?.total || !job) return null;
  const total = history.total;
  if (job.state === 'queued' || !job.startedAt) return { expectedMs: total, fraction: null, remainingMs: null };
  if (job.state === 'done') return { expectedMs: total, fraction: 1, remainingMs: 0 };
  if (job.state === 'failed') return { expectedMs: total, fraction: null, remainingMs: null };

  /* How much of the old run's *work* this one has done -- added up, not read
   * off the clock of the furthest-along node.
   *
   * It used to be `max(node.start + node.dur)`, which asks "how far into the
   * old timeline are we" and answers it with one node. That is the same number
   * for a linear graph running in order, and badly wrong the moment it is not:
   *
   *   - ComfyUI announces every cached node at once, before anything runs. Run
   *     a prompt twice and the whole pipeline is cached, including the
   *     upscaler at the end of the recorded timeline -- so `pos` jumped to the
   *     end in the first second and the bar sat at 99% for the entire run.
   *   - A region edit adds nodes the profile has never seen (SAM3, the guide,
   *     the composite) and they run *after* the upscaler. Finishing the
   *     upscaler put the timeline at its end while a third of the job was
   *     still ahead.
   *
   * Summed, neither happens: a cached node contributes the time it saved and
   * nothing more, and every node still to run is still unaccounted for. For a
   * graph that runs start to finish with no gaps the two agree exactly, which
   * is why the figures this was tuned against are unchanged. */
  let pos = 0;
  let placed = 0;
  for (const id of job.done || []) {
    if (id === job.node) continue;
    const node = history.nodes?.[id];
    if (!node) continue;
    pos += node.dur;
    placed += 1;
  }
  const current = history.nodes?.[job.node];
  if (current) {
    const within = job.steps > 0
      ? withinStep(job, now)
      : Math.min(0.95, (now - (job.nodeSince || now)) / Math.max(current.dur, 1));
    pos += current.dur * within;
  } else if (job.node && !placed) {
    /* A node the old run never had, and nothing finished that it did: there is
       genuinely nothing to place this by. Once something known has finished,
       what it was worth is still worth saying -- the unknown node simply adds
       nothing until it ends. */
    return { expectedMs: total, fraction: null, remainingMs: null };
  }

  const elapsed = Math.max(0, now - job.startedAt);
  const slower = pos > total * 0.15 ? Math.min(Math.max(elapsed / pos, 1), 4) : 1;
  return {
    expectedMs: total,
    fraction: Math.min(Math.max(pos / total, 0), 0.99),
    remainingMs: Math.max(0, Math.round((total - pos) * slower)),
  };
};

/**
 * The store: profiles in memory, written to `file` a moment after each run.
 * `keys` is most specific first -- a workflow at this size, then the workflow
 * at any size -- and every one of them learns from every run.
 */
export const createTimings = ({ file = null } = {}) => {
  let profiles = {};
  if (file) {
    try { profiles = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { profiles = {}; }
  }
  let pending = null;
  const save = () => {
    if (!file || pending) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(profiles));
      } catch (e) { /* an estimate is not worth failing over */ }
    }, 1000);
    pending.unref?.();
  };

  return {
    lookup(keys = []) {
      for (const key of keys) if (profiles[key]?.total) return profiles[key];
      return null;
    },
    record(keys = [], sample) {
      if (!sample || !keys.length) return;
      for (const key of keys) profiles[key] = blendHistory(profiles[key], sample);
      const names = Object.keys(profiles);
      if (names.length > MAX_PROFILES) {
        names.sort((a, b) => (profiles[a].at || 0) - (profiles[b].at || 0))
          .slice(0, names.length - MAX_PROFILES)
          .forEach(name => { delete profiles[name]; });
      }
      save();
    },
  };
};
