const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safe = key => !['__proto__', 'constructor', 'prototype'].includes(String(key));

// Paths use array indices against an exact server revision. Appended messages
// are individual operations, not replacements of the whole conversation.
export function createDelta(before, after, path = [], changes = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return changes;
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let i = 0; i < after.length; i++) createDelta(before[i], after[i], [...path, i], changes);
    if (after.length < before.length) changes.push({ path, length: after.length });
  } else if (object(before) && object(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!safe(key)) continue;
      if (!Object.hasOwn(after, key)) changes.push({ path: [...path, key], remove: true });
      else createDelta(before[key], after[key], [...path, key], changes);
    }
  } else changes.push({ path, value: after });
  return changes;
}

export function applyDelta(original, changes) {
  if (!Array.isArray(changes) || changes.length > 200000) throw new Error('Invalid delta');
  let result = structuredClone(original);
  for (const change of changes) {
    const path = change.path;
    if (!Array.isArray(path) || path.length > 100 || path.some(key => !safe(key) || !(typeof key === 'string' || Number.isSafeInteger(key) && key >= 0))) throw new Error('Invalid delta path');
    let parent = null, target = result, key;
    for (key of path) {
      if (target === null || typeof target !== 'object' || (Array.isArray(target) && (!Number.isSafeInteger(key) || key > target.length))) throw new Error('Invalid delta target');
      parent = target; target = Object.hasOwn(target, key) ? target[key] : undefined;
    }
    if (Object.hasOwn(change, 'length')) {
      if (!Array.isArray(target) || !Number.isSafeInteger(change.length) || change.length < 0 || change.length > target.length) throw new Error('Invalid delta length');
      target.length = change.length;
    } else if (change.remove) {
      if (!parent || Array.isArray(parent)) throw new Error('Invalid delta removal');
      delete parent[key];
    } else if (Object.hasOwn(change, 'value')) {
      if (parent) parent[key] = structuredClone(change.value);
      else result = structuredClone(change.value);
    } else throw new Error('Invalid delta operation');
  }
  return result;
}
