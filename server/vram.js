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
 *     cached models when its queue is empty, so a picture already being drawn is never pulled
 *     out from under itself;
 *   - and a request that arrives while one of our jobs is still being drawn —
 *     a question asked while a video renders, a title, a summary — receives
 *     a 503 response until ComfyUI finishes. Loading a CPU copy alongside a
 *     video also consumes system RAM and can make the entire desktop stall.
 *
 * Each switch costs a reload, a few seconds from a warm disk cache. That is the
 * price of a machine that stays usable, and anyone with a card big enough for
 * both can turn it off with VRAM_EXCLUSIVE=false.
 */

import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { readRequestBody } from './requestBody.js';
import { assertMemoryAvailable, memoryPressure } from './resourceSafety.js';
import https from 'node:https';
import { beginChatJob, appendChatChunk, finishChatJob, attachChatController } from './chatJobs.js';
import { ownerOfRequest } from './session.js';
import { backendOf } from './llamacpp.js';
import { createModelMemory, isOutOfMemory, requestedModel } from './modelMemory.js';
import os from 'node:os';

const trimmed = (url) => String(url).replace(/\/$/, '');

/* Generation has no idle deadline by default; explicit operator limits remain opt-in. */
export const OLLAMA_IDLE_MS = 0;

/** The requests that load a language model, and so need the card to themselves. */
export const INFERENCE_PATHS = ['/api/chat', '/api/generate', '/api/embed', '/api/embeddings'];

export const isInference = (pathname = '') =>
  INFERENCE_PATHS.some(p => pathname === p || pathname.startsWith(`${p}?`));

export const exclusiveEnabled = (env = {}) =>
  String(env.VRAM_EXCLUSIVE ?? 'true').trim().toLowerCase() !== 'false';

/* Names of what is loaded, from either backend's own listing. llama.cpp's
   router lists every model it knows and marks the resident ones. An Ollama
   model with nothing on the card -- one answering from the CPU while a video
   renders -- is not in the way of anything, so it is not listed. */
export const loadedOllama = (ps) => (ps?.models || [])
  .filter(m => m && m.size_vram !== 0)
  .map(m => m.name || m.model)
  .filter(Boolean);
export const loadedLlama = (list) => (list?.data || list?.models || [])
  .filter(entry => entry?.status?.value === 'loaded')
  .map(entry => entry.id)
  .filter(Boolean);

/** What ComfyUI's own torch is holding, in bytes; null when it will not say. */
/* Below this, what ComfyUI is holding is a CUDA context rather than a model,
   and freeing it buys nothing. */
const WORTH_FREEING = 512 * 1024 * 1024;

export const comfyHolding = (stats) => {
  const card = stats?.devices?.[0];
  return Number.isFinite(card?.torch_vram_total) ? card.torch_vram_total : null;
};

/** How big the card is, as ComfyUI reports it; null when it does not say. */
export const cardTotal = (stats) => {
  const card = stats?.devices?.[0];
  return Number.isFinite(card?.vram_total) && card.vram_total > 0 ? card.vram_total : null;
};

/**
 * Has ComfyUI let go of enough?
 *
 * Two ways of saying yes, and the second one exists because the first cannot
 * always be reached.
 *
 * The first is the absolute floor: a ComfyUI that has genuinely emptied itself
 * reports a torch pool of a few hundred megabytes or less.
 *
 * The second is the share. On this machine `/free` returns 200, unloads what
 * it can, and leaves `torch_vram_total` at exactly 0.600 GB — a CUDA context
 * and whatever a custom node is pinning — while the card itself reports 15.1
 * of 17.1 GB free. Asked again a second later it is still 0.600 GB, and a
 * second after that, because there is nothing left to release. Against a fixed
 * 512 MB line that install can never succeed, so every chat after any picture
 * was refused with "ComfyUI did not release GPU memory" on a card that was
 * almost entirely empty.
 *
 * What the caller actually needs to know is whether ComfyUI is still in the
 * way of the language model, and six hundred megabytes of an seventeen
 * gigabyte card is not in anybody's way. An eighth is the line: past that
 * ComfyUI is holding a model rather than a context, and the chat really would
 * be crippled by loading on top of it.
 *
 * With no `vram_total` reported there is nothing to take a share of, and the
 * absolute floor is the whole test — which is what it was before.
 */
