import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-openai-'));
process.env.WEBUI_DATA_DIR = data;

const { closeDatabase, database } = await import('../server/db.js');
const { applyChanges } = await import('../server/records.js');
const { createApiKey, listApiKeys, revokeApiKey, userForApiKey } = await import('../server/apiKeys.js');
const { createOpenAiRoutes, withAccountContext } = await import('../server/openaiCompat.js');
const { accountContext } = await import('../server/accountContext.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
};

database().exec(`
  INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u1', 'A', 'password', 1, 0);
  INSERT INTO users (id, name, provider, created_at, rev) VALUES ('u2', 'B', 'password', 1, 0);
`);
const put = (owner, kind, id, payload) =>
  applyChanges(owner, { records: [{ kind, id, updatedAt: Date.now(), payload }] });

put('u1', 'setting', 'systemPrompt', 'You are terse.');
put('u1', 'setting', 'defaultModel', 'qwen3:8b');
put('u1', 'memory', 'm1', { id: 'm1', text: 'The user lives in Seoul.', kind: 'fact', enabled: true });
put('u1', 'memory', 'm2', { id: 'm2', text: 'Disabled memory', kind: 'fact', enabled: false });
put('u1', 'document', 'd1', {
  id: 'd1', name: 'router-manual.pdf', enabled: true,
  chunks: [
    { page: 3, text: 'To reset the ZX-9000 router, hold the WPS button for 12 seconds.' },
    { page: 4, text: 'The admin password is printed on the label under the device.' },
  ],
});
put('u1', 'document', 'd2', { id: 'd2', name: 'private-to-a-chat.txt', chatId: 'c9', chunks: [{ page: 1, text: 'ZX-9000 secret chat note' }] });
put('u2', 'memory', 'x', { id: 'x', text: 'Belongs to someone else', kind: 'fact', enabled: true });

try {
  // Keys.
  const made = createApiKey('u1', 'VS Code');
  check('a key is made and shown once', made.key.startsWith('wk-') && made.key.length > 40);
  check('the stored list has no key in it', !JSON.stringify(listApiKeys('u1')).includes(made.key));
  check('the key identifies its account', userForApiKey(made.key)?.userId === 'u1');
  check('a wrong key identifies nobody', userForApiKey(`${made.key}x`) === null && userForApiKey('sk-foo') === null);
  const stored = database().prepare('SELECT hash FROM api_keys').get().hash;
  check('only a hash is stored', stored.length === 64 && !stored.includes(made.key));

  // Context.
  const ctx = accountContext('u1', 'how do I reset my ZX-9000 router?');
  check('memories are included', ctx.includes('lives in Seoul'));
  check('disabled memories are not', !ctx.includes('Disabled memory'));
  check('the relevant library passage is found', ctx.includes('WPS button') && ctx.includes('router-manual.pdf p.3'));
  check('a chat-only document is not library', !ctx.includes('secret chat note'));
  check('another account\'s memories never appear', !ctx.includes('someone else'));

  const merged = withAccountContext([{ role: 'system', content: 'Client rules.' }, { role: 'user', content: 'hi' }], { system: 'Account rules.', context: 'CTX' });
  check('the client system prompt wins and context is appended, in one message',
    merged.length === 2 && merged[0].content === 'Client rules.\n\nCTX');
  const merged2 = withAccountContext([{ role: 'user', content: 'hi' }], { system: 'Account rules.', context: '' });
  check('the account prompt is used when the client has none', merged2[0].content === 'Account rules.');

  // Routes, against a fake model server.
  const sent = [];
  const fakeFetch = async (url, init = {}) => {
    sent.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/v1/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'qwen3:8b', created: 1 }] }), { headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(init.body);
    if (body.stream) {
      return new Response(Readable.toWeb(Readable.from(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n'])),
        { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello' } }] }), { headers: { 'content-type': 'application/json' } });
  };
  const routes = createOpenAiRoutes({}, { fetchImpl: fakeFetch });
  const call = async (p, { method = 'GET', key = made.key, body, headers = {} } = {}) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []);
    req.method = method;
    req.headers = { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers };
    const chunks = [];
    const res = {
      statusCode: 200, headers: {}, writableEnded: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      write(c) { chunks.push(Buffer.from(c)); },
      end(c) { if (c) chunks.push(Buffer.from(c)); this.writableEnded = true; },
      on() {},
    };
    await routes.find(r => r.path === p).handler(req, res);
    return { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') };
  };

  let r = await call('/v1/models', { key: null });
  check('no key is 401 in OpenAI\'s error shape', r.status === 401 && JSON.parse(r.text).error.code === 'invalid_api_key');
  r = await call('/v1/models');
  check('models are listed', r.status === 200 && JSON.parse(r.text).data[0].id === 'qwen3:8b');

  r = await call('/v1/chat/completions', { method: 'POST', body: { messages: [{ role: 'user', content: 'How do I reset the ZX-9000?' }] } });
  const forwarded = sent[sent.length - 1].body;
  check('a completion is answered', r.status === 200 && JSON.parse(r.text).choices?.[0]?.message?.content === 'Hello', r.text);
  check('the default model is filled in', forwarded.model === 'qwen3:8b');
  check('the account prompt, memories and passage are sent as one system message',
    forwarded.messages[0].role === 'system' && forwarded.messages[0].content.startsWith('You are terse.')
    && forwarded.messages[0].content.includes('Seoul') && forwarded.messages[0].content.includes('WPS'));

  await call('/v1/chat/completions', { method: 'POST', body: { model: 'm', webui: { memory: false, knowledge: false, system: false }, messages: [{ role: 'user', content: 'x' }] } });
  const bare = sent[sent.length - 1].body;
  check('the webui switches turn the additions off and are not forwarded',
    bare.messages.length === 1 && bare.webui === undefined);
  await call('/v1/chat/completions', { method: 'POST', headers: { 'x-webui-context': 'off' }, body: { model: 'm', messages: [{ role: 'user', content: 'ZX-9000' }] } });
  check('so does the header', sent[sent.length - 1].body.messages.length === 1);

  r = await call('/v1/chat/completions', { method: 'POST', body: { model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] } });
  check('streams are passed through', r.headers['content-type'] === 'text/event-stream' && r.text.includes('[DONE]'));

  check('a revoked key stops working', revokeApiKey('u1', made.id) && userForApiKey(made.key) === null);
} finally {
  closeDatabase();
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
