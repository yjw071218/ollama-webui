/**
 * Talking to llama.cpp as though it were Ollama.
 *
 * ## Why a translator rather than a rewrite
 *
 * The browser half of this app speaks one dialect and speaks it everywhere:
 * `/api/chat` streaming NDJSON, `/api/tags` for the model list, `/api/show` for
 * what a model can do, `/api/ps`, `/api/pull`, `/api/embed`. That dialect is
 * Ollama's, and it is load-bearing in a way that is easy to underestimate —
 * vision routing reads `capabilities`, the tool loop reads `message.tool_calls`,
 * the footer under every answer reads `eval_count` and `eval_duration`, the
 * continuation button reads `done_reason`, and several thousand tests read all
 * of it.
 *
 * So the client is not touched. The dialect becomes the app's *internal*
 * protocol, and this file makes llama.cpp speak it. Switching backends then
 * costs one environment variable and changes nothing above this line.
 *
 * ## Why llama.cpp is worth the trouble, and why less than you would think
 *
 * Ollama runs llama.cpp. Measured head to head the gap is real but modest —
 * around ten percent — and it comes from the wrapper, not the arithmetic.
 *
 * The reason to do this anyway is the flags. On a machine where the model does
 * not fit in VRAM, `--flash-attn` and a quantised KV cache are not a ten
 * percent question: they decide how many layers land on the GPU at all, and the
 * difference between 34% offloaded and 100% offloaded is two to three times the
 * speed. Ollama does not expose them. llama-server takes them on the command
 * line, and `status.args` reports back what each model was actually loaded
 * with — which is why `/api/show` below can finally tell the truth about the
 * context size instead of echoing whatever the client asked for.
 *
 * ## What llama-server gives us
 *
 * Router mode (`llama-server --models-dir …`) is what makes the mapping
 * possible at all: it serves many models from one port, loads them on demand by
 * the `model` field, and exposes a small management API. Without it there is no
 * model list, no switching, and no download — three things the app's UI is
 * built around.
 *
 *     /api/chat      ->  POST /v1/chat/completions   (SSE -> NDJSON)
 *     /api/embed     ->  POST /v1/embeddings
 *     /api/tags      ->  GET  /models
 *     /api/show      ->  GET  /models + GET /props?model=
 *     /api/ps        ->  GET  /models, filtered to the loaded ones
 *     /api/pull      ->  POST /models + GET /models/sse   (progress)
 *     /api/delete    ->  POST /models/unload
 *     /api/generate  ->  POST /v1/chat/completions, or /models/unload for
 *                        the `keep_alive: 0` "evict this model" call
 *
 * The translation functions are exported and pure, because the alternative is
 * code that can only be exercised by having a GPU, a model file and a running
 * server — which is the same as not being exercised.
 */

/* ---------------------------------------------------------------- plumbing */

const DEFAULT_TIMEOUT = 300000;   // a cold 30B load is minutes, not seconds

