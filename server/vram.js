/**
 * One graphics card, two tenants, one at a time.
 *
 * The language model (Ollama or llama.cpp) and the picture model (ComfyUI) are
 * separate processes, and neither knows the other exists. Asked for a picture
 * in a conversation, the chat model has just answered and is still resident —
 * kept there by `keep_alive` on purpose — when ComfyUI loads a checkpoint, a
 * text encoder, a VAE and an upscaler on top of it. On a 16GB card that is not
 * two things sharing: it is both of them spilling into system RAM, a generation
 * of two minutes taking ten, and a desktop that stutters for all of it.
 *
 * Ollama makes it worse in the other direction. It decides how many layers go
 * on the GPU at load time, from what is free at that moment — so a chat model
 * loaded while ComfyUI still holds its checkpoint loads mostly onto the CPU and
 * stays slow until it is next reloaded.
 *
 * So the server takes turns on the card's behalf, because it is the one thing
 * both kinds of request pass through:
 *
 *   - before a ComfyUI job is queued, every loaded language model is unloaded;
 *   - before the next inference request, ComfyUI is told to let go of its
 *     models — only if one of our jobs could have left them there, and only
 *     when its queue is empty, so a picture already being drawn is never pulled
 *     out from under itself.
 *
 * Each switch costs a reload, a few seconds from a warm disk cache. That is the
 * price of a machine that stays usable, and anyone with a card big enough for
 * both can turn it off with VRAM_EXCLUSIVE=false.
 */

import { backendOf } from './llamacpp.js';

const trimmed = (url) => String(url).replace(/\/$/, '');

/** The requests that load a language model, and so need the card to themselves. */
export const INFERENCE_PATHS = ['/api/chat', '/api/generate', '/api/embed', '/api/embeddings'];

export const isInference = (pathname = '') =>
  INFERENCE_PATHS.some(p => pathname === p || pathname.startsWith(`${p}?`));

export const exclusiveEnabled = (env = {}) =>
  String(env.VRAM_EXCLUSIVE ?? 'true').trim().toLowerCase() !== 'false';

/* Names of what is loaded, from either backend's own listing. llama.cpp's
   router lists every model it knows and marks the resident ones. */
export const loadedOllama = (ps) => (ps?.models || []).map(m => m.name || m.model).filter(Boolean);
export const loadedLlama = (list) => (list?.data || list?.models || [])
  .filter(entry => entry?.status?.value === 'loaded')
  .map(entry => entry.id)
  .filter(Boolean);

/** What ComfyUI's own torch is holding, in bytes; null when it will not say. */
export const comfyHolding = (stats) => {
  const card = stats?.devices?.[0];
  return Number.isFinite(card?.torch_vram_total) ? card.torch_vram_total : null;
};

/** Is ComfyUI busy with anything, running or waiting? */
export const comfyBusy = (queue) =>
  (queue?.queue_running || []).length > 0 || (queue?.queue_pending || []).length > 0;

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* Half a gigabyte: past measurement noise and under the smallest model worth
   unloading. Below it, ComfyUI has nothing to give back. */
const WORTH_FREEING = 512 * 1024 * 1024;

