/**
 * Whether this model, at this context length, will fit on this card.
 *
 * The README spends a page on why `--flash-attn` and a quantised KV cache are
 * worth switching engine for, and the argument is entirely about a number:
 * whether 34% of the layers end up on the GPU or 100% of them, which is two to
 * three times the speed. Everything needed to work that number out is already
 * on screen — the card's size is in the monitor, the model's is in the picker,
 * and `num_ctx` is a slider in Settings — and the person moving the slider is
 * the one part of the system that has to guess.
 *
 * They guess badly, in a specific direction, because nothing fails. Ollama
 * loads what fits and runs the rest on the CPU: no error, no warning, a model
 * that works and is ten to twenty times slower. The monitor can say so
 * *afterwards* — `residency` in `src/monitor.js` does exactly that — but by
 * then the twenty-gigabyte read has happened and the answer is already being
 * generated at three tokens a second.
 *
 * This is the same arithmetic done beforehand.
 *
 * ## It is an estimate, and it says so
 *
 * Nothing here can be exact. The compute buffer depends on the batch size, the
 * CUDA context on the driver, and the desktop compositor is holding some of
 * the card no matter what. What it *can* do is be right about the shape: that
 * 32k of context on a 14B model costs more VRAM than the difference between
 * Q4 and Q8, which is the trade nobody makes correctly by feel, and that the
 * card has four gigabytes free rather than fourteen.
 *
 * So every number it produces is rounded down and labelled as an estimate, and
 * the recommendation it makes is one step more conservative than the
 * arithmetic allows. A tool that says "this fits" and is wrong teaches people
 * to ignore it; one that says 8k where 10k would have worked costs almost
 * nothing, because the marginal context is the part least often used.
 */

/* What one element of the KV cache weighs, by cache type. Ollama's default is
   f16; `OLLAMA_KV_CACHE_TYPE` and llama.cpp's `--cache-type-k/v` change it,
   and halving this is the whole of the trick the README recommends. */
export const KV_BYTES = { f16: 2, q8_0: 1, q4_0: 0.5 };

/* What is on the card that is not the model.
 *
 * The CUDA context, the compute buffer, and — on the machine this is written
 * for — a desktop compositor that is using the same card to draw the window
 * this is displayed in. A gigabyte is the honest round number: it is more than
 * a headless server needs and less than a Windows desktop with a browser open
 * actually costs, and erring upward here means erring toward "it will not
 * fit", which is the cheap direction to be wrong in. */
export const OVERHEAD_BYTES = 1024 * 1024 * 1024;

/* Context lengths worth recommending. Powers of two because every model's own
   training length is one, and because a recommendation of 11,583 invites the
   question of where the number came from. */
const STEPS = [1024, 2048, 4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304, 131072];

/**
 * What a model's metadata says about its KV cache, as far as it says anything.
 *
 * `/api/show` returns `model_info` keyed by architecture — `llama.block_count`,
 * `qwen3.attention.head_count_kv` — so the keys are matched by suffix rather
 * than by a table of architectures that would need a line adding for every
 * model released.
 *
 * Returns nulls rather than guesses for what is missing. A KV estimate built
 * on an assumed layer count is a confident number about the wrong model, and
 * the caller can say "this cannot be estimated" perfectly well.
 */
export const readArchitecture = (show) => {
  const info = show?.model_info || {};
  const find = (suffix) => {
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith(suffix) && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  };

  const layers = find('.block_count');
  const embedding = find('.embedding_length');
  const heads = find('.attention.head_count');
  const kvHeads = find('.attention.head_count_kv') ?? heads;
  const trained = find('.context_length');

  /* The dimension one token occupies in the cache, per layer, for K or V.
   *
   * `head_count_kv` is the point of the whole calculation: grouped-query
   * attention gives a 70B model eight key/value heads against sixty-four
   * query heads, so its cache is eight times smaller than the parameter count
   * suggests. Treating kv heads as query heads overestimates by that factor
   * and would recommend 4k where 32k fits. */
  const headDim = embedding && heads ? embedding / heads : null;
  const kvDim = headDim && kvHeads ? headDim * kvHeads : null;

  return { layers, embedding, heads, kvHeads, kvDim, trained };
};

/**
 * What the KV cache costs, in bytes, for a given context.
 *
 * Two caches — keys and values — each `layers × kvDim × context` elements.
 * Null when the architecture is unknown, which the caller must handle rather
 * than treat as zero: zero is the answer that says everything fits.
 */
export const kvBytes = ({ layers, kvDim }, context, cacheType = 'f16') => {
  if (!layers || !kvDim || !context) return null;
  const bytes = KV_BYTES[cacheType] ?? KV_BYTES.f16;
  return 2 * layers * kvDim * context * bytes;
};

