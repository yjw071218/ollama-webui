import localforage from 'localforage';

let worker, unavailable = false, nextId = 0;
const pending = new Map();
function stopWorker() {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(new Error('Background storage stopped; sync will retry.'));
  }
  pending.clear(); worker?.terminate(); worker = null; unavailable = true;
}
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
    worker.onerror = stopWorker;
    worker.onmessageerror = stopWorker;
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
      const timer = setTimeout(stopWorker, 120000);
      pending.set(id, { resolve, reject, timer });
      try { active.postMessage({ id, store, method, key, value }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  };
  return { getItem: key => call('getItem', key), setItem: (key, value) => call('setItem', key, value) };
}
