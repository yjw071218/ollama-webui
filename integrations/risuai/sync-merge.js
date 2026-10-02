import { sha256 } from '@noble/hashes/sha2.js';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const identity = x => object(x) ? (x.chaId || x.id || x.chatId || x.name) : undefined;
// Lenient resolution used by automatic sync: never throws, never duplicates a
// record. Lists that both devices only appended to keep every new item (two
// replies to the same chat both stay, remote's first); any other competing
// value takes the committed (remote) one. The local state before the merge is
// still snapshotted by webui-sync as `webui-sync/conflict-*`.
const prefix = (head, list) => Array.isArray(head) && head.length <= list.length && head.every((x, i) => same(x, list[i]));
function resolveConflict(base, local, remote) {
  if (Array.isArray(local) && Array.isArray(remote)) {
    const start = Array.isArray(base) && prefix(base, local) && prefix(base, remote) ? base.length
      : (() => { let i = 0; while (i < local.length && i < remote.length && same(local[i], remote[i])) i++; return i; })();
    const extra = local.slice(start).filter(item => !remote.slice(start).some(x => same(x, item)));
    return [...remote, ...extra];
  }
  return remote === undefined ? local : remote;
}
export function mergeRisuLenient(base, local, remote, path = '상황극') {
  try { return mergeRisu(base, local, remote, path, true); }
  catch { return resolveConflict(base, local, remote); }
}

export function mergeRisu(base, local, remote, path = '상황극', lenient = false) {
  if (same(local, remote) || same(base, remote)) return local;
  if (same(base, local)) return remote;
  // Opening a character updates this metadata on each device. It is not a
  // competing edit to the conversation, and must not block real chat updates.
  if (/\/(lastInteraction|lastDate)$/.test(path) && typeof local === 'number' && typeof remote === 'number') return Math.max(local, remote);
  if (/\/chatPage$/.test(path)) return local;
  if (Array.isArray(local) && Array.isArray(remote) && (base === undefined || Array.isArray(base))) {
    const arrays = [base || [], local, remote];
    if (arrays.every(items => items.every(identity) && new Set(items.map(identity)).size === items.length)) {
      const maps = arrays.map(items => new Map(items.map(item => [identity(item), item])));
      return [...new Set([...maps[1].keys(), ...maps[2].keys()])].map(key => mergeRisu(maps[0].get(key), maps[1].get(key), maps[2].get(key), `${path}/${key}`, lenient)).filter(x => x !== undefined);
    }
  }
  if (object(local) && object(remote) && (base === undefined || object(base))) {
    const merged = {};
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const value = mergeRisu(base?.[key], local[key], remote[key], `${path}/${key}`, lenient);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (lenient) return resolveConflict(base, local, remote);
  const error = new Error(`두 기기에서 같은 내용을 수정했습니다: ${path}`);
  error.conflict = true;
  throw error;
}

// Keep the committed version under its existing id; retain a conflicting
// local record as a deterministic, visible copy instead of stopping sync.
export function mergeRisuAutomatically(base, local, remote) {
  const result = { assets: { ...remote.assets } };
  // A conversation conflict must not drop the active settings. Resolve only
  // competing settings in favor of the committed value, retaining other edits.
  if (local.settings || remote.settings) {
    result.settings = {};
    for (const key of new Set([...Object.keys(local.settings || {}), ...Object.keys(remote.settings || {})])) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      try { result.settings[key] = mergeRisu(base?.settings?.[key], local.settings?.[key], remote.settings?.[key], `settings/${key}`); }
      catch { result.settings[key] = remote.settings?.[key]; }
    }
  }
  // Assets only needed a ".sync-" alias for the duplicated character to point
  // at; with no duplicate, a file both devices replaced keeps the committed one.
  const remap = {};
  for (const [key, digest] of Object.entries(local.assets || {})) {
    if (!remote.assets?.[key]) result.assets[key] = digest;
  }
  const rewrite = value => {
    if (typeof value === 'string') return remap[value] || value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  for (const field of ['characters', 'botPresets', 'modules']) {
    const b = new Map((base?.[field] || []).map(x => [identity(x), x]));
    const l = new Map((local[field] || []).map((x, i) => [identity(x) || `local-${i}`, x]));
    const r = new Map((remote[field] || []).map((x, i) => [identity(x) || `remote-${i}`, x]));
    const records = [];
    for (const key of new Set([...r.keys(), ...l.keys()])) {
      // Merged in place: a conflict no longer clones the whole character as a
      // "(동시 수정 사본)" -- one differing value used to cost a full copy.
      const merged = mergeRisuLenient(b.get(key), rewrite(l.get(key)), r.get(key), field + '/' + key);
      if (merged !== undefined) records.push(merged);
    }
    result[field] = records;
  }
  return result;
}
