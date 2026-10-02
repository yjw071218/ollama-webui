import { syncAssetTasks } from './sync-assets.js';

/* Every asset's digest, kept between page loads. Without it the first sync of
   every load read each asset out of IndexedDB and hashed it ("최초 에셋 확인"),
   which with a few large cards was minutes of work for an answer that had not
   changed. The cache is written only from digests this index computed or saw
   being written, so a key in it is trusted; a key not in it is hashed, and a
   cached key no longer in storage is dropped. */
const CACHE_KEY = 'webui-sync/asset-digests';
const CACHE_VERSION = 1;

export function createAssetIndex(storage, isAsset, hash, changed) {
  const digests = new Map(), versions = new Map();
  const dirty = new Set();
  let initialized = false;
  const set = storage.setItem.bind(storage), remove = storage.removeItem.bind(storage);
  const digestOf = async bytes => await hash(bytes);

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const body = JSON.stringify({ v: CACHE_VERSION, digests: Object.fromEntries(digests) });
      set(CACHE_KEY, new TextEncoder().encode(body)).catch?.(() => {});
    }, 500);
  };
  const loadCache = async () => {
    try {
      const raw = await storage.getItem(CACHE_KEY);
      if (!(raw instanceof Uint8Array)) return {};
      const parsed = JSON.parse(new TextDecoder().decode(raw));
      return parsed?.v === CACHE_VERSION && parsed.digests && typeof parsed.digests === 'object' ? parsed.digests : {};
    } catch { return {}; }
  };

  storage.setItem = async (key, bytes) => {
    const result = await set(key, bytes);
    if (isAsset(key)) {
      const version = (versions.get(key) || 0) + 1;
      versions.set(key, version);
      if (bytes instanceof Uint8Array) {
        const digest = await digestOf(bytes);
        if (versions.get(key) === version) digests.set(key, digest);
      } else digests.delete(key);
      save();
      changed(key);
    } else if (key.startsWith('database/')) changed();
    return result;
  };
  storage.removeItem = async key => {
    const result = await remove(key);
    if (isAsset(key)) {
      versions.set(key, (versions.get(key) || 0) + 1);
      digests.delete(key); save(); changed(key);
    }
    return result;
  };
  const hashKeys = (keys, progress) => syncAssetTasks(keys, async key => {
    const version = versions.get(key) || 0;
    const bytes = await storage.getItem(key);
    const digest = bytes instanceof Uint8Array ? await digestOf(bytes) : null;
    if (version === (versions.get(key) || 0)) {
      if (digest) digests.set(key, digest);
      else digests.delete(key);
    }
  }, progress);
  return {
    async read(progress) {
      if (!initialized) {
        const [keys, cached] = await Promise.all([storage.keys(), loadCache()]);
        const present = keys.filter(isAsset);
        const unknown = [];
        for (const key of present) {
          // A write seen since load is newer than the cache.
          if (digests.has(key) || versions.has(key)) continue;
          if (typeof cached[key] === 'string') digests.set(key, cached[key]);
          else unknown.push(key);
        }
        const live = new Set(present);
        for (const key of [...digests.keys()]) if (!live.has(key)) digests.delete(key);
        await hashKeys([...new Set([...unknown, ...dirty])], progress);
        dirty.clear();
        initialized = true;
        save();
      } else if (dirty.size) {
        const keys = [...dirty];
        dirty.clear();
        await hashKeys(keys, progress);
        save();
      }
      return Object.fromEntries([...digests].sort(([a], [b]) => a.localeCompare(b)));
    },
    matches: (key, digest) => digests.get(key) === digest,
    invalidate(key) { if (isAsset(key)) { dirty.add(key); versions.set(key, (versions.get(key) || 0) + 1); } },
  };
}
