/**
 * Settings that came from another device, put into the running app.
 *
 * Each binding is `[set, type, fallback, parse]`:
 *  - `type` is 'string', 'number', 'boolean' or 'json';
 *  - `fallback` is the value the app starts with when the setting is absent,
 *    used when another device deleted (reset) it -- written beside the
 *    `useState` it mirrors in App.jsx;
 *  - `parse`, if given, turns the stored text into the value instead.
 *
 * Returns the keys no binding covers. Nothing here reloads the page: those
 * keys are announced (`webui:settings-synced`) for the parts of the app that
 * read them, and are in storage for whatever reads them on demand.
 */
export function applyLiveSettings(keys, read, bindings) {
  const unbound = [];
  for (const key of new Set(keys || [])) {
    const binding = bindings[key];
    if (!binding) { unbound.push(key); continue; }
    const [set, type = 'string', fallback, parse] = binding;
    const raw = read(key);
    if (raw === null || raw === undefined) {
      if (fallback !== undefined) set(fallback);
      continue;
    }
    let value = raw;
    try {
      if (parse) value = parse(raw);
      else if (type === 'number') {
        value = Number(raw);
        if (!String(raw).trim() || !Number.isFinite(value)) value = fallback;
      } else if (type === 'boolean') {
        value = raw === 'true' ? true : raw === 'false' ? false : fallback;
      } else if (type === 'json') {
        value = JSON.parse(raw);
      }
    } catch { value = fallback; }
    if (value !== undefined) set(value);
  }
  return unbound;
}
