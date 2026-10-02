import { syncAssetTasks } from './sync-assets.js';

export function createAssetIndex(storage, isAsset, hash, changed) {
  const digests = new Map(), versions = new Map();
  const dirty = new Set();
  let initialized = false;
  const set = storage.setItem.bind(storage), remove = storage.removeItem.bind(storage);
  storage.setItem = async (key, bytes) => {
    const result = await set(key, bytes);
    if (isAsset(key)) {
      versions.set(key, (versions.get(key) || 0) + 1);
      if (bytes instanceof Uint8Array) digests.set(key, hash(bytes));
      else digests.delete(key);
      changed(key);
    } else if (key.startsWith('database/')) changed();
    return result;
  };
  storage.removeItem = async key => {
    const result = await remove(key);
    if (isAsset(key)) {
      versions.set(key, (versions.get(key) || 0) + 1);
      digests.delete(key); changed(key);
    }
    return result;
  };
  return {
    async read(progress) {
      if (!initialized || dirty.size) {
        const keys = initialized ? [...dirty] : (await storage.keys()).filter(isAsset);
        dirty.clear();
        await syncAssetTasks(keys, async key => {
          const version = versions.get(key) || 0;
          const bytes = await storage.getItem(key);
          if (version === (versions.get(key) || 0)) {
            if (bytes instanceof Uint8Array) digests.set(key, hash(bytes));
            else digests.delete(key);
          }
        }, progress);
        initialized = true;
      }
      return Object.fromEntries([...digests].sort(([a], [b]) => a.localeCompare(b)));
    },
    matches: (key, digest) => digests.get(key) === digest,
    invalidate(key) { if (isAsset(key)) { dirty.add(key); versions.set(key, (versions.get(key) || 0) + 1); } },
  };
}