/**
 * The largest context from `STEPS` that fits in what is free.
 *
 * `free` is what the card has available *now*, which is the number that
 * matters: a card with a picture model resident has however much is left, and
 * a recommendation computed from the card's total size would be advice for a
 * machine nobody is sitting at.
 */
export const maxContext = (architecture, {
  free,
  weights,
  cacheType = 'f16',
  overhead = OVERHEAD_BYTES,
} = {}) => {
  if (!Number.isFinite(free) || !Number.isFinite(weights)) return null;
  const room = free - weights - overhead;
  if (room <= 0) return 0;

  let best = 0;
  for (const step of STEPS) {
    const cost = kvBytes(architecture, step, cacheType);
    if (cost === null) return null;
    if (cost <= room) best = step; else break;
  }
  return best;
};

/**
 * How much of the model will actually be on the card.
 *
 * The number nothing tells you until afterwards. Layers are assumed equal in
 * size, which they are not — the embedding and output layers are larger — but
 * the error is a few percent against an answer whose useful resolution is
 * "all of it" against "two thirds of it".
 */
export const residencyEstimate = (architecture, {
  free,
  weights,
  context,
  cacheType = 'f16',
  overhead = OVERHEAD_BYTES,
} = {}) => {
  const cache = kvBytes(architecture, context, cacheType);
  if (cache === null || !Number.isFinite(free) || !Number.isFinite(weights) || !weights) return null;

  const room = free - cache - overhead;
  if (room <= 0) return { onGpu: 0, layers: 0, ofLayers: architecture.layers };
  if (room >= weights) return { onGpu: 1, layers: architecture.layers, ofLayers: architecture.layers };

  const share = room / weights;
  return {
    onGpu: share,
    layers: Math.floor(share * (architecture.layers || 0)),
    ofLayers: architecture.layers,
  };
};

/* Below this share of the weights on the card, the answer is generated partly
   on the CPU and the difference is not subtle. Matches FULLY_RESIDENT in
   src/monitor.js, which reports the same condition after the fact. */
const FULLY_RESIDENT = 0.99;

/**
 * The whole verdict for one model at one context length.
 *
 * `verdict` is one of:
 *
 *   'fits'      — all of it on the card, with the context asked for
 *   'tight'     — it fits, and there is little room left for anything else
 *   'offloaded' — part of it will run on the CPU
 *   'unknown'   — the metadata did not say enough to work it out
 *
 * `suggest` is the context to offer instead, and is present only when it
 * differs from what was asked for *and* would change the verdict. A
 * recommendation that does not fix anything is noise.
 */
export const assess = ({
  show,
  weights,
  free,
  context,
  cacheType = 'f16',
  overhead = OVERHEAD_BYTES,
} = {}) => {
  const architecture = readArchitecture(show);
  const cache = kvBytes(architecture, context, cacheType);

  if (cache === null || !Number.isFinite(free) || !Number.isFinite(weights)) {
    return { verdict: 'unknown', architecture };
  }

  const resident = residencyEstimate(architecture, { free, weights, context, cacheType, overhead });
  const needed = weights + cache + overhead;
  const headroom = free - needed;
  const best = maxContext(architecture, { free, weights, cacheType, overhead });

  /* Offered only when it would move the verdict. On a card with room to spare,
     "you could use 32k" is a fact nobody asked for; on one that is about to
     offload half the model, it is the answer. */
  const suggest = resident.onGpu < FULLY_RESIDENT && best > 0 && best < context ? best : null;

  /* Past the length it was trained at, a model does not fail -- it gets
     steadily worse, which is the failure nothing reports. Worth saying
     alongside the memory verdict rather than instead of it: they are
     different problems with the same slider. */
  const beyondTrained = architecture.trained && context > architecture.trained
    ? architecture.trained
    : null;

  const verdict = resident.onGpu >= FULLY_RESIDENT
    ? (headroom < OVERHEAD_BYTES ? 'tight' : 'fits')
    : 'offloaded';

  return {
    verdict,
    architecture,
    cache,
    weights,
    needed,
    headroom,
    free,
    onGpu: resident.onGpu,
    layers: resident.layers,
    ofLayers: resident.ofLayers,
    best,
    suggest,
    beyondTrained,
    /* What halving the cache would buy, since it is the one lever that costs
       nothing but a flag -- and the README argues for it at length without
       anything ever putting a number on it for the model in front of you. */
    quantisedCache: cacheType === 'f16'
      ? maxContext(architecture, { free, weights, cacheType: 'q8_0', overhead })
      : null,
  };
};

/** Bytes, as something short enough for a line of interface. */
export const gb = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1e9).toFixed(1)} GB` : '—');
