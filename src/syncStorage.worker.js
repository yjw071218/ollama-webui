import localforage from 'localforage';

const stores = new Map();
const storeFor = name => {
  if (!name) return localforage;
  if (!stores.has(name)) stores.set(name, localforage.createInstance({ name: 'ollama-webui', storeName: name }));
  return stores.get(name);
};
const handle = async (data) => {
  const { id, store, method, key, value } = data;
  try {
    if (!['getItem', 'setItem'].includes(method)) throw new Error('Unsupported storage operation');
    const target = storeFor(store);
    const result = method === 'getItem' ? await target.getItem(key) : await target.setItem(key, value);
    // A write acknowledgement must not clone the whole conversation back.
    self.postMessage({ id, result: method === 'setItem' ? null : result });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
// Startup can defer IndexedDB operations; preserve the caller's write/read order.
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