/** One JSON request to llama-server, with a deadline. */
export const callServer = async (base, path, { method = 'GET', body, signal, timeout = DEFAULT_TIMEOUT } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  // The caller's abort (the reader pressed Stop) and ours (the deadline) are
  // two reasons to give up on one request, and both have to reach it.
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const jsonOf = async (res) => {
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
  return res.json();
};

/* ------------------------------------------------------- images on messages

   Ollama hangs images off the message as bare base64 in `message.images`.
   OpenAI puts them inside the content as data URLs. The bytes are the same; the
   only thing genuinely missing is the media type, and it is recoverable —
   base64 preserves the leading magic bytes of the file it encodes, so the first
   few characters of the string say what it is. Guessing wrong here is not
   cosmetic: a JPEG announced as a PNG is rejected by the loader. */

const MAGIC = [
  ['iVBORw0KGgo', 'image/png'],
  ['/9j/', 'image/jpeg'],
  ['R0lGOD', 'image/gif'],
  ['UklGR', 'image/webp'],
  ['Qk0', 'image/bmp'],
];

export const imageMime = (base64) => {
  const head = String(base64 || '').slice(0, 16);
  for (const [prefix, mime] of MAGIC) if (head.startsWith(prefix)) return mime;
  // PNG is the safest wrong answer: it is what a screenshot is, which is what
  // most images pasted into a chat are.
  return 'image/png';
};

const asDataUrl = (image) => {
  const text = String(image || '');
  // Already a data URL. The app strips the prefix before sending, but an
  // attachment that arrived from somewhere else may not have been.
  if (text.startsWith('data:')) return text;
  return `data:${imageMime(text)};base64,${text}`;
};

/* ------------------------------------------------------ request translation */

/**
 * Ollama sampling names to llama-server's.
 *
 * llama-server accepts most of these under their llama.cpp names rather than
 * OpenAI's, which is convenient: `repeat_penalty`, `top_k` and `min_p` have no
 * OpenAI equivalent at all and would otherwise be silently dropped — and a
 * dropped `repeat_penalty` is not a subtle difference, it is a model that
 * starts looping.
 */
const SAMPLING = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  repeat_penalty: 'repeat_penalty',
  presence_penalty: 'presence_penalty',
  frequency_penalty: 'frequency_penalty',
  seed: 'seed',
};

/** What a thinking level becomes on the wire. */
const thinkingFields = (think) => {
  if (think === undefined || think === null) return {};
  // `false` is "do not think", and the template kwarg is what the models that
  // support switchable reasoning (Qwen3 and the rest) actually read.
  if (think === false) return { chat_template_kwargs: { enable_thinking: false } };
  if (think === true) return { chat_template_kwargs: { enable_thinking: true } };
  // A level. `reasoning_effort` is the OpenAI spelling and what llama-server
  // forwards into the template for models that grade their own effort.
  return {
    reasoning_effort: think,
    chat_template_kwargs: { enable_thinking: true, reasoning_effort: think },
  };
};

/** Ollama's `format` to OpenAI's `response_format`. */
const responseFormat = (format) => {
  if (!format) return {};
  if (format === 'json') return { response_format: { type: 'json_object' } };
  if (typeof format === 'object') {
    return { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: format, strict: true } } };
  }
  return {};
};

/**
 * One message, in OpenAI's shape.
 *
 * Three things differ and all three are silent failures if missed: images move
 * into the content, an assistant's tool calls carry a JSON *string* rather than
 * an object, and a tool *result* is addressed by `tool_call_id` rather than by
 * the tool's name.
 */
export const toOpenAiMessage = (message, callIds = new Map()) => {
  const role = message?.role || 'user';
  const text = typeof message?.content === 'string' ? message.content : '';

  if (role === 'tool') {
    return {
      role: 'tool',
      content: text,
      // The id the assistant used when it asked. Falling back to the name keeps
      // a transcript restored from storage — where the ids were never kept —
      // from being rejected outright.
      tool_call_id: callIds.get(message?.tool_name) || message?.tool_call_id || message?.tool_name || 'call',
    };
  }

  const out = { role, content: text };

  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    out.tool_calls = message.tool_calls.map((call, i) => {
      const name = call?.function?.name || '';
      const id = call?.id || `call_${i}_${name}`;
      if (name) callIds.set(name, id);
      const args = call?.function?.arguments;
      return {
        id,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
        },
      };
    });
    // OpenAI wants null, not "", beside tool calls.
    if (!text) out.content = null;
  }

  if (Array.isArray(message?.images) && message.images.length > 0) {
    out.content = [
      ...(text ? [{ type: 'text', text }] : []),
      ...message.images.map(image => ({ type: 'image_url', image_url: { url: asDataUrl(image) } })),
    ];
  }

  return out;
};

/**
 * A whole `/api/chat` body, as `/v1/chat/completions` wants it.
 *
 * `num_ctx` is deliberately dropped, and this is the one place the two servers
 * genuinely disagree rather than merely spelling things differently. In Ollama
 * the context length is a per-request option; in llama.cpp it is fixed when the
 * model is loaded, because the KV cache is allocated then. Passing it would be
 * worse than dropping it — the request would look honoured and would not be.
 * `/api/show` reports the real figure instead, read back off the running
 * server, so the composer's context gauge measures against the truth.
 */
