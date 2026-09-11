/**
 * The settings a picture was made with, read back out of the picture.
 *
 * Every tool that matters writes them into the PNG as text chunks, each in its
 * own dialect:
 *
 * - AUTOMATIC1111 / Forge / reForge: one `parameters` string — the prompt, a
 *   `Negative prompt:` line, and a last line of `Key: value, Key: value`.
 * - ComfyUI: the whole graph as JSON under `prompt`. There is no field called
 *   "the prompt"; it is wherever the sampler's `positive` input leads.
 * - NovelAI: JSON under `Comment`, with `uc` for the negative.
 *
 * Only PNG. JPEG and WebP carry the same thing in EXIF, and supporting them
 * means an EXIF parser for a case nobody here has asked for yet.
 */

import { unzlibSync } from 'fflate';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const latin1 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

/* `tEXt` is Latin-1 by the letter of the spec, and UTF-8 in practice — PIL
   writes UTF-8 there whenever it can get away with it. Try the one that is
   actually used, and fall back to the one that is specified. */
const text = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return latin1(bytes); }
};

/**
 * The text chunks of a PNG, as `{ keyword: text }`, and its pixel size.
 * `null` when the bytes are not a PNG at all.
 */
export const readPngText = (input) => {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length < 8 || SIGNATURE.some((b, i) => u8[i] !== b)) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = {};
  let width = 0;
  let height = 0;
  let p = 8;
  while (p + 8 <= u8.length) {
    const length = view.getUint32(p);
    const type = latin1(u8.subarray(p + 4, p + 8));
    const start = p + 8;
    const end = start + length;
    if (end > u8.length) break;
    const data = u8.subarray(start, end);
    try {
      if (type === 'IHDR' && length >= 8) {
        width = view.getUint32(start);
        height = view.getUint32(start + 4);
      } else if (type === 'tEXt') {
        const z = data.indexOf(0);
        if (z > 0) chunks[latin1(data.subarray(0, z))] = text(data.subarray(z + 1));
      } else if (type === 'zTXt') {
        const z = data.indexOf(0);
        if (z > 0) chunks[latin1(data.subarray(0, z))] = text(unzlibSync(data.subarray(z + 2)));
      } else if (type === 'iTXt') {
        // keyword \0 compressed? method language \0 translated-keyword \0 text
        const z = data.indexOf(0);
        if (z > 0) {
          const compressed = data[z + 1] === 1;
          const langEnd = data.indexOf(0, z + 3);
          const transEnd = data.indexOf(0, langEnd + 1);
          const body = data.subarray(transEnd + 1);
          chunks[latin1(data.subarray(0, z))] = text(compressed ? unzlibSync(body) : body);
        }
      } else if (type === 'IEND') {
        break;
      }
    } catch (e) { /* one unreadable chunk is not an unreadable picture */ }
    p = end + 4;   // past the CRC
  }
  return { chunks, width, height };
};

/* ------------------------------------------------------------ samplers

   A1111 names its samplers for people and ComfyUI names them for code, and a
   form whose sampler list comes from ComfyUI can only take the second. The
   old A1111 names had the scheduler folded in ("DPM++ 2M Karras"); the newer
   ones keep it in `Schedule type`. Both are understood. */

const A1111_SAMPLERS = {
  'euler a': 'euler_ancestral', euler: 'euler', lms: 'lms', heun: 'heun',
  dpm2: 'dpm_2', 'dpm2 a': 'dpm_2_ancestral', 'dpm++ 2s a': 'dpmpp_2s_ancestral',
  'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde', 'dpm++ 2m sde': 'dpmpp_2m_sde',
  'dpm++ 3m sde': 'dpmpp_3m_sde', 'dpm fast': 'dpm_fast', 'dpm adaptive': 'dpm_adaptive',
  lcm: 'lcm', ddim: 'ddim', ddpm: 'ddpm', unipc: 'uni_pc', 'euler cfg++': 'euler_cfg_pp',
  'euler a cfg++': 'euler_ancestral_cfg_pp', 'dpm++ 2m cfg++': 'dpmpp_2m_cfg_pp',
};
const A1111_SCHEDULES = {
  karras: 'karras', exponential: 'exponential', 'sgm uniform': 'sgm_uniform',
  simple: 'simple', normal: 'normal', ddim: 'ddim_uniform', beta: 'beta',
  'kl optimal': 'kl_optimal', 'align your steps': 'align_your_steps',
};

