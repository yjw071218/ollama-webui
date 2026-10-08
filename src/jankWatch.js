/**
 * Where the phone's main thread goes. Records every task over 50 ms (the
 * browser's "long task") with what the app was doing at the time, so a laggy
 * moment can be read off the device instead of guessed at.
 *
 * In the console (chrome://inspect for the Android app):
 *   __webuiJank()        summary: count, total ms, worst, by phase
 *   __webuiJank.clear()  start counting again
 * `jankPhase('name')` marks what is happening (streaming, sync, typing...).
 */
const MAX = 300;
const tasks = [];
let phase = 'idle';

export const jankPhase = (name) => {
  phase = name || 'idle';
  return () => { if (phase === name) phase = 'idle'; };
};

try {
  if (typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        tasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration), phase, hidden: document.hidden });
        if (tasks.length > MAX) tasks.shift();
      }
    }).observe({ type: 'longtask', buffered: true });
  }
} catch (e) { /* not supported: the summary says so */ }

const summary = () => {
  const by = {};
  for (const t of tasks) {
    const b = (by[t.phase] ||= { count: 0, totalMs: 0, worstMs: 0 });
    b.count++; b.totalMs += t.ms; b.worstMs = Math.max(b.worstMs, t.ms);
  }
  const total = tasks.reduce((n, t) => n + t.ms, 0);
  const result = {
    longTasks: tasks.length,
    totalMs: total,
    worstMs: tasks.reduce((n, t) => Math.max(n, t.ms), 0),
    byPhase: by,
    last: tasks.slice(-10),
  };
  try { console.table(by); } catch (e) { /* no console */ }
  return result;
};
summary.clear = () => { tasks.length = 0; };
globalThis.__webuiJank = summary;
