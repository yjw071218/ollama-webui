// An OpenAI-compatible endpoint in front of the account.
//
//   GET  /v1/models
//   POST /v1/chat/completions      (stream or not)
//
// Anything that speaks the OpenAI API -- VS Code extensions, Obsidian plugins,
// scripts, `openai` SDKs with `base_url` changed -- can then use the models on
// this machine *with the account's context*: its system prompt, its memories,
// and passages from its knowledge library, added on the server
// (server/accountContext.js). Plain Ollama already offers /v1; what this adds
// is the account.
//
// Authentication is an API key made in Settings (server/apiKeys.js), sent as
// `Authorization: Bearer wk-...`. That is the whole of it: these paths are
// exempt from the access-token gate in server/index.js because a client like
// an editor plugin cannot do the cookie dance, and a 256-bit key is a stronger
// credential than the shared token anyway.
//
// Per request, a `webui` object (removed before forwarding) switches the
// additions:  { "webui": { "memory": false, "knowledge": false, "system": false } }
// or the header `X-WebUI-Context: off` turns all three off.
//
// Tools, web search and drawing still live in the browser and are not here;
// the client's own `tools` are passed through to the model untouched, so an
// agent that brings its own tools works as it would against Ollama.

import { userForApiKey, presentedApiKey } from './apiKeys.js';
import { accountContext, accountSystemPrompt, accountDefaultModel } from './accountContext.js';

const MAX_BODY = 32 * 1024 * 1024;

const sendJson = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

/** OpenAI's error shape, which is what every client knows how to show. */
const fail = (res, status, message, type = 'invalid_request_error', code = null) =>
  sendJson(res, status, { error: { message, type, code } });

const readJson = async (req) => {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(buf);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {
    throw Object.assign(new Error('The body is not JSON.'), { status: 400 });
  }
};

/** Text of a message whose content may be a string or OpenAI content parts. */
export const textOf = (content) => (typeof content === 'string'
  ? content
  : Array.isArray(content)
    ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
    : '');

/**
 * The messages to forward: the client's, with the account's context folded
 * into one system message at the front. One, because several models accept
 * exactly one system message and silently drop the rest.
 */
export const withAccountContext = (messages, { system = '', context = '' } = {}) => {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const first = list[0]?.role === 'system' || list[0]?.role === 'developer' ? list.shift() : null;
  const clientSystem = first ? textOf(first.content) : '';
  // The client's own system prompt wins over the account's: a tool that sets
  // one knows what it is for. The account's is used only when there is none.
  const merged = [clientSystem || system, context].filter(s => String(s || '').trim()).join('\n\n');
  return merged ? [{ role: 'system', content: merged }, ...list] : list;
};

export const createOpenAiRoutes = (env = {}, { backend = 'ollama', beforeInference = async () => 'idle', fetchImpl = fetch } = {}) => {
  const base = backend === 'llamacpp'
    ? String(env.LLAMACPP_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '')
    : String(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

  const authenticate = (req, res) => {
    const who = userForApiKey(presentedApiKey(req));
    if (!who) {
      fail(res, 401, 'A valid API key is required. Make one in Settings > Account > API keys.', 'invalid_api_key', 'invalid_api_key');
      return null;
    }
    return who;
  };

  // CORS: an API is called from other origins by design, and the key -- not
  // a cookie -- is the credential, so allowing any origin grants nothing.
  const cors = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-WebUI-Context, x-api-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }
    return false;
  };

  const models = async (req, res) => {
    if (cors(req, res)) return;
    if (!authenticate(req, res)) return;
    try {
      const upstream = await fetchImpl(`${base}/v1/models`, { signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) return fail(res, 502, `The model server answered HTTP ${upstream.status}.`, 'api_error');
      const data = await upstream.json();
      sendJson(res, 200, { object: 'list', data: (data.data || []).map(m => ({ id: m.id, object: 'model', created: m.created || 0, owned_by: m.owned_by || 'local' })) });
    } catch (e) {
      fail(res, 502, `The model server is not reachable: ${e.message}`, 'api_error');
    }
  };

  const completions = async (req, res) => {
    if (cors(req, res)) return;
    if (req.method !== 'POST') return fail(res, 405, 'POST required.');
    const who = authenticate(req, res);
    if (!who) return;

    let body;
    try { body = await readJson(req); } catch (e) { return fail(res, e.status || 400, e.message); }
    if (!Array.isArray(body.messages) || body.messages.length === 0) return fail(res, 400, '`messages` is required.');

    const switches = body.webui && typeof body.webui === 'object' ? body.webui : {};
    delete body.webui;
    const off = /^(off|false|0|none)$/i.test(String(req.headers['x-webui-context'] || ''));
    const lastUser = [...body.messages].reverse().find(m => m?.role === 'user');
    const question = textOf(lastUser?.content);

    const context = off ? '' : accountContext(who.userId, question, {
      memory: switches.memory !== false,
      knowledge: switches.knowledge !== false,
    });
    const system = off || switches.system === false ? '' : accountSystemPrompt(who.userId);
    body.messages = withAccountContext(body.messages, { system, context });
    if (!body.model) body.model = accountDefaultModel(who.userId);
    if (!body.model) return fail(res, 400, '`model` is required (and the account has no default model).');

    // Pictures and video let go of the card first, as for any chat.
    const state = await beforeInference().catch(() => 'idle');
    if (state === 'drawing') {
      return fail(res, 503, 'The GPU is drawing a picture right now; try again shortly.', 'server_busy');
    }

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let upstream;
    try {
      upstream = await fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      return fail(res, 502, `The model server is not reachable: ${e.message}`, 'api_error');
    }

    // Streamed or not, the answer is passed through as it comes: both
    // backends already speak this dialect, and re-encoding it would only be
    // a place to lose a field a client relies on.
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (body.stream) res.setHeader('X-Accel-Buffering', 'no');
    try {
      for await (const chunk of upstream.body) res.write(chunk);
    } catch (e) {
      // The client went away, or the model server did. Either way the
      // response is over.
    }
    res.end();
  };

  return [
    { path: '/v1/models', handler: models },
    { path: '/v1/chat/completions', handler: completions },
  ];
};