export const comfySampler = (name, schedule) => {
  let value = String(name || '').trim();
  let scheduler = schedule ? A1111_SCHEDULES[String(schedule).trim().toLowerCase()] : undefined;
  for (const [suffix, id] of [[' karras', 'karras'], [' exponential', 'exponential']]) {
    if (value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      scheduler = scheduler || id;
    }
  }
  const lower = value.toLowerCase();
  const sampler = A1111_SAMPLERS[lower]
    // Already a code name (ComfyUI's, or NovelAI's with its `k_` prefix).
    || (/^[a-z0-9_]+$/.test(lower) ? lower.replace(/^k_/, '') : undefined);
  return { sampler, scheduler };
};

/* ---------------------------------------------------------- the dialects */

const number = (value) => {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : undefined;
};

/** AUTOMATIC1111's `parameters`. */
export const parseA1111 = (raw) => {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  // The settings are the last line that starts with "Steps:" — or with any
  // "Key: value," run, for the exporters that reorder it.
  let settingsAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Steps:\s*\d/.test(lines[i]) || /^\s*[\w ]+:\s*[^,]+,\s*[\w ]+:\s*/.test(lines[i]) && /Seed:\s*\d/.test(lines[i])) {
      settingsAt = i;
      break;
    }
  }
  const head = settingsAt >= 0 ? lines.slice(0, settingsAt) : lines;
  const negAt = head.findIndex(line => /^Negative prompt:/i.test(line));
  const prompt = (negAt >= 0 ? head.slice(0, negAt) : head).join('\n').trim();
  const negative = negAt >= 0
    ? head.slice(negAt).join('\n').replace(/^Negative prompt:\s*/i, '').trim()
    : undefined;

  const params = {};
  if (settingsAt >= 0) {
    // A1111's own pattern: a value is either quoted, or runs to the next comma.
    const re = /\s*([\w ][\w \-/+.]*?):\s*("(?:\\.|[^\\"])*"|[^,]*)(?:,|$)/g;
    let m;
    while ((m = re.exec(lines[settingsAt])) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      params[m[1].trim().toLowerCase()] = m[2].trim().replace(/^"|"$/g, '');
    }
  }
  const size = /(\d+)\s*x\s*(\d+)/.exec(params.size || '');
  const { sampler, scheduler } = comfySampler(params.sampler, params['schedule type']);
  return {
    source: 'a1111',
    prompt,
    negative,
    steps: number(params.steps),
    cfg: number(params['cfg scale']),
    seed: number(params.seed),
    sampler,
    scheduler,
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
  };
};

/** NovelAI's `Comment`. */
export const parseNovelAI = (raw, chunks = {}) => {
  let data;
  try { data = JSON.parse(raw); } catch (e) { return null; }
  if (!data || typeof data !== 'object') return null;
  const prompt = data.prompt ?? data.v4_prompt?.caption?.base_caption ?? chunks.Description;
  if (typeof prompt !== 'string') return null;
  const { sampler, scheduler } = comfySampler(data.sampler,
    data.noise_schedule && data.noise_schedule !== 'native' ? data.noise_schedule : undefined);
  return {
    source: 'novelai',
    prompt,
    negative: data.uc ?? data.v4_negative_prompt?.caption?.base_caption,
    steps: number(data.steps),
    cfg: number(data.scale),
    seed: number(data.seed),
    sampler,
    scheduler,
    width: number(data.width),
    height: number(data.height),
  };
};

const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');

/**
 * ComfyUI's `prompt` graph.
 *
 * The prompt text is found the way ComfyUI itself would find it: start at the
 * sampler's `positive` input and follow the wires back until something has
 * text in it. That goes through the conditioning nodes people put in between
 * — a combine, a set-area, a loader that encodes for you — without a list of
 * every one of them. Graphs that route everything through a loader and never
 * wire the sampler at all are caught by the fallback: a node that simply has
 * `positive` and `negative` strings.
 */