export const comfyReleased = (held, total) => {
  if (!Number.isFinite(held)) return false;
  if (held < WORTH_FREEING) return true;
  return Number.isFinite(total) && total > 0 && held < total / 8;
};

/** Is ComfyUI busy with anything, running or waiting? */
export const comfyBusy = (queue) =>
  (queue?.queue_running || []).length > 0 || (queue?.queue_pending || []).length > 0;

/**
 * An Ollama request body, told to stay off the graphics card.
 *
 * `num_gpu: 0` is no layers on the GPU. `keep_alive: 0` matters as much: a
 * later request that does not name `num_gpu` is served by whatever copy is
 * already loaded, so a CPU copy left resident would go on answering slowly
 * after the video is done. Dropped after each answer, the first question after
 * the video loads the model onto the card again. Null for anything that is
 * not a JSON object, which is passed on as it came.
 */
export const offTheCard = (raw) => {
  try {
    const body = JSON.parse(String(raw));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return JSON.stringify({ ...body, keep_alive: 0, options: { ...(body.options || {}), num_gpu: 0 } });
  } catch {
    return null;
  }
};

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const connectionRefused = error => error?.code === 'ECONNREFUSED'
  || error?.cause?.code === 'ECONNREFUSED'
  || error?.cause?.errors?.some(e => e.code === 'ECONNREFUSED')
  || error?.message === 'ECONNREFUSED';

/* Half a gigabyte: past measurement noise and under the smallest model worth
   unloading. Below it, ComfyUI has nothing to give back. */


/* How long a language model still answering is given to finish before the
   requests keeping it on the card are stopped, and then how long the unload
   is waited for. */
const GRACE_MS = 5000;
const PATIENCE_MS = 15000;