export const toChatRequest = (body = {}, { stream = true } = {}) => {
  const options = body.options || {};
  const callIds = new Map();
  const out = {
    model: body.model,
    messages: (body.messages || []).map(m => toOpenAiMessage(m, callIds)),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    // Without this llama-server reports nothing about how long it took, and
    // every answer in the transcript loses its footer.
    timings_per_token: false,
    ...thinkingFields(body.think),
    ...responseFormat(body.format),
  };

  for (const [from, to] of Object.entries(SAMPLING)) {
    if (options[from] !== undefined && options[from] !== null && options[from] !== '') {
      out[to] = options[from];
    }
  }

  // -1 is Ollama for "no limit", and OpenAI has no such value: the field is
  // simply left out.
  if (Number.isFinite(options.num_predict) && options.num_predict >= 0) {
    out.max_tokens = options.num_predict;
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) out.stop = options.stop;
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;

  return out;
};

/* ----------------------------------------------------- response translation */

const ns = (ms) => (Number.isFinite(ms) ? Math.round(ms * 1e6) : undefined);

/**
 * The final `done` frame, built from whatever the server was willing to say.
 *
 * `timings` is llama.cpp's own and the better source: it separates reading the
 * prompt from writing the answer, which is the distinction the footer is drawn
 * around. `usage` is the OpenAI fallback and carries counts but no durations.
 * Either may be absent, and the client already knows how to estimate from its
 * own clock when they are — so the job here is to pass on what exists and
 * invent nothing.
 */
export const toDoneFrame = (model, { timings, usage, finishReason } = {}) => {
  const frame = {
    model,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content: '' },
    done: true,
    // `length` is what the continuation button looks for; everything else
    // reads as a finished answer.
    done_reason: finishReason === 'length' ? 'length' : 'stop',
  };

  const promptMs = timings?.prompt_ms;
  const predictedMs = timings?.predicted_ms;

  const promptTokens = timings?.prompt_n ?? usage?.prompt_tokens;
  const evalTokens = timings?.predicted_n ?? usage?.completion_tokens;

  if (Number.isFinite(promptTokens)) frame.prompt_eval_count = promptTokens;
  if (Number.isFinite(evalTokens)) frame.eval_count = evalTokens;
  if (Number.isFinite(promptMs)) frame.prompt_eval_duration = ns(promptMs);
  if (Number.isFinite(predictedMs)) frame.eval_duration = ns(predictedMs);
  if (Number.isFinite(promptMs) && Number.isFinite(predictedMs)) {
    frame.total_duration = ns(promptMs + predictedMs);
  }
  // Nothing here loads the model as a separate measurable step the way Ollama
  // does, so this is honestly zero rather than absent: the client shows it as
  // "why was the first message slow", and a missing field would read as a
  // measurement that failed rather than a cost that was not paid.
  frame.load_duration = 0;

  return frame;
};

/**
 * Accumulates a `/v1/chat/completions` stream and emits Ollama frames.
 *
 * Tool calls are the reason this is a class rather than a function. OpenAI
 * streams them in fragments — a name in one chunk, three characters of JSON
 * arguments in the next, indexed rather than named — and they are only a call
 * once the last fragment has landed. Ollama emits each call whole. So they are
 * gathered here and released with the final frame, which is also where the app
 * expects to find them.
 */
export class ChatTranslator {
  constructor(model) {
    this.model = model;
    this.calls = new Map();
    this.finishReason = null;
    this.usage = null;
    this.timings = null;
    this.sawContent = false;
  }

  /** One parsed SSE payload in; zero or more Ollama frames out. */
  accept(chunk) {
    const frames = [];
    if (!chunk || typeof chunk !== 'object') return frames;

    // The usage-only chunk that closes an OpenAI stream carries an empty
    // `choices`, so this must not be gated on there being a choice.
    if (chunk.usage) this.usage = chunk.usage;
    if (chunk.timings) this.timings = chunk.timings;

    const choice = chunk.choices?.[0];
    if (!choice) return frames;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta || choice.message || {};

    // Reasoning first: it arrives before the answer, and the app renders it
    // into the same <think> block it builds for every other backend.
    if (delta.reasoning_content) {
      frames.push({
        model: this.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '', thinking: delta.reasoning_content },
        done: false,
      });
    }

