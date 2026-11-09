import localforage from 'localforage';

let worker, unavailable = false, nextId = 0, restarts = 0;
const pending = new Map();
/* A timeout is a slow disk or a huge list, not a broken worker. It used to set
   `unavailable` for good, and every later read and write of the whole chat list
   then ran on the main thread for the rest of the session -- the app stayed
   janky long after the one slow sync. Now a timeout restarts the worker (a few
   times), and only a real worker error falls back to the main thread. */
function stopWorker(permanent = true) {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(new Error('Background storage stopped; sync will retry.'));
  }
  pending.clear(); worker?.terminate(); worker = null;
  if (permanent || ++restarts > 3) unavailable = true;
}
const timedOut = () => stopWorker(false);
function getWorker() {
  if (unavailable || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./syncStorage.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      clearTimeout(job.timer);
      if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
    };
    // Never repeat a write whose completion is unknown.
    worker.onerror = () => stopWorker(true);
    worker.onmessageerror = () => stopWorker(true);
  } catch { unavailable = true; return null; }
  return worker;
}

export function syncStorage(store = '') {
  const fallback = store ? localforage.createInstance({ name: 'ollama-webui', storeName: store }) : localforage;
  const call = (method, key, value) => {
    const active = getWorker();
    if (!active) return fallback[method](key, value);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(timedOut, 300000);
      pending.set(id, { resolve, reject, timer });
      try { active.postMessage({ id, store, method, key, value }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  return { getItem: key => call('getItem', key), setItem: (key, value) => call('setItem', key, value) };
}