export const createVramGuard = (env = {}, { fetchImpl, grace = GRACE_MS, patience = PATIENCE_MS } = {}) => {
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

  /* Track our jobs, but also check ComfyUI after a restart or external job.
     Idle cached models can be freed; running jobs are never interrupted. */
  let comfyMayHold = false;

  // One release at a time. Three requests arriving together — a title, a
  // summary and the next question — should cause one unload, not three.
  let llmRelease = null;
  let comfyRelease = null;
  let comfySubmissions = 0;

  const loadedModels = async () => (backend === 'llamacpp'
    ? loadedLlama(await call(`${llama}/models`, { timeout: 8000 }))
    : loadedOllama(await call(`${ollama}/api/ps`, { timeout: 8000 })));

  const unloadModel = (name) => (backend === 'llamacpp'
    ? call(`${llama}/models/unload`, { method: 'POST', body: { model: name }, timeout: 30000 })
    // No prompt and keep_alive 0 is Ollama's documented "unload this now".
    : call(`${ollama}/api/generate`, { method: 'POST', body: { model: name, keep_alive: 0 }, timeout: 30000 }));

  /* The language-model requests passing through this server right now, each
     with the way to stop it. See `track`. */
  const inflight = new Set();

  const offTheCardWithin = async (ms) => {
    const deadline = Date.now() + ms;
    do {
      const still = await loadedModels();
      if (!still.length) return true;
      await pause(300);
    } while (Date.now() < deadline);
    return false;
  };

  /**
   * Take every language model off the card, and wait until it is off.
   *
   * Waiting matters: the unload call returns when the request is accepted, and
   * ComfyUI sizes what it keeps on the GPU from what is free when it loads. A
   * job queued the instant the call returned would find the card still full.
   *
   * And asking is not enough while the model is answering something. Ollama
   * unloads a model only once nothing is using it, and a 31B model split
   * between the card and the CPU takes a minute over a summary or a title --
   * measured here, it sat on the card 35 seconds after being told to go. The
   * picture was queued after fifteen anyway, and started with 0.7GB free: every
   * model offloaded, and the PiD upscaler, handed a model half on the CPU,
   * crashed on it. So what is still answering after a short grace is stopped,
   * and then the unload is waited for.
   *
   * Resolves with names unloaded. Throws when release cannot be verified;
   * only a connection refusal is treated as an absent backend.
   */
  const releaseLlm = () => {
    if (!enabled) return Promise.resolve([]);
    if (llmRelease) return llmRelease;
    llmRelease = (async () => {
      let names = [];
      try {
        names = await loadedModels();
        if (!names.length && inflight.size) {
          for (const request of [...inflight]) request.stop();
          names = await loadedModels();
        }
        if (!names.length) return [];
        await Promise.all(names.map(name => unloadModel(name).catch(() => null)));
        if (await offTheCardWithin(grace)) return names;
        if (inflight.size) {
          console.log(`[vram] stopping ${inflight.size} language-model request(s) still holding the card, so ComfyUI can have it`);
          for (const request of [...inflight]) request.stop();
          // Asked again: the request that just ended may have been the one
          // the model was waiting on, or a queued one may have re-armed it.
          await Promise.all(names.map(name => unloadModel(name).catch(() => null)));
        }
        if (!await offTheCardWithin(patience)) {
          throw new Error('Language model did not release GPU memory. ComfyUI job was not started.');
        }
      } catch (error) {
        // Only a refused connection means the backend is absent. A timeout
        // can mean it is still loading a model and holding all available RAM.
        if (!connectionRefused(error)) throw error;
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
   *
   * Resolves with what it found: 'freed', 'drawing' when one of our jobs is
   * still on the card, or 'idle' when there was nothing to do.
   */
  const releaseComfy = () => {
    if (!enabled) return Promise.resolve('idle');
    if (comfyRelease) return comfyRelease;
    comfyRelease = (async () => {
      try {
        const queue = await call(`${comfy}/queue`, { timeout: 5000 });
        // Something is being drawn. Pulling its models out would not stop it,
        // only make it reload them; it is freed on a later request instead.
        if (comfyBusy(queue)) return 'drawing';

        const stats = await call(`${comfy}/system_stats`, { timeout: 5000 });
        const before = comfyHolding(stats);
        const total = cardTotal(stats);
        if (before === null) throw new Error('Cannot verify ComfyUI GPU memory; chat was not started.');
        if (!comfyMayHold && comfyReleased(before, total)) return 'idle';
        await call(`${comfy}/free`, { method: 'POST', body: { unload_models: true, free_memory: true }, timeout: 5000 });

        const deadline = Date.now() + 5000;
        let held = before;
        let stuck = 0;
        do {
          const now = await call(`${comfy}/system_stats`, { timeout: 5000 });
          const reading = comfyHolding(now);
          if (comfyReleased(reading, cardTotal(now) ?? total)) {
            comfyMayHold = false;
            return 'freed';
          }
          /* Still falling, or stopped? `/free` is asynchronous -- it sets a
             flag a worker acts on -- so a reading that has not moved yet may
             simply be early. A reading that has not moved three times running
             is a floor: this install has released everything it is going to,
             and waiting out the rest of the deadline only delays the answer
             by five seconds before refusing it anyway. */
          stuck = reading === held ? stuck + 1 : 0;
          held = reading;
          if (stuck >= 3) break;
          await pause(250);
        } while (Date.now() < deadline);

        /* What is left is a model, not a context, and loading on top of it is
           how both end up half on the CPU. Said with the numbers in it: the
           old message named neither, so an install stuck at a floor it could
           not go below looked exactly like one that was genuinely busy. */
        const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
        throw new Error(
          `ComfyUI is still holding ${gb(held)}${total ? ` of a ${gb(total)} card` : ''}; `
          + 'chat was not started.',
        );
      } catch (error) {
        if (!connectionRefused(error)) throw error;
        comfyMayHold = false;
        return 'idle';
      }
    })().finally(() => { comfyRelease = null; });
    return comfyRelease;
  };

  /**
   * Put the language model back on the card, now rather than at the next question.
   *
   * The unload before a picture has always been here -- a 22GB model and an
   * image model do not share a card, so `releaseLlm` takes it off. What was
   * missing was the other half: it came back only when something next asked it
   * a question, so the wait for it was paid in the middle of the reply, after
   * the picture, with the reader watching a spinner.
   *
   * ComfyUI is asked to let go first, because loading a model into the memory
   * ComfyUI is still holding is how both end up half on the CPU. A job still
   * being drawn is left alone and nothing is warmed: the picture is the thing
   * being waited for.
   *
   * An empty prompt is a load and nothing else -- Ollama answers it with an
   * empty response once the model is resident.
   */
  const warmLlm = async (model) => {
    if (!enabled || backend !== 'ollama' || !model) return 'skipped';
    const state = await releaseComfy();
    if (state === 'drawing') return 'drawing';
    await call(`${ollama}/api/generate`, {
      method: 'POST',
      // No `keep_alive`: whatever this install's default is, is what the next
      // question would have used anyway.
      body: { model, prompt: '' },
      // A cold 22GB read off a disk. The caller does not wait for this.
      timeout: 300000,
    });
    return 'warm';
  };

  /**
   * ComfyUI's RAM cache, let go of -- when nothing is being drawn.
   *
   * A finished picture or video leaves its models in ComfyUI's RAM cache: a
   * text encoder, a VAE and a diffusion model, tens of gigabytes after MiniMax.
   * The chat's own RAM check then refused every question with a 503 while
   * ComfyUI sat idle, and the browser held each one and retried it -- reported
   * as "전송하지 못해서 보관해 두었습니다" over and over. Asked before refusing,
   * so the refusal is left for a machine that really has no room.
   *
   * Resolves true once memory is no longer short; false when ComfyUI is busy,
   * absent, or freeing did not make enough room.
   */
  const releaseComfyMemory = async ({ wait = 8000 } = {}) => {
    try {
      const queue = await call(`${comfy}/queue`, { timeout: 5000 });
      if (comfyBusy(queue)) return false;
      await call(`${comfy}/free`, { method: 'POST', body: { unload_models: true, free_memory: true }, timeout: 5000 });
      comfyMayHold = false;
      const deadline = Date.now() + wait;
      do {
        if (!memoryPressure()) return true;
        await pause(400);
      } while (Date.now() < deadline);
      return !memoryPressure();
    } catch (error) {
      return false;
    }
  };

  return {
    enabled,
    warmLlm,
    releaseComfyMemory,
    isSwitching: () => enabled && (comfySubmissions > 0 || !!llmRelease),
    beginComfySubmission: () => {
      comfySubmissions++;
      let released = false;
      return () => { if (!released) { released = true; comfySubmissions--; } };
    },
    releaseLlm,
    releaseComfy,
    /** A job of ours was queued; its models may still be there afterwards. */
    comfyUsed: () => { comfyMayHold = true; },
    /** Check actual ComfyUI state even after a WebUI restart. */
    beforeInference: () => (enabled
      ? (comfySubmissions || llmRelease ? Promise.resolve('drawing') : releaseComfy())
      : Promise.resolve('idle')),
    /** A language-model request under way, and how to stop it. Returns the call that says it ended. */
    track: (stop) => {
      const request = { stop };
      inflight.add(request);
      return () => inflight.delete(request);
    },
  };
};

/** A request's whole body, as a Buffer. */
const readBody = readRequestBody;

/* What a request stopped for a picture answers with, when it had not started
   answering yet. A 503, which the chat already reads as "try again shortly"
   and keeps the question for. */
const STOPPED = 'Stopped: the graphics card was needed for a picture or video. Ask again in a moment.';

/**
 * The request, to Ollama, and back.
 *
 * `body` replaces the one it came with; left out, the original is streamed
 * through as it arrives. The browser going away stops it upstream too -- Ollama
 * goes on generating for a closed connection otherwise, and holds the card
 * while it does. `track` registers it with the guard, which can stop it when
 * ComfyUI needs the card (see `releaseLlm`).
 */
const forward = (target, req, res, body, track, completed, idleMs = OLLAMA_IDLE_MS, retry = null) => {
  const upstream = new URL(target);
  const jobId = String(req.headers['x-chat-job-id'] || '').trim();
  if (jobId) {
    // Whose answer, and for which conversation -- see `live` in server/chatJobs.js.
    const job = beginChatJob(jobId, {
      owner: ownerOfRequest(req),
      chat: String(req.headers['x-chat-conversation'] || '').trim(),
    });
    if (job.finished || job.controller) throw Object.assign(new Error('Chat job already exists; use replay or a new job ID'), { statusCode: 409 });
  }
  const headers = { ...req.headers, host: upstream.host };
  if (body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(body));
    delete headers['transfer-encoding'];
  }
  delete headers['x-access-token'];
  delete headers.cookie;
  const client = upstream.protocol === 'https:' ? https : http;
  const decoder = new StringDecoder('utf8');
  let answer, done = false, untrack = () => {};
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(memoryCheck);
    untrack();
    if (jobId) finishChatJob(jobId);
    completed();
  };
  const fail = (error, status = 502) => {
    if (done) return;
    const message = String(error?.message || error);
    if (jobId) appendChatChunk(jobId, '\n' + JSON.stringify({ error: message, done: true }) + '\n');
    if (!res.destroyed && !res.writableEnded) {
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.end('\n' + JSON.stringify({ error: message, done: true }) + '\n');
      }
    }
    finish();
    answer?.destroy();
    out?.destroy();
  };
  let out = null;
  let retried = false;
  /* One attempt. A second is made only when Ollama refused to load the model
     for lack of memory and `retry` has made room (see server/modelMemory.js);
     the refusal is read before anything is passed on, so the browser sees
     one answer either way. */
  const send = () => {
  const request = client.request({
    hostname: upstream.hostname, port: upstream.port, path: req.url,
    method: req.method, headers,
  }, incoming => {
    if (request !== out) { incoming.resume(); return; }
    if (retry && !retried && body !== undefined && (incoming.statusCode || 0) >= 400) {
      let text = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { if (text.length < 65536) text += chunk; });
      incoming.on('end', async () => {
        if (done || request !== out) return;
        if (isOutOfMemory(text)) {
          retried = true;
          out = null;
          try { await retry(); } catch { /* the second attempt says what is wrong */ }
          if (!done) send();
          return;
        }
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(incoming.statusCode || 502, incoming.headers);
          res.end(text);
        }
        if (jobId) appendChatChunk(jobId, `\n${JSON.stringify({ error: text.slice(0, 2000), done: true })}\n`);
        finish();
      });
      return;
    }
    answer = incoming;
    if (!res.destroyed) res.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.on('data', chunk => {
      if (done) return;
      if (jobId && !appendChatChunk(jobId, decoder.write(chunk))) {
        fail(new Error('Response memory limit reached'));
        return;
      }
      if (!res.destroyed && !res.writableEnded && !res.write(chunk)) incoming.pause();
    });
    incoming.on('error', fail);
    incoming.on('aborted', () => fail(new Error('Model response interrupted')));
    incoming.on('end', () => {
      if (done) return;
      if (jobId) {
        const tail = decoder.end();
        if (tail) appendChatChunk(jobId, tail);
        // Also terminates replay for empty or error responses lacking a done frame.
        appendChatChunk(jobId, '\n' + JSON.stringify({ done: true }) + '\n');
      }
      if (!res.destroyed && !res.writableEnded) res.end();
      finish();
    });
  });
  out = request;
  if (jobId) attachChatController(jobId, request);
  request.setTimeout(idleMs, () => { if (request === out) fail(new Error(`Model sent nothing for ${Math.round(idleMs / 1000)} seconds`), 504); });
  request.on('error', (error) => { if (request === out) fail(error); });
  request.on('close', () => {
    if (request === out && !done) fail(new Error('Model connection closed before completion'));
  });
  if (body === undefined) req.pipe(request);
  else request.end(body);
  };
  const memoryCheck = setInterval(() => {
    if (memoryPressure(true)) fail(new Error('Generation stopped: system RAM is critically low'), 503);
  }, 2000);
  memoryCheck.unref?.();
  untrack = track ? track(() => fail(new Error(STOPPED), 503)) : () => {};
  /* How long Ollama may send nothing before this gives up on it.

     It was two minutes, and two minutes of silence is ordinary: a 20GB model
     loading cold, seven thousand tokens of prompt read before the first word,
     and -- the one that was reported -- a model writing a tool call, which
     Ollama holds back until the call is complete, so a long song or video
     timeline is a minute and a half of generating with nothing on the wire.
     Ollama logged `500 | 2m0s | POST /api/chat` with the model 427 tokens in,
     the answer was thrown away, and the browser sent the same request again.
     There is no wall-clock ceiling; cancellation, connection errors and RAM protection remain. */
  res.on('drain', () => answer?.resume());
  res.on('error', () => {
    if (!jobId) fail(new Error('Chat subscriber disconnected'));
    else answer?.resume();
  });
  res.on('close', () => {
    if (!jobId && !res.writableFinished) fail(new Error('Chat subscriber disconnected'));
    else answer?.resume();
  });
  req.on('aborted', () => fail(new Error('Chat request aborted')));
  send();
};