    if (delta.content) {
      this.sawContent = true;
      frames.push({
        model: this.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: delta.content },
        done: false,
      });
    }

    for (const fragment of delta.tool_calls || []) {
      const key = fragment.index ?? fragment.id ?? this.calls.size;
      const held = this.calls.get(key) || { name: '', args: '' };
      if (fragment.function?.name) held.name = fragment.function.name;
      if (fragment.function?.arguments) held.args += fragment.function.arguments;
      this.calls.set(key, held);
    }

    return frames;
  }

  /** The last frame, with the tool calls and the numbers. */
  finish() {
    const frame = toDoneFrame(this.model, {
      timings: this.timings,
      usage: this.usage,
      finishReason: this.finishReason,
    });
    if (this.calls.size > 0) {
      frame.message.tool_calls = [...this.calls.values()]
        .filter(call => call.name)
        .map(call => ({ function: { name: call.name, arguments: call.args || '{}' } }));
    }
    return frame;
  }
}

/**
 * Server-sent events, as whole payloads.
 *
 * Written as a fold over chunks rather than a stream so it can be tested with
 * a string, and because the buffering rule is the entire content of the bug it
 * would otherwise have: an event is not an event until its blank line arrives,
 * and a `data:` line can be cut in half by a network boundary at any point.
 */
