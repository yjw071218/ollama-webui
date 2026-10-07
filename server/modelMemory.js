/**
 * Which language models to take out of memory before loading another.
 *
 * `vram.js` already keeps the language model and ComfyUI from sitting on the
 * card together. What it did not do is keep language models from piling up on
 * each other: a chat model, a second chat model picked from the menu, the
 * model that writes titles, an embedding model for the library -- each stays
 * resident for Ollama's `keep_alive`, and the next one loads into whatever is
 * left. On a 16GB card that is the second chat model going mostly onto the CPU
 * and the turn taking minutes, or Ollama refusing outright with "model requires
 * more system memory than is available" -- the memory error that showed up
 * only sometimes, because it depended on what had been used in the last five
 * minutes.
 *
 * So before a model that is not resident is loaded, the idle ones that would
 * crowd it are unloaded first; and if Ollama still answers with an
 * out-of-memory error, everything idle goes and the request is tried once
 * more. A model that is answering another request is never touched.
 *
 * Off with SMART_MODEL_MEMORY=false.
 */

/** A model this size or larger is a chat model rather than an embedder or a tiny helper. */
export const BIG_MODEL_BYTES = 1.5 * 1024 ** 3;

/** RAM to leave for everything else on the machine when deciding whether a load fits. */
export const RAM_RESERVE_BYTES = 2 * 1024 ** 3;

export const smartMemoryEnabled = (env = {}) =>
  String(env.SMART_MODEL_MEMORY ?? 'true').trim().toLowerCase() !== 'false';

/** Ollama's spellings of "that did not fit". */
export const isOutOfMemory = (text) => /requires more system memory|out of memory|insufficient (?:system )?memory|not enough memory|failed to allocate|cudaMalloc|unable to allocate|memory layout cannot be allocated/i
  .test(String(text || ''));

const sameModel = (a, b) => {
  const norm = (n) => String(n || '').trim().toLowerCase().replace(/:latest$/, '');
  return norm(a) === norm(b);
};

/**
 * The resident models to unload so `requested` can load.
 *
 *   resident  [{ name, size }] from /api/ps
 *   busy      names answering a request right now (never unloaded)
 *   size      bytes of the requested model, 0 when unknown
 *   freeRam   bytes of system RAM free now
 *   all       unload every idle model (the retry after an out-of-memory error)
 *
 * Largest first, and only as many as the rule needs.
 */
export const planUnload = ({ requested, resident = [], busy = [], size = 0, freeRam = Infinity, all = false } = {}) => {
  if (!requested) return [];
  if (!all && resident.some(m => sameModel(m.name, requested))) return [];
  const isBusy = (name) => busy.some(b => sameModel(b, name));
  const idle = resident
    .filter(m => m?.name && !sameModel(m.name, requested) && !isBusy(m.name))
    .sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
  if (all) return idle.map(m => m.name);

  const chosen = new Set();
  // A large model coming in: another large one sitting idle is the thing in its way.
  if (size >= BIG_MODEL_BYTES) {
    for (const m of idle) if ((Number(m.size) || 0) >= BIG_MODEL_BYTES) chosen.add(m.name);
  }
  // And whatever else it takes for the load to fit in RAM, largest first.
  const need = size > 0 ? size * 1.2 + RAM_RESERVE_BYTES : RAM_RESERVE_BYTES;
  let room = freeRam;
  for (const m of idle) if (chosen.has(m.name)) room += Number(m.size) || 0;
  for (const m of idle) {
    if (room >= need) break;
    if (chosen.has(m.name)) continue;
    chosen.add(m.name);
    room += Number(m.size) || 0;
  }
  return idle.filter(m => chosen.has(m.name)).map(m => m.name);
};

/** The model a chat/generate/embed request body names, or ''. */
export const requestedModel = (body) => {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || ''));
    return typeof parsed?.model === 'string' ? parsed.model : '';
  } catch {
    return '';
  }
};

/**
 * The live half: asks Ollama what is resident and how big things are, and
 * unloads what `planUnload` says. Every failure is swallowed -- making room is
 * an improvement on the request, never a reason to refuse it.
 */
export const createModelMemory = (env = {}, { fetchImpl, freemem, log = console.log } = {}) => {
  const enabled = smartMemoryEnabled(env);
  const ollama = String(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const busy = new Map(); // name -> requests in flight
  let sizes = { at: 0, byName: new Map() };

  const call = async (path, { method = 'GET', body, timeout = 8000 } = {}) => {
    const res = await (fetchImpl || globalThis.fetch)(`${ollama}${path}`, {
      method,
      signal: AbortSignal.timeout(timeout),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  };

  const sizeOf = async (name) => {
    if (Date.now() - sizes.at > 60000) {
      const tags = await call('/api/tags').catch(() => null);
      if (tags?.models) {
        sizes = { at: Date.now(), byName: new Map(tags.models.map(m => [String(m.name || m.model).toLowerCase(), Number(m.size) || 0])) };
      }
    }
    const key = String(name).toLowerCase();
    return sizes.byName.get(key) || sizes.byName.get(`${key}:latest`) || 0;
  };

  const resident = async () => {
    const ps = await call('/api/ps');
    return (ps?.models || []).map(m => ({ name: m.name || m.model, size: Number(m.size) || 0 })).filter(m => m.name);
  };

  const unload = async (names) => {
    if (!names.length) return [];
    log(`[memory] unloading idle model(s) to make room: ${names.join(', ')}`);
    await Promise.all(names.map(name => call('/api/generate', {
      method: 'POST', body: { model: name, keep_alive: 0 }, timeout: 30000,
    }).catch(() => null)));
    // Wait for them to actually leave, briefly: the load that follows sizes
    // itself from what is free when it starts.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const still = await resident().catch(() => []);
      if (!still.some(m => names.some(n => sameModel(n, m.name)))) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return names;
  };

  return {
    enabled,
    /** Unload what would crowd `model`. Resolves with the names unloaded. */
    makeRoom: async (model, { all = false } = {}) => {
      if (!enabled || !model) return [];
      try {
        const names = planUnload({
          requested: model,
          resident: await resident(),
          busy: [...busy.keys()],
          size: await sizeOf(model),
          freeRam: (freemem || (() => Infinity))(),
          all,
        });
        return await unload(names);
      } catch {
        return [];
      }
    },
    /** A request for `model` is under way. Returns the call that says it ended. */
    hold: (model) => {
      if (!model) return () => {};
      busy.set(model, (busy.get(model) || 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (busy.get(model) || 1) - 1;
        if (left > 0) busy.set(model, left); else busy.delete(model);
      };
    },
  };
};
