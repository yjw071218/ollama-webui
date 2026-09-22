// Will this model, at this context, fit on this card. The arithmetic is short
// and every term in it is one somebody's evening depends on: getting the KV
// head count wrong recommends 4k where 32k fits, and getting the overhead
// wrong recommends a load that runs half on the CPU.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.fit-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/fit.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  readArchitecture, kvBytes, maxContext, residencyEstimate, assess, gb,
  KV_BYTES, OVERHEAD_BYTES,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const GB = 1e9;

// A real shape: Qwen3 14B. 40 layers, 5120 wide, 40 query heads and 8 KV heads
// -- the grouped-query ratio that this whole calculation turns on.
const QWEN14B = {
  model_info: {
    'qwen3.block_count': 40,
    'qwen3.embedding_length': 5120,
    'qwen3.attention.head_count': 40,
    'qwen3.attention.head_count_kv': 8,
    'qwen3.context_length': 40960,
    'general.architecture': 'qwen3',
  },
};

// ------------------------------------------------------------- architecture
const arch = readArchitecture(QWEN14B);
check('layers are read', arch.layers === 40);
check('the width is read', arch.embedding === 5120);
check('so is the trained context', arch.trained === 40960);

// The point of the whole calculation. Grouped-query attention gives this model
// eight key/value heads against forty query heads, so its cache is five times
// smaller than the parameter count suggests. Treating kv heads as query heads
// would recommend 4k where 32k fits.
check('the head dimension comes from the query heads', arch.kvDim === (5120 / 40) * 8);
check('and the cache width from the KV heads', arch.kvDim === 1024);

// Keys are matched by suffix, not by a table of architectures that would need
// a line adding for every model released.
check('another architecture prefix works the same',
  readArchitecture({ model_info: { 'gemma3.block_count': 26 } }).layers === 26);

// A model with no grouped-query attention reports only head_count.
check('head_count_kv falls back to head_count',
  readArchitecture({ model_info: {
    'llama.attention.head_count': 32, 'llama.embedding_length': 4096, 'llama.block_count': 32,
  } }).kvDim === 4096);

// Nulls rather than guesses: an estimate built on an assumed layer count is a
// confident number about the wrong model.
check('missing metadata is null, not a guess', readArchitecture({}).layers === null);
check('and so is the cache width', readArchitecture({}).kvDim === null);
check('no argument at all is safe', readArchitecture(null).layers === null);

// ------------------------------------------------------------------ KV size
// 2 caches x 40 layers x 1024 wide x 8192 tokens x 2 bytes = 1.34 GB
const cache8k = kvBytes(arch, 8192);
check('the cache is both K and V', cache8k === 2 * 40 * 1024 * 8192 * 2, String(cache8k));
check('and it is about 1.3 GB at 8k', Math.abs(cache8k / GB - 1.342) < 0.01, gb(cache8k));
check('four times the context is four times the cache', kvBytes(arch, 32768) === cache8k * 4);

// The lever the README argues for at length without ever putting a number on it.
check('a q8 cache is half an f16 one', kvBytes(arch, 8192, 'q8_0') === cache8k / 2);
check('and q4 is a quarter', kvBytes(arch, 8192, 'q4_0') === cache8k / 4);
check('an unknown cache type falls back to f16', kvBytes(arch, 8192, 'nonsense') === cache8k);
check('KV_BYTES says what each costs', KV_BYTES.f16 === 2 && KV_BYTES.q8_0 === 1);

// Zero would be the answer that says everything fits.
check('an unknown architecture gives null, not zero', kvBytes({}, 8192) === null);
check('no context gives null', kvBytes(arch, 0) === null);

// ------------------------------------------------------------- max context
// A 16 GB card with a 9 GB model: 16 - 9 - 1 overhead = 6 GB for the cache,
// which at 0.168 GB per 1024 tokens is about 36k -- so 32768 from the steps.
const card16 = { free: 16 * GB, weights: 9 * GB };
check('the biggest fitting step is chosen', maxContext(arch, card16) === 32768,
  String(maxContext(arch, card16)));
check('the steps are round numbers', [1024, 2048, 4096, 8192].includes(maxContext(arch, { free: 11 * GB, weights: 9 * GB })));