export const createVramGuard = (env = {}, { fetchImpl } = {}) => {
  const enabled = exclusiveEnabled(env);
  const backend = backendOf(env);
  const ollama = trimmed(env.OLLAMA_URL || 'http://127.0.0.1:11434');
  const llama = trimmed(env.LLAMACPP_URL || 'http://127.0.0.1:8080');
  const comfy = trimmed(env.COMFYUI_URL
    || `http://${env.COMFYUI_HOST || '127.0.0.1'}:${env.COMFYUI_PORT || 8188}`);

  const call = async (url, { method = 'GET', body, timeout = 10000 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      // Looked up per call, so whatever `fetch` is at the time is the one used.
      const res = await (fetchImpl || globalThis.fetch)(url, {
        method,
        signal: controller.signal,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json().catch(() => ({}));
    } finally {
      clearTimeout(timer);
    }
  };

  /* Whether one of our jobs may have left models in ComfyUI. Only our own:
     a ComfyUI used from its own tab is somebody's deliberate choice, and a
     chat message is no reason to empty it. */
  let comfyMayHold = false;

  // One release at a time. Three requests arriving together — a title, a
  // summary and the next question — should cause one unload, not three.
  let llmRelease = null;
  let comfyRelease = null;

  const loadedModels = async () => (backend === 'llamacpp'
    ? loadedLlama(await call(`${llama}/models`, { timeout: 8000 }))
    : loadedOllama(await call(`${ollama}/api/ps`, { timeout: 8000 })));

  const unloadModel = (name) => (backend === 'llamacpp'
    ? call(`${llama}/models/unload`, { method: 'POST', body: { model: name }, timeout: 30000 })
    // No prompt and keep_alive 0 is Ollama's documented "unload this now".
    : call(`${ollama}/api/generate`, { method: 'POST', body: { model: name, keep_alive: 0 }, timeout: 30000 }));

  /**
   * Take every language model off the card, and wait until it is off.
   *
   * Waiting matters: the unload call returns when the request is accepted, and
   * ComfyUI sizes what it keeps on the GPU from what is free when it loads. A
   * job queued the instant the call returned would find the card still full.
   * Resolves with the names unloaded; never throws, because a backend that is
   * not running has nothing on the card and is no reason to refuse a picture.
   */
  const releaseLlm = () => {
    if (!enabled) return Promise.resolve([]);
    if (llmRelease) return llmRelease;
    llmRelease = (async () => {
      let names = [];
      try {
        names = await loadedModels();
        if (!names.length) return [];
        await Promise.all(names.map(name => unloadModel(name).catch(() => null)));
        // A model mid-answer unloads when the answer ends, so this is bounded
        // rather than insisted on.
        for (let waited = 0; waited < 15000; waited += 300) {
          const still = await loadedModels().catch(() => []);
          if (!still.length) break;
          await pause(300);
        }
      } catch {
        // Not running, or not answering: either way it holds nothing here.
      }
      return names;
    })().finally(() => { llmRelease = null; });
    return llmRelease;
  };

  /**
   * Have ComfyUI let go of its models, if it may be holding ours and is idle.
   *
   * `/free` sets a flag the worker acts on, so success is read from ComfyUI's
   * own torch figure rather than assumed: the next thing to happen is Ollama
   * measuring free VRAM to decide where its layers go.
   */
  const releaseComfy = () => {
    if (!enabled || !comfyMayHold) return Promise.resolve(false);
    if (comfyRelease) return comfyRelease;
    comfyRelease = (async () => {
      try {
        const queue = await call(`${comfy}/queue`, { timeout: 5000 });
        // Something is being drawn. Pulling its models out would not stop it,
        // only make it reload them; it is freed on a later request instead.
        if (comfyBusy(queue)) return false;

        const before = comfyHolding(await call(`${comfy}/system_stats`, { timeout: 5000 }).catch(() => null));
        await call(`${comfy}/free`, { method: 'POST', body: { unload_models: true, free_memory: true }, timeout: 5000 });
        comfyMayHold = false;
        if (before !== null && before > WORTH_FREEING) {
          for (let waited = 0; waited < 5000; waited += 250) {
            await pause(250);
            const now = comfyHolding(await call(`${comfy}/system_stats`, { timeout: 5000 }).catch(() => null));
            if (now === null || before - now > WORTH_FREEING || now < WORTH_FREEING) break;
          }
        }
        return true;
      } catch {
        // ComfyUI has gone away, which frees its memory more thoroughly than
        // any call could.
        comfyMayHold = false;
        return false;
      }
    })().finally(() => { comfyRelease = null; });
    return comfyRelease;
  };

  return {
    enabled,
    releaseLlm,
    releaseComfy,
    /** A job of ours was queued; its models may still be there afterwards. */
    comfyUsed: () => { comfyMayHold = true; },
    /** Run before an inference request is passed on. Cheap when there is nothing to do. */
    beforeInference: () => (enabled && comfyMayHold ? releaseComfy() : Promise.resolve(false)),
  };
};

/* One guard per set of addresses, shared by the Studio routes and the
   inference hook — they must agree on whether ComfyUI may be holding models,
   and they are created in different places (api.js, vite.config.js,
   server/index.js). */
const guards = new Map();

export const vramGuard = (env = {}) => {
  const key = [
    exclusiveEnabled(env), backendOf(env), env.OLLAMA_URL, env.LLAMACPP_URL,
    env.COMFYUI_URL, env.COMFYUI_HOST, env.COMFYUI_PORT,
  ].join('|');
  if (!guards.has(key)) guards.set(key, createVramGuard(env));
  return guards.get(key);
};
