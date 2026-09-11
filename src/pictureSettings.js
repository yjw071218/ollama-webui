/**
 * What a result in a conversation was made with, as rows to show beside it.
 *
 * A picture the model drew used to carry its prompt and its seed and nothing
 * else, so "what made this one come out so well" had no answer short of
 * opening ComfyUI and reading the graph. The server now reads the settings back
 * out of the graph it queued -- see `readSettings` -- and they travel with the
 * result. Pictures from before that carry them in the PNG itself, which is the
 * `fromFile` argument: read by `pngInfo.js`, and outranked by anything the
 * result recorded, because the file's graph is the workflow's and the record is
 * this job's.
 *
 * Pure, so the rules about what to show and in what order can be tested
 * without rendering anything.
 */

const WORKFLOW_LABELS = {
  'anima-base': 'Anima Base',
  'krea2-turbo': 'Krea 2 Turbo',
  'minimax-h3': 'MiniMax H3',
};

/** A model file's name without the folders ComfyUI keeps it in. */
export const fileName = (value) => String(value ?? '').split(/[\\/]/).pop();

const present = (value) => value !== undefined && value !== null && value !== '';

/* A float as it would be typed: 0.65 rather than 0.6500000000000001, and 1
   rather than 1.00. */
const tidy = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(value);
};

/**
 * `[{ key, value, mono?, long?, title? }]`, in reading order: what made it,
 * how big, the numbers that reproduce it, the files, then the words.
 *
 * `key` is the label's translation key under `picset.`; `op` rows carry the
 * operation's own id, which the component names with the button that did it.
 */
export const settingsRows = (picture = {}, fromFile = null) => {
  /* Three sources, weakest first: the file's graph, what the result itself
     kept before settings were recorded (its seed, length, prompt), and the
     settings recorded for this job. */
  const kept = Object.fromEntries(['seed', 'duration', 'prompt', 'negative']
    .filter(key => present(picture[key]))
    .map(key => [key, picture[key]]));
  const s = { ...(fromFile || {}), ...kept, ...(picture.settings || {}) };
  const rows = [];
  const add = (key, value, extra = {}) => {
    if (present(value)) rows.push({ key, value: String(value), ...extra });
  };

  add('workflow', s.workflow || WORKFLOW_LABELS[picture.model] || picture.model);
  if (picture.op) add('op', picture.op, { factor: picture.factor });
  if (s.width && s.height) add('size', `${s.width}×${s.height}`, { mono: true });
  add('seed', s.seed, { mono: true });
  add('steps', s.steps, { mono: true });
  add('cfg', present(s.cfg) ? tidy(s.cfg) : undefined, { mono: true });
  add('sampler', s.sampler, { mono: true });
  add('scheduler', s.scheduler, { mono: true });
  add('duration', present(s.duration) ? `${tidy(s.duration)}s` : undefined, { mono: true });
  add('fps', s.fps, { mono: true });
  add('denoise', present(s.denoise) ? tidy(s.denoise) : undefined, { mono: true });
  for (const key of ['checkpoint', 'vae', 'clip']) {
    if (present(s[key])) add(key, fileName(s[key]), { mono: true, title: String(s[key]) });
  }
  const loras = (s.loras || []).filter(l => l?.name);
  if (loras.length) {
    add('loras', loras.map(l => `${fileName(l.name)} (${tidy(l.weight ?? 1)})`).join(', '), {
      mono: true,
      long: true,
      title: loras.map(l => `${l.name} (${tidy(l.weight ?? 1)})`).join('\n'),
    });
  }
  add('style', picture.style);
  if (s.reference) add('reference', '✓');
  add('region', s.region);
  add('negative', s.negative, { long: true });
  add('prompt', s.prompt, { long: true });
  return rows;
};

/** The rows as plain text, one `Label: value` per line, for the copy button. */
export const settingsText = (rows, label = (key) => key) =>
  rows.map(row => `${label(row)}: ${row.value}`).join('\n');