// Halving the cache roughly doubles the context, which is the trade the whole
// engine-switching argument is about.
const quantised = maxContext(arch, { ...card16, cacheType: 'q8_0' });
check('a quantised cache buys more context', quantised > 32768, String(quantised));

// The number that matters is what is free now, not what the card holds: a card
// with a picture model resident has however much is left.
check('a busy card recommends less',
  maxContext(arch, { free: 5 * GB, weights: 9 * GB }) === 0);
check('a model that does not fit at all is zero, not null',
  maxContext(arch, { free: 2 * GB, weights: 9 * GB }) === 0);
check('an unknown architecture is null', maxContext({}, card16) === null);
check('missing numbers are null', maxContext(arch, { free: 16 * GB }) === null);

// -------------------------------------------------------------- residency
const full = residencyEstimate(arch, { ...card16, context: 8192 });
check('a model that fits is wholly on the card', full.onGpu === 1 && full.layers === 40);

// The number nothing tells you until afterwards, by which time the twenty
// gigabyte read has already happened.
const partial = residencyEstimate(arch, { free: 8 * GB, weights: 9 * GB, context: 8192 });
check('a model that does not fit is partly on the CPU', partial.onGpu > 0 && partial.onGpu < 1,
  String(partial.onGpu));
check('and the layer count says how much', partial.layers > 0 && partial.layers < 40,
  String(partial.layers));

const none = residencyEstimate(arch, { free: 1 * GB, weights: 9 * GB, context: 8192 });
check('a card with no room holds none of it', none.onGpu === 0 && none.layers === 0);

// ---------------------------------------------------------------- verdicts
const fits = assess({ show: QWEN14B, weights: 9 * GB, free: 16 * GB, context: 8192 });
check('a comfortable load says it fits', fits.verdict === 'fits', fits.verdict);
check('and offers no advice nobody asked for', fits.suggest === null);
check('but does say what the cache costs', Math.abs(fits.cache - cache8k) < 1);

const tight = assess({ show: QWEN14B, weights: 9 * GB, free: 10.8 * GB, context: 4096 });
check('a load with nothing to spare says so', tight.verdict === 'tight', tight.verdict);

const offloaded = assess({ show: QWEN14B, weights: 9 * GB, free: 8 * GB, context: 32768 });
check('a load that will spill says so', offloaded.verdict === 'offloaded', offloaded.verdict);
check('and says how much of it lands on the card', offloaded.onGpu < 1 && offloaded.onGpu > 0);

// A suggestion is offered only when it would change the verdict: on a card
// with room to spare, "you could use 32k" is a fact nobody asked for.
const fixable = assess({ show: QWEN14B, weights: 9 * GB, free: 11 * GB, context: 32768 });
check('a smaller context is suggested when it would fix it',
  fixable.suggest !== null && fixable.suggest < 32768, String(fixable.suggest));
check('and the suggestion is one of the steps',
  [1024, 2048, 4096, 8192, 12288, 16384].includes(fixable.suggest), String(fixable.suggest));

const hopeless = assess({ show: QWEN14B, weights: 9 * GB, free: 3 * GB, context: 8192 });
check('a model far too big gets no suggestion, because none would help',
  hopeless.suggest === null, String(hopeless.suggest));

check('what a quantised cache would allow is reported',
  fixable.quantisedCache > fixable.best, `${fixable.quantisedCache} vs ${fixable.best}`);

// Past its trained length a model does not fail -- it gets steadily worse,
// which is a different problem with the same slider.
const beyond = assess({ show: QWEN14B, weights: 9 * GB, free: 40 * GB, context: 65536 });
check('going past the trained context is reported', beyond.beyondTrained === 40960);
check('and staying inside it is not', fits.beyondTrained === null);

const unknown = assess({ show: {}, weights: 9 * GB, free: 16 * GB, context: 8192 });
check('a model that cannot be estimated says so', unknown.verdict === 'unknown');
const noCard = assess({ show: QWEN14B, weights: 9 * GB, context: 8192 });
check('and so does a machine that will not report its card', noCard.verdict === 'unknown');

check('the overhead is a named number', OVERHEAD_BYTES > 0);
check('bytes print short', gb(9.4 * GB) === '9.4 GB' && gb(null) === '—');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