export const sseEvents = (buffer) => {
  const events = [];
  let rest = buffer;
  // Normalise CRLF so a server that sends it does not leave a stray \r on the
  // end of every payload — which is a JSON parse error, once per chunk.
  rest = rest.replace(/\r\n/g, '\n');

  let index;
  while ((index = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');
    if (!data) continue;
    if (data === '[DONE]') { events.push({ done: true }); continue; }
    try { events.push({ payload: JSON.parse(data) }); } catch (e) { /* half a payload */ }
  }
  return { events, rest };
};

/* ------------------------------------------------------- model translation */

/** llama.cpp says what a model can take and give; the app asks in Ollama's words. */
export const capabilitiesOf = (entry, props) => {
  const caps = ['completion'];
  const inputs = entry?.architecture?.input_modalities || [];
  const outputs = entry?.architecture?.output_modalities || [];

  if (inputs.includes('image') || props?.modalities?.vision) caps.push('vision');
  if (inputs.includes('audio')) caps.push('audio');

  // Whether the chat template has somewhere to put a tool. Asked rather than
  // assumed for exactly the reason `/api/show` was read in the first place:
  // handing tools to a model that has no slot for them is not an error anyone
  // reports, it is a model that writes prose about what it would have done.
  const templateCaps = props?.chat_template_caps || {};
  if (templateCaps.tools || templateCaps.tool_calls) caps.push('tools');
  else if (typeof props?.chat_template === 'string' && /tool_calls|tools\b/.test(props.chat_template)) {
    caps.push('tools');
  }

  if (templateCaps.thinking || templateCaps.reasoning) caps.push('thinking');
  // An embedding model produces vectors rather than text, and offering it in
  // the chat picker is offering a model that cannot answer.
  if (outputs.length > 0 && !outputs.includes('text')) caps.push('embedding');

  return caps;
};

/** The context length the model was actually loaded with, from its own argv. */
export const contextOf = (entry) => {
  const args = entry?.status?.args || [];
  for (let i = 0; i < args.length - 1; i++) {
    if (/^(-c|-ctx|--ctx-size|--ctx_size)$/.test(String(args[i]))) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
};

/** `GET /models` to `/api/tags`. */
export const toTags = (list = []) => ({
  models: list.map(entry => ({
    name: entry.id,
    model: entry.id,
    // The app sorts and displays these; absent is better than invented.
    modified_at: entry.modified_at || undefined,
    size: entry.size ?? entry.meta?.size ?? undefined,
    digest: entry.digest || undefined,
    details: {
      family: entry.architecture?.name || entry.meta?.architecture || '',
      parameter_size: entry.meta?.n_params ? `${Math.round(entry.meta.n_params / 1e9)}B` : '',
      quantization_level: /[:-](Q\d[^:/]*|IQ\d[^:/]*|F16|BF16)$/i.exec(entry.id)?.[1] || '',
    },
  })),
});

/** `GET /models` to `/api/ps`, which is "what is in memory right now". */
export const toPs = (list = []) => ({
  models: list
    .filter(entry => entry?.status?.value === 'loaded')
    .map(entry => ({
      name: entry.id,
      model: entry.id,
      size: entry.size ?? entry.meta?.size ?? 0,
      // llama.cpp does not report a VRAM/RAM split, and inventing one would put
      // a number in the monitor that nothing measured. The panel already treats
      // a missing figure as unknown.
      size_vram: undefined,
      context_length: contextOf(entry) || undefined,
    })),
});

/* ---------------------------------------------------------- download events

   `GET /models/sse` broadcasts download progress, load stages and state
   changes. The exact field names are not something to bet the feature on — this
   is a young endpoint and the app only needs three numbers out of it — so the
   plausible spellings are all accepted and anything unrecognised degrades to a
   status line rather than to an error. A progress bar that occasionally shows
   only a status is a smaller failure than a download that reports as broken. */

export const toPullFrame = (event) => {
  if (!event || typeof event !== 'object') return null;

  const total = event.total ?? event.total_bytes ?? event.size ?? event.bytes_total;
  const completed = event.completed ?? event.downloaded ?? event.received ?? event.bytes_downloaded;
  const status = event.status || event.state || event.type || event.event || 'downloading';

  const frame = { status: String(status) };
  if (Number.isFinite(Number(total)) && Number(total) > 0) frame.total = Number(total);
  if (Number.isFinite(Number(completed))) frame.completed = Number(completed);
  if (event.error) frame.error = String(event.error);
  return frame;
};

/** Whether a download event means the whole thing is over. */
export const pullFinished = (event) => {
  const state = String(event?.status || event?.state || event?.type || event?.event || '').toLowerCase();
  return /(^|_)(loaded|ready|complete|completed|done|success)($|_)/.test(state);
};

/* ============================================================== the routes

   Connect-style `(req, res)` handlers, the same shape `server/api.js` returns,
   so the dev middleware stack and the production server mount them the same way
   and cannot drift apart.

   They are registered only when the backend is llama.cpp. Under Ollama the
   existing proxy handles `/api/*` untouched, which is what keeps this a
   switchable backend rather than a replacement. */

const readBody = (req, limit = 32 * 1024 * 1024) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    // A chat carrying several images is genuinely large; anything past this is
    // not something to be buffering in memory.
    if (body.length > limit) reject(new Error('Request too large'));
  });
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
  });
  req.on('error', reject);
});