/**
 * What both servers run in front of an inference request.
 *
 * ComfyUI is asked to let go of the card first (see `releaseComfy`). Then an
 * Ollama request is sent on from here rather than by the proxy, so that the
 * guard knows it is under way and can stop it when a picture needs the card.
 * While one of our jobs is still being drawn, new inference is refused.
 * Request size, concurrency and system RAM are bounded here.
 * llama.cpp decides its layers when it starts, not per request, and its routes
 * translate the request themselves, so its requests are passed on to `next()`.
 */
export const inferenceHook = (env = {}, options) => {
  const vram = vramGuard(env, options);
  const memory = createModelMemory(env, { fetchImpl: options?.fetchImpl, freemem: options?.freemem || os.freemem });
  const ollama = trimmed(env.OLLAMA_URL || 'http://127.0.0.1:11434');
  const onOllama = backendOf(env) === 'ollama';
  const idleMs = Number(env.OLLAMA_IDLE_TIMEOUT_MS) > 0 ? Number(env.OLLAMA_IDLE_TIMEOUT_MS) : OLLAMA_IDLE_MS;
  let active = 0;
  return async (req, res, next) => {
    if (req.method !== 'POST') return next();
    // Admit before buffering the request or asking a backend to load a model.
    let claimed = false;
    let released = false;
    const release = () => {
      if (claimed && !released) { released = true; active--; }
    };
    try {
      /* Short of RAM: the usual holder is ComfyUI's cache from the last picture,
         and it can be asked to let go. See releaseComfyMemory. */
      if (memoryPressure() && !(await vram.releaseComfyMemory())) assertMemoryAvailable();
      if (active >= 2) throw Object.assign(new Error('Two inference requests are already running. Try again after they finish.'), { statusCode: 503 });
      active++; claimed = true;
      const state = await vram.beforeInference();
      if (state === 'drawing') throw Object.assign(new Error('ComfyUI is generating. Try chatting after it finishes to avoid loading another model into RAM.'), { statusCode: 503 });
      if (!onOllama) {
        res.once('finish', release);
        res.once('close', release);
        return next();
      }
      const body = await readBody(req);
      if (vram.isSwitching()) throw Object.assign(new Error('GPU is switching to ComfyUI. Try again after generation finishes.'), { statusCode: 503 });
      if (res.destroyed) { release(); return; }
      /* Idle models that would crowd this one out go first, and an
         out-of-memory refusal gets one more try with everything idle gone.
         See server/modelMemory.js. */
      const model = requestedModel(body);
      await memory.makeRoom(model);
      if (res.destroyed) { release(); return; }
      const unhold = memory.hold(model);
      try {
        forward(ollama, req, res, body, vram.track, () => { unhold(); release(); }, idleMs,
          memory.enabled ? () => memory.makeRoom(model, { all: true }) : null);
      } catch (e) {
        // Refused before it started (a conversation already being answered):
        // the model hold must not outlive a request that never ran.
        unhold();
        throw e;
      }
    } catch (e) {
      release();
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(e.statusCode || 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, ...(e.code ? { code: e.code, busyJob: e.busyJob } : {}) }));
    }
  };
};

/* One guard per set of addresses, shared by the Studio routes and the
   inference hook — they must agree on whether ComfyUI may be holding models,
   and they are created in different places (api.js, vite.config.js,
   server/index.js). */
const guards = new Map();

export const vramGuard = (env = {}, options) => {
  const key = [
    exclusiveEnabled(env), backendOf(env), env.OLLAMA_URL, env.LLAMACPP_URL,
    env.COMFYUI_URL, env.COMFYUI_HOST, env.COMFYUI_PORT,
  ].join('|');
  // Options count only for the first to ask: the guard is shared on purpose.
  if (!guards.has(key)) guards.set(key, createVramGuard(env, options));
  return guards.get(key);
};