export const parseComfy = (raw) => {
  let graph;
  try { graph = JSON.parse(raw); } catch (e) { return null; }
  if (!graph || typeof graph !== 'object') return null;
  const nodes = Object.entries(graph).filter(([, n]) => n && typeof n === 'object' && n.inputs);
  if (!nodes.length) return null;

  const TEXT_KEYS = { positive: ['positive', 'text_positive', 'text', 'text_g', 'prompt', 'string', 'value'],
    negative: ['negative', 'text_negative', 'text', 'text_g', 'prompt', 'string', 'value'] };
  const FOLLOW = /text|conditioning|positive|negative|prompt|string|context|pipe/i;

  const textFrom = (value, role, depth = 0, seen = new Set()) => {
    if (typeof value === 'string') return value;
    if (!isLink(value) || depth > 12) return '';
    const id = String(value[0]);
    if (seen.has(id)) return '';
    seen.add(id);
    const inputs = graph[id]?.inputs || {};
    for (const key of TEXT_KEYS[role]) {
      if (typeof inputs[key] === 'string' && inputs[key].trim()) return inputs[key];
    }
    const found = [];
    // The wire that carries the role's own name first, then the rest.
    const keys = Object.keys(inputs).sort((a, b) => (b === role) - (a === role));
    for (const key of keys) {
      if (!FOLLOW.test(key) || !isLink(inputs[key])) continue;
      if (role === 'positive' && /negative/i.test(key)) continue;
      if (role === 'negative' && /positive/i.test(key)) continue;
      const got = textFrom(inputs[key], role, depth + 1, seen);
      if (got) found.push(got);
    }
    return found.join(', ');
  };

  const valueFrom = (value, key, depth = 0) => {
    if (!isLink(value)) return value;
    if (depth > 6) return undefined;
    const inputs = graph[String(value[0])]?.inputs || {};
    const own = inputs[key] ?? inputs.value ?? inputs.seed ?? inputs.int ?? inputs.number;
    return valueFrom(own, key, depth + 1);
  };

  const samplers = nodes
    .filter(([, n]) => 'steps' in n.inputs && ('seed' in n.inputs || 'noise_seed' in n.inputs || 'positive' in n.inputs))
    .sort(([, a], [, b]) => (isLink(b.inputs.positive) ? 1 : 0) - (isLink(a.inputs.positive) ? 1 : 0));
  const sampler = samplers[0]?.[1]?.inputs || {};

  let prompt = textFrom(sampler.positive, 'positive');
  let negative = textFrom(sampler.negative, 'negative');
  if (!prompt) {
    const loader = nodes.find(([, n]) => typeof n.inputs.positive === 'string');
    if (loader) {
      prompt = loader[1].inputs.positive;
      if (!negative && typeof loader[1].inputs.negative === 'string') negative = loader[1].inputs.negative;
    }
  }

  // Anything the sampler does not have itself, from the first node that does.
  const anywhere = (key) => {
    for (const [, n] of nodes) {
      const v = valueFrom(n.inputs[key], key);
      if (v !== undefined && typeof v !== 'object') return v;
    }
    return undefined;
  };
  const pick = (key, ...alts) => {
    for (const k of [key, ...alts]) {
      const v = valueFrom(sampler[k], k);
      if (v !== undefined && typeof v !== 'object') return v;
    }
    for (const k of [key, ...alts]) {
      const v = anywhere(k);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const latent = nodes.find(([, n]) => /EmptyLatent|Empty.*Latent/i.test(n.class_type || '')
    && typeof n.inputs.width === 'number' && typeof n.inputs.height === 'number');
  const loaderSize = nodes.find(([, n]) => typeof n.inputs.empty_latent_width === 'number');
  const width = latent?.[1].inputs.width ?? loaderSize?.[1].inputs.empty_latent_width;
  const height = latent?.[1].inputs.height ?? loaderSize?.[1].inputs.empty_latent_height;

  if (!prompt) return null;
  return {
    source: 'comfyui',
    prompt,
    negative: negative || undefined,
    steps: number(pick('steps')),
    cfg: number(pick('cfg')),
    seed: number(pick('seed', 'noise_seed')),
    sampler: typeof pick('sampler_name') === 'string' ? pick('sampler_name') : undefined,
    scheduler: typeof pick('scheduler') === 'string' ? pick('scheduler') : undefined,
    width: number(width),
    height: number(height),
  };
};

/**
 * Everything worth restoring from a PNG, or `null` if it carries nothing.
 * Fields that could not be read are left out rather than guessed.
 */
export const readGenerationInfo = (bytes) => {
  const png = readPngText(bytes);
  if (!png) return null;
  const { chunks } = png;
  const info = (chunks.parameters && parseA1111(chunks.parameters))
    || (chunks.prompt && parseComfy(chunks.prompt))
    || (chunks.Comment && parseNovelAI(chunks.Comment, chunks))
    || null;
  if (!info || !String(info.prompt || '').trim()) return null;
  if (!info.width && png.width) info.width = png.width;
  if (!info.height && png.height) info.height = png.height;
  return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== ''));
};
