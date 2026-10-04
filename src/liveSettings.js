// Apply only settings actually changed by sync. Missing/deleted/invalid values
// require the existing reload path; never invent defaults or write timestamps.
export function applyLiveSettings(keys, read, bindings) {
  let complete = true;
  for (const key of new Set(keys || [])) {
    const binding = bindings[key], raw = read(key);
    if (!binding || raw === null) { complete = false; continue; }
    const [set, type = 'string'] = binding;
    let value = raw;
    if (type === 'number') {
      value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value)) { complete = false; continue; }
    } else if (type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') { complete = false; continue; }
      value = raw === 'true';
    }
    set(value);
  }
  return complete;
}
