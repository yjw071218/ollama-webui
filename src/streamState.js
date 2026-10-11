const snapshots = new Map();
const listeners = new Set();
export const subscribeStream = callback => { listeners.add(callback); return () => listeners.delete(callback); };
export const streamSnapshot = (chat, from, to) => {
  const value = snapshots.get(String(chat));
  return value && value.index >= from && value.index < to ? value : null;
};
export function publishStream(chat, index, content) {
  snapshots.set(String(chat), { index, content });
  for (const callback of listeners) callback();
}
export function clearStream(chat) {
  if (!snapshots.delete(String(chat))) return;
  for (const callback of listeners) callback();
}
