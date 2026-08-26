// The generation settings are eleven separate controls. Tuning them for one
// kind of task and then wanting the old numbers back is a real workflow, so a
// preset is a named snapshot of all of them that can be applied in one click.

export const PRESET_FIELDS = [
  'temperature', 'topP', 'topK', 'repeatPenalty', 'numCtx', 'maxTokens',
  'minP', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences',
];

// Ollama rejects some of these outright and silently misbehaves on others, so
// anything loaded from storage or typed in is clamped before it is used.
const LIMITS = {
  temperature: [0, 2], topP: [0, 1], topK: [0, 200], repeatPenalty: [0, 2],
  numCtx: [256, 1048576], maxTokens: [-1, 131072], minP: [0, 1],
  presencePenalty: [-2, 2], frequencyPenalty: [-2, 2],
};

const clamp = (field, value) => {
  const range = LIMITS[field];
  const n = Number(value);
  if (!range || !Number.isFinite(n)) return null;
  return Math.min(Math.max(n, range[0]), range[1]);
};

export const sanitisePreset = (values = {}) => {
  const out = {};
  for (const field of PRESET_FIELDS) {
    if (!(field in values)) continue;
    if (field === 'stopSequences') { out[field] = String(values[field] ?? ''); continue; }
    if (field === 'seed') {
      const raw = String(values[field] ?? '').trim();
      out[field] = raw === '' || Number.isNaN(Number(raw)) ? '' : raw;
      continue;
    }
    const n = clamp(field, values[field]);
    if (n !== null) out[field] = n;
  }
  return out;
};

let counter = 0;
export const newPreset = (name, values) => ({
  id: `p${Date.now().toString(36)}${(counter++).toString(36)}`,
  name: String(name || '').trim().slice(0, 40) || 'Untitled',
  values: sanitisePreset(values),
  createdAt: Date.now(),
});

// Starting points rather than recommendations — they are the four shapes people
// actually reach for, and every one of them is editable once applied.
export const BUILTIN_PRESETS = [
  { id: 'builtin-precise', builtin: true, nameKey: 'preset.precise',
    values: { temperature: 0.2, topP: 0.7, topK: 20, repeatPenalty: 1.05, minP: 0 } },
  { id: 'builtin-balanced', builtin: true, nameKey: 'preset.balanced',
    values: { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1, minP: 0 } },
  { id: 'builtin-creative', builtin: true, nameKey: 'preset.creative',
    values: { temperature: 1.1, topP: 0.95, topK: 100, repeatPenalty: 1.15, minP: 0.02 } },
  { id: 'builtin-deterministic', builtin: true, nameKey: 'preset.deterministic',
    values: { temperature: 0, topP: 1, topK: 1, repeatPenalty: 1, minP: 0, seed: '0' } },
];

const STORAGE_KEY = 'samplingPresets';

export const loadPresets = (userId) => {
  try {
    const raw = localStorage.getItem(userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(p => p && p.id && typeof p.name === 'string')
      .map(p => ({ ...p, values: sanitisePreset(p.values) }));
  } catch (e) {
    return [];
  }
};

export const savePresets = (userId, presets) => {
  try {
    localStorage.setItem(userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY, JSON.stringify(presets));
  } catch (e) {}
};

// Which preset, if any, describes the settings currently in effect. Compared on
// the fields the preset actually names, so a partial preset still matches.
export const matchPreset = (presets, current) => {
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
  return presets.find(p => Object.entries(p.values).every(([field, value]) => (
    field === 'stopSequences' || field === 'seed'
      ? String(current[field] ?? '') === String(value ?? '')
      : near(current[field], value)
  ))) || null;
};