const sendJson = (res, payload, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const fail = (res, error, status = 502) => sendJson(res, { error: String(error?.message || error) }, status);

/** Start an NDJSON response: one JSON object per line, which is Ollama's shape. */
const openNdjson = (res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  // Nothing downstream should gather a progress stream into one lump.
  res.setHeader('X-Accel-Buffering', 'no');
  return (frame) => res.write(`${JSON.stringify(frame)}\n`);
};

/** Every model llama-server knows about, in its own shape. */
const listModels = async (base) => {
  const data = await jsonOf(await callServer(base, '/models', { timeout: 20000 }));
  return data.data || data.models || [];
};

export const createLlamaRoutes = (env = {}) => {
  const base = (env.LLAMACPP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  const routes = [];
  const route = (path, handler) => routes.push({ path, handler });

  /* ---------------------------------------------------------------- chat */

  route('/api/chat', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e, 400); }

    // Stop aborts the socket to us; that has to reach llama-server, or the GPU
    // carries on writing an answer nobody will ever see.
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    let upstream;
    try {
      upstream = await callServer(base, '/v1/chat/completions', {
        method: 'POST',
        body: toChatRequest(body, { stream: true }),
        signal: controller.signal,
      });
    } catch (e) {
      return fail(res, e);
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      // Passed through rather than flattened: the client reads this text to
      // decide whether a refused thinking level is worth retrying without one.
      return sendJson(res, { error: `llama-server HTTP ${upstream.status}: ${detail.slice(0, 400)}` }, upstream.status);
    }

    const write = openNdjson(res);
    const translator = new ChatTranslator(body.model);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        // The end of the body is a frame boundary, not a reason to stop
        // reading: the usage-and-timings chunk is the last thing on the wire
        // and arrives without a trailing blank line more often than not.
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (done) buffer += '\n\n';

        const { events, rest } = sseEvents(buffer);
        buffer = rest;
        for (const event of events) {
          if (event.done) continue;          // "[DONE]"; the real end is below
          for (const frame of translator.accept(event.payload)) write(frame);
        }
        if (done) break;
      }
      write(translator.finish());
    } catch (e) {
      // A mid-stream failure cannot become a status code, so it becomes a
      // frame. Silence here is a spinner that never stops.
      if (!controller.signal.aborted) {
        write({ model: body.model, error: String(e.message || e), done: true, done_reason: 'error' });
      }
    } finally {
      res.end();
    }
  });

  /* ------------------------------------------------------------ generate

     Two callers wear one endpoint in Ollama. `keep_alive: 0` with no prompt
     means "evict this model from memory", which llama.cpp spells as an unload;
     a real prompt is an ordinary completion. */

  route('/api/generate', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e, 400); }

    if (!body.prompt && (body.keep_alive === 0 || body.keep_alive === '0')) {
      try {
        await callServer(base, '/models/unload', { method: 'POST', body: { model: body.model }, timeout: 30000 });
        return sendJson(res, { model: body.model, done: true, done_reason: 'unload' });
      } catch (e) {
        return fail(res, e);
      }
    }

    const asChat = { ...body, messages: [{ role: 'user', content: body.prompt || '' }] };
    try {
      const data = await jsonOf(await callServer(base, '/v1/chat/completions', {
        method: 'POST',
        body: toChatRequest(asChat, { stream: false }),
      }));
      const choice = data.choices?.[0];
      sendJson(res, {
        model: body.model,
        created_at: new Date().toISOString(),
        response: choice?.message?.content || '',
        ...toDoneFrame(body.model, {
          timings: data.timings,
          usage: data.usage,
          finishReason: choice?.finish_reason,
        }),
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ------------------------------------------------------------ embedding */

  route('/api/embed', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e, 400); }
    const input = Array.isArray(body.input) ? body.input : [body.input].filter(Boolean);

    try {
      const data = await jsonOf(await callServer(base, '/v1/embeddings', {
        method: 'POST',
        body: { model: body.model, input },
        timeout: 120000,
      }));
      // OpenAI returns `data[].embedding`, indexed rather than ordered; the app
      // wants a bare array of vectors in request order.
      const rows = (data.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      sendJson(res, { model: body.model, embeddings: rows.map(row => row.embedding) });
    } catch (e) {
      fail(res, e);
    }
  });

  /* --------------------------------------------------------- the model list */

  route('/api/tags', async (req, res) => {
    try {
      sendJson(res, toTags(await listModels(base)));
    } catch (e) {
      fail(res, e);
    }
  });

  route('/api/ps', async (req, res) => {
    try {
      sendJson(res, toPs(await listModels(base)));
    } catch (e) {
      fail(res, e);
    }
  });

  /* What a model can do.

     Both halves are needed and neither is optional: `/models` knows the
     modalities without loading anything, and `/props` knows the chat template,
     which is the only place the answer to "can this take tools" is written
     down. `/props` is asked with `autoload=0`, because opening the settings
     panel must not drag a 30B model into VRAM to answer a question about it. */
  route('/api/show', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e, 400); }
    const name = body.model || body.name;

    try {
      const list = await listModels(base);
      const entry = list.find(m => m.id === name) || null;

      let props = null;
      try {
        props = await jsonOf(await callServer(
          base,
          `/props?model=${encodeURIComponent(name)}&autoload=0`,
          { timeout: 15000 },
        ));
      } catch (e) {
        // Not loaded, and not worth loading to answer this. The modalities from
        // the list alone still give vision, which is the capability that
        // decides what the app does with an image.
      }

      const context = contextOf(entry) || props?.default_generation_settings?.n_ctx || null;
      sendJson(res, {
        capabilities: capabilitiesOf(entry, props),
        details: {
          family: entry?.architecture?.name || '',
          parameter_size: entry?.meta?.n_params ? `${Math.round(entry.meta.n_params / 1e9)}B` : '',
        },
        // Named the way Ollama names it, so the composer's context gauge finds
        // it without knowing which backend answered.
        model_info: context ? { 'llama.context_length': context } : {},
        // Where the model actually is, which llama.cpp knows and Ollama does not.
        path: entry?.path || undefined,
      });
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------------------------------------------------------- downloading

     Ollama streams NDJSON progress from `/api/pull`; llama-server broadcasts it
     on a separate SSE channel that is not tied to the request that started the
     download. So this subscribes first and asks second — the other order loses
     the early events of a small model, which is every event of a small model. */

  route('/api/pull', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e, 400); }
    const name = body.model || body.name;
    if (!name) return sendJson(res, { error: 'A model name is required' }, 400);

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const write = openNdjson(res);
    write({ status: 'starting' });

    let events;
    try {
      // No deadline: a download is as long as it is.
      events = await callServer(base, '/models/sse', { signal: controller.signal, timeout: 0 });
    } catch (e) {
      write({ status: 'error', error: String(e.message || e) });
      return res.end();
    }

    try {
      const started = await callServer(base, '/models', {
        method: 'POST',
        body: { model: name },
        signal: controller.signal,
        timeout: 60000,
      });
      if (!started.ok) {
        const detail = await started.text().catch(() => '');
        write({ status: 'error', error: `llama-server HTTP ${started.status}: ${detail.slice(0, 200)}` });
        return res.end();
      }
    } catch (e) {
      write({ status: 'error', error: String(e.message || e) });
      return res.end();
    }

    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (done) buffer += '\n\n';
        const { events: parsed, rest } = sseEvents(buffer);
        buffer = rest;

        for (const event of parsed) {
          if (event.done) continue;
          const payload = event.payload;
          // The channel carries every model's news, not only ours.
          const about = payload?.model || payload?.id || payload?.name;
          if (about && about !== name) continue;

          const frame = toPullFrame(payload);
          if (frame) write(frame);
          if (frame?.error) { res.end(); return; }
          if (pullFinished(payload)) {
            write({ status: 'success' });
            res.end();
            return;
          }
        }
        if (done) break;
      }
      write({ status: 'success' });
    } catch (e) {
      if (!controller.signal.aborted) write({ status: 'error', error: String(e.message || e) });
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  /* Removing one.

     llama.cpp's unload frees the memory and leaves the file. That is a real
     difference from Ollama, where delete removes the blob, and it is reported
     as what it is rather than papered over: a GGUF is a file the user chose to
     download to a directory they named, and a web page should not delete it. */
  route('/api/delete', async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (e) { return fail(res, e, 400); }
    const name = body.model || body.name;
    try {
      const upstream = await callServer(base, '/models/unload', {
        method: 'POST', body: { model: name }, timeout: 30000,
      });
      if (!upstream.ok) return fail(res, new Error(`HTTP ${upstream.status}`));
      sendJson(res, { status: 'success', unloadedOnly: true });
    } catch (e) {
      fail(res, e);
    }
  });

  return routes;
};

/** Whether this build should be talking to llama.cpp at all. */
export const backendOf = (env = {}) =>
  (String(env.LLM_BACKEND || 'ollama').trim().toLowerCase() === 'llamacpp' ? 'llamacpp' : 'ollama');
