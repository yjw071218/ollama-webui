/**
 * What the numbers on the monitor panel mean.
 *
 * The panel already showed what the hardware is doing: four percentages and a
 * sparkline each. Those answer "is it busy". They do not answer any of the
 * questions people actually open the panel with, which are all comparisons:
 *
 *   * Is this model actually on the GPU? A model that fits reports the same
 *     100% GPU utilisation as one that has been half-offloaded to system RAM,
 *     and the second is ten to twenty times slower. Ollama says which, in
 *     `size_vram` against `size`, and nothing was reading it.
 *   * Is it getting slower, or does it just feel that way? Speed is noisy
 *     enough per run that only a series answers this.
 *   * How much of the context is this conversation using? "Tokens fill up
 *     faster than the answers explain" is a real thing -- retrieval and
 *     grounding blocks are re-sent every turn -- and the only honest way to
 *     see it is prompt tokens over successive runs.
 *   * What is all this costing on disk?
 *
 * All of it is arithmetic over data the app already has, which is why it lives
 * here rather than in the component: a chart is hard to test and a median is
 * not.
 */

/** Below this share of the weights in VRAM, the rest is running on the CPU. */
export const FULLY_RESIDENT = 0.99;

/** Where "nearly full" starts, for both VRAM and the context window. */
export const PRESSURE_WARN = 0.85;
export const PRESSURE_HIGH = 0.95;

const finite = (n) => (Number.isFinite(n) ? n : null);

/**
 * What each loaded model is costing, and where it is actually running.
 *
 * `onGpu` is the number this exists for. Ollama loads as many layers onto the
 * card as fit and runs the remainder on the CPU, and the result is a model
 * that works, reports nothing unusual, and is an order of magnitude slower
 * than the same model one quantisation smaller. The panel can only say so if
 * something divides these two figures.
 */
export const residency = (runningModels = [], now = Date.now()) =>
  (runningModels || [])
    .filter(m => m && m.name)
    .map(m => {
      const total = finite(m.size) || 0;
      const vram = finite(m.size_vram);
      // No `size_vram` at all means an older Ollama, not a model on the CPU:
      // saying "0% on GPU" would be a confident wrong answer.
      const onGpu = vram === null || !total ? null : Math.min(1, vram / total);
      const expiresAt = m.expires_at ? Date.parse(m.expires_at) : NaN;
      return {
        name: m.name,
        total,
        vram: vram ?? null,
        cpu: vram === null ? null : Math.max(0, total - vram),
        onGpu,
        partial: onGpu !== null && onGpu < FULLY_RESIDENT,
        contextLength: finite(m.context_length) ?? finite(m.details?.context_length) ?? null,
        quantisation: m.details?.quantization_level || '',
        // Milliseconds until Ollama unloads it. Negative is not an error: the
        // sweep is periodic, so a model can be a few seconds past its time and
        // still resident.
        expiresIn: Number.isFinite(expiresAt) ? expiresAt - now : null,
      };
    })
    .sort((a, b) => b.total - a.total);

/**
 * What the installed models cost on disk.
 *
 * Ollama shares blobs between tags, so adding up `size` over the tag list
 * double-counts anything tagged twice -- and `llama3:8b` and `llama3:latest`
 * being the same 4.7GB is exactly the case somebody clearing space runs into.
 * Deduplicated by digest where there is one, which makes the total honest and
 * the per-tag rows still useful.
 */
export const diskUsage = (models = []) => {
  const rows = (models || [])
    .filter(m => m && m.name)
    .map(m => ({
      name: m.name,
      size: finite(m.size) || 0,
      digest: m.digest || '',
      family: m.details?.family || '',
      quantisation: m.details?.quantization_level || '',
      parameters: m.details?.parameter_size || '',
    }))
    .sort((a, b) => b.size - a.size);

  const counted = new Set();
  let total = 0;
  let shared = 0;
  for (const row of rows) {
    const key = row.digest || `name:${row.name}`;
    if (counted.has(key)) { shared += row.size; continue; }
    counted.add(key);
    total += row.size;
  }

  return { rows, total, shared, count: rows.length, unique: counted.size };
};

/**
 * Generation speed over time, newest last.
 *
 * One run per point rather than an average per bucket: the panel is looking
 * for a step change -- a model that was fast until something else took the
 * GPU, or a card that has throttled -- and averaging is precisely what hides
 * one.
 */
