/**
 * What a picture shows, according to a small image classifier.
 *
 * NSFWJS's MobileNetV2: five classes (Drawing, Hentai, Neutral, Porn, Sexy),
 * trained on photographs *and* drawings — which is the reason for choosing it,
 * since the Studio makes both. It runs in the browser, on the GPU through
 * WebGL where there is one, so no picture is sent anywhere to be judged.
 *
 * Loaded on first use and not before: TensorFlow.js and the model are about
 * five megabytes that someone who never opens the Studio should not download.
 *
 * One picture at a time. Sixty cards restored from history would otherwise
 * start sixty inferences at once and the tab would stall under all of them,
 * each finishing later than it would have in a queue.
 */

const SIDE = 224;   // the model's input; drawing into it is the resize
const STORE = 'nsfwVerdicts';
const STORE_LIMIT = 400;

/* ----------------------------------------------------------- the cache */

/* A key that stands for the picture, not for how it was asked for. The same
   file is fetched as a WebP thumbnail in the gallery and as the PNG in the
   viewer, and it is one picture. A data: URL is the picture itself and can be
   megabytes long, so it is keyed by a hash of its length and a sample of it. */
export const cacheKey = (src) => {
  const value = String(src || '');
  if (value.startsWith('data:')) {
    let h = 2166136261;
    const step = Math.max(1, Math.floor(value.length / 4096));
    for (let i = 0; i < value.length; i += step) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return `d:${value.length}:${h.toString(36)}`;
  }
  return value.replace(/[?&]preview=[^&]*/, '').replace(/\?$/, '');
};

const memory = new Map();

const readStore = () => {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
};

const remember = (key, scores) => {
  memory.set(key, scores);
  try {
    const all = readStore();
    all[key] = scores;
    const keys = Object.keys(all);
    // Oldest first, because insertion order is kept — so the trim drops those.
    for (const old of keys.slice(0, Math.max(0, keys.length - STORE_LIMIT))) delete all[old];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch (e) { /* quota: the memory copy still answers for this visit */ }
};

export const knownScores = (src) => {
  const key = cacheKey(src);
  if (memory.has(key)) return memory.get(key);
  const stored = readStore()[key];
  if (stored) memory.set(key, stored);
  return stored || null;
};

/* ----------------------------------------------------------- the model */

let modelPromise = null;

const loadModel = () => {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await import('@tensorflow/tfjs');
      try { tf.enableProdMode(); } catch (e) { /* already running */ }
      await tf.ready();
      /* The lean entry, with one model handed to it.
       *
       * Plain `nsfwjs` carries the definitions of all three of its models,
       * and those definitions are the weights themselves as base64 — so
       * importing it built 40MB of chunks, 29MB of which is an InceptionV3
       * nothing here ever loads. `nsfwjs/core` has no models of its own and
       * takes the one it should use, which leaves 3.4MB. */
      const [{ load }, { MobileNetV2Model }] = await Promise.all([
        import('nsfwjs/core'),
        import('nsfwjs/models/mobilenet_v2'),
      ]);
      return load('MobileNetV2', { modelDefinitions: [MobileNetV2Model] });
    })().catch((e) => {
      // Not cached as a failure: a flaky first load should not mean never.
      modelPromise = null;
      throw e;
    });
  }
  return modelPromise;
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('The picture could not be loaded'));
  img.src = src;
});

/* ---------------------------------------------------------- classifying */

let queue = Promise.resolve();
const inflight = new Map();

/**
 * The five scores for a picture, lower-cased: `{ drawing, hentai, neutral,
 * porn, sexy }`, each 0–1.
 *
 * `src` is what to download and look at (a thumbnail will do: the model sees
 * 224 pixels whatever it is given), `key` what to remember it under.
 */
export const classify = (src, key = cacheKey(src)) => {
  const known = memory.get(key) || readStore()[key];
  if (known) return Promise.resolve(known);
  if (inflight.has(key)) return inflight.get(key);

  const run = queue.then(async () => {
    const model = await loadModel();
    const img = await loadImage(src);
    const canvas = document.createElement('canvas');
    canvas.width = SIDE;
    canvas.height = SIDE;
    canvas.getContext('2d').drawImage(img, 0, 0, SIDE, SIDE);
    const predictions = await model.classify(canvas, 5);
    const scores = {};
    for (const { className, probability } of predictions) {
      scores[String(className).toLowerCase()] = Math.round(probability * 1000) / 1000;
    }
    remember(key, scores);
    return scores;
  });
  queue = run.catch(() => {});
  inflight.set(key, run);
  run.then(() => inflight.delete(key), () => inflight.delete(key));
  return run;
};