export const speedSeries = (runs = [], model = '', limit = 40) =>
  (runs || [])
    .filter(r => r && Number.isFinite(r.tokensPerSec) && (!model || r.model === model))
    .slice(-limit)
    .map(r => ({ at: r.at, value: r.tokensPerSec, model: r.model }));

/**
 * Prompt tokens over successive runs: how full the context is getting.
 *
 * `inTokens` is Ollama's own `prompt_eval_count`, so this is a tokeniser
 * count rather than an estimate. Against `numCtx` it says how close the
 * conversation is to the wall -- and, read as a series, how fast it is
 * getting there, which is the only way to see that something is re-sending a
 * large block every turn.
 */
export const contextSeries = (runs = [], model = '', limit = 40) =>
  (runs || [])
    .filter(r => r && Number.isFinite(r.inTokens) && r.inTokens > 0 && (!model || r.model === model))
    .slice(-limit)
    .map(r => ({ at: r.at, value: r.inTokens, model: r.model }));

/**
 * How full the context is, and how fast it is filling.
 *
 * `perTurn` is the median step between consecutive runs rather than the mean:
 * one retrieval-heavy turn should not be reported as the trend. `turnsLeft`
 * follows from it and is the number worth printing -- "83% full" invites a
 * shrug, "about three more turns" does not.
 */
export const contextPressure = (runs = [], model = '', numCtx = 0) => {
  const series = contextSeries(runs, model, 12);
  if (series.length === 0 || !numCtx) return null;

  const latest = series[series.length - 1].value;
  const steps = [];
  for (let i = 1; i < series.length; i++) {
    const step = series[i].value - series[i - 1].value;
    // A drop means a new chat or a compaction, not a negative growth rate.
    if (step > 0) steps.push(step);
  }
  const sorted = steps.slice().sort((a, b) => a - b);
  const perTurn = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;

  const used = latest / numCtx;
  return {
    used: Math.min(1, used),
    tokens: latest,
    numCtx,
    perTurn,
    turnsLeft: perTurn && perTurn > 0 ? Math.max(0, Math.floor((numCtx - latest) / perTurn)) : null,
    level: used >= PRESSURE_HIGH ? 'high' : used >= PRESSURE_WARN ? 'warn' : 'ok',
  };
};

/**
 * The things worth interrupting somebody about.
 *
 * Deliberately few. A panel that lists eight warnings is a panel whose
 * warnings are ignored, so this only reports conditions that (a) are true
 * right now, (b) explain something the person is already noticing, and (c)
 * have an action attached. Each carries the values behind it so the message
 * can name them rather than saying "high".
 */
export const alerts = ({ stats, running = [], pressure = null } = {}) => {
  const out = [];

  const gpu = stats?.gpus?.[0];
  if (gpu?.memoryTotal) {
    const used = gpu.memoryUsed / gpu.memoryTotal;
    if (used >= PRESSURE_HIGH) {
      out.push({ kind: 'vram', level: 'high', used, free: gpu.memoryTotal - gpu.memoryUsed });
    }
  }

  // The expensive one, and the one nothing else reports.
  for (const model of residency(running)) {
    if (model.partial) {
      out.push({ kind: 'offloaded', level: 'high', model: model.name, onGpu: model.onGpu, cpu: model.cpu });
    }
  }

  if (pressure && pressure.level !== 'ok') {
    out.push({ kind: 'context', level: pressure.level, ...pressure });
  }

  if (gpu && gpu.temperature !== null && gpu.temperature !== undefined && gpu.temperature >= 85) {
    out.push({ kind: 'thermal', level: 'warn', temperature: gpu.temperature });
  }

  return out;
};

/**
 * A sampled series thinned to a fixed number of points.
 *
 * The poller keeps two-second samples; a fifteen-minute window is 450 of
 * them and a 240px sparkline cannot show that many. Takes the maximum of each
 * bucket rather than the mean, because on a load graph the spikes are the
 * signal and averaging is what turns a pegged GPU into a comfortable 40%.
 */
export const thin = (points = [], width = 60) => {
  const values = (points || []).filter(v => Number.isFinite(v));
  if (values.length <= width) return values;
  const per = values.length / width;
  const out = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor(i * per);
    const to = Math.max(from + 1, Math.floor((i + 1) * per));
    out.push(Math.max(...values.slice(from, to)));
  }
  return out;
};

/** Bytes as something readable, shared by every row that prints a size. */
export const formatBytes = (bytes) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

/** A duration as the coarsest unit that still says something. */
export const formatDuration = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(0, s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
};
