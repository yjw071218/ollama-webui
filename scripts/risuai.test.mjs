import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The fake agy's answers are recorded like real ones (server/cliUsage.js);
// they belong in a scratch folder, not in server/data's real account.
process.env.WEBUI_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'risuai-test-data-'));
import { createRisuRoutes } from '../server/risuai.js';
import { assetMime } from '../integrations/risuai/asset-mime.js';
import { defaultVariant } from '../integrations/risuai/asset-fallback.js';

test('an expression a card does not ship falls back to the default of the same character', () => {
  const paths = Object.fromEntries([
    'mizuho_normal_casual_default.webp', 'mizuho_normal_dress_default.webp', 'mizuho_capture.webp',
    'aya_casual_default.webp', 'aya_denial lapis_default.webp', 'shiho_corruption_casual_default.webp',
  ].map(name => [name, { srcPaths: [`assets/${name}`] }]));
  assert.equal(defaultVariant(paths, 'mizuho_normal_casual_indifferent.webp').srcPaths[0], 'assets/mizuho_normal_casual_default.webp');
  assert.equal(defaultVariant(paths, 'mizuho_normal_swimsuit_smile.webp').srcPaths[0], 'assets/mizuho_normal_casual_default.webp',
    'another outfit of the same state when the outfit is missing');
  assert.equal(defaultVariant(paths, 'aya_normal_casual_indifferent.webp').srcPaths[0], 'assets/aya_casual_default.webp',
    'down to the character alone');
  assert.equal(defaultVariant(paths, 'yui_normal_casual_happy.webp'), null, 'never someone else');
  assert.equal(defaultVariant(paths, 'background.webp'), null, 'a one-part name has nothing to fall back to');
});
import { presetCrypt } from '../integrations/risuai/preset-crypto.js';
import {
  contextBudget, responseBudget, fastGeneration, isLocalOllama, startBudget, liftBudget, cliWindow,
} from '../integrations/risuai/performance.js';

test('a card and lorebook too big for a ceiling this app set lift it, not refuse', () => {
  // A CLI model: the preset's maxContext was written for some API.
  const cli = { aiModel: 'ollama-hosted', ollamaModel: 'claude-code:opus', maxContext: 16000, maxResponse: 3000 };
  assert.equal(cliWindow(cli), 200000);
  assert.equal(startBudget(cli), 16000);
  const liftedCli = liftBudget(cli, 48322, 16000);
  assert.ok(liftedCli >= 48322 + 16000, `room for history on top: ${liftedCli}`);
  assert.ok(liftedCli <= 200000);
  assert.equal(contextBudget(cli), liftedCli, 'kept for the rest of this request');
  assert.equal(startBudget(cli), 16000, 'and forgotten at the next');
  assert.equal(liftBudget(cli, 5000, 16000), 16000, 'a prompt that fits is left alone');
  assert.equal(liftBudget(cli, 250000, 16000), 200000, 'never past what the CLI can take');

  // A local model with fast generation: up to what the reader set, with Ollama's num_ctx.
  const local = { aiModel: 'ollama-hosted', ollamaModel: 'gemma4:31b', maxContext: 131072, maxResponse: 8192 };
  assert.equal(startBudget(local), 32768);
  const liftedLocal = liftBudget(local, 48322, 32768);
  assert.equal(liftedLocal, 48322 + 8192 + 2048);
  assert.equal(contextBudget(local), liftedLocal, 'num_ctx follows');
  startBudget(local);
  assert.equal(liftBudget({ ...local, maxContext: 32768 }, 48322, 32768), 32768, 'not past the maxContext the reader set');
  assert.equal(liftBudget({ ...local, webuiFastGeneration: false }, 48322, 131072), 131072, 'fits, untouched');
  assert.equal(liftBudget({ ...local, webuiFastGeneration: false, maxContext: 40000 }, 48322, 40000), 40000,
    'with fast generation off, the limit the reader set stands');
});

test('fast generation bounds runtime budgets without changing preset values', () => {
  const db = { aiModel: 'ollama-hosted', ollamaModel: 'gemma4:31b', maxContext: 150000, maxResponse: 8192 };
  assert.equal(contextBudget(db), 32768);
  assert.equal(responseBudget(db), 2048);
  assert.equal(db.maxContext, 150000);
  db.webuiFastGeneration = false;
  assert.equal(contextBudget(db), 150000);
  assert.equal(responseBudget(db), 8192);
  assert.equal(contextBudget({ maxContext: 4096 }), 4096);
});

test('CLI and cloud models retain preset budgets even with fast mode enabled', () => {
  const db = { aiModel: 'ollama-hosted', maxContext: 150000, maxResponse: 8192, webuiFastGeneration: true };
  for (const ollamaModel of ['agy:gemini-3.1-pro-high', 'claude-code:opus', 'codex:gpt-5.5', 'glm:cloud', '']) {
    const config = { ...db, ollamaModel };
    assert.equal(isLocalOllama(config), false);
    assert.equal(fastGeneration(config), false);
    assert.equal(contextBudget(config), 150000);
    assert.equal(responseBudget(config), 8192);
  }
  const local = { ...db, ollamaModel: 'gemma4:31b' };
  assert.equal(fastGeneration(local), true);
  assert.equal(contextBudget(local), 32768);
  assert.equal(responseBudget(local), 2048);
});

test('HTTP preset crypto matches WebCrypto and rejects altered data', async () => {
  const data = new TextEncoder().encode('프리셋 compatibility');
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset')), 'AES-GCM', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, data);
  assert.deepEqual(presetCrypt(data, 'risupreset'), encrypted);
  assert.deepEqual(new Uint8Array(presetCrypt(encrypted, 'risupreset', true)), data);
  const broken = new Uint8Array(encrypted); broken[0] ^= 1;
  assert.throws(() => presetCrypt(broken, 'risupreset', true));
});
import { localChatModels, chooseLocalModel } from '../integrations/risuai/local-model.js';

test('automatic selection excludes cloud and embedding models', () => {
  const models = [{ name: 'remote:cloud' }, { name: 'remote', remote_host: 'https://example.com' }, { name: 'nomic-embed-text' }, { name: 'first' }, { name: 'second' }];
  assert.deepEqual(localChatModels(models).map(x => x.name), ['first', 'second']);
  // A model a signed-in CLI answers is remote too, but chosen on purpose.
  assert.deepEqual(localChatModels([...models, { name: 'claude-code:opus', remote_host: 'Claude Code', details: { format: 'cli' } }]).map(x => x.name), ['first', 'second', 'claude-code:opus']);
  assert.equal(chooseLocalModel(models, 'second', 'first'), 'second');
  assert.equal(chooseLocalModel(models, 'remote:cloud', 'second'), 'second');
  assert.equal(chooseLocalModel(models, 'missing', ''), 'first');
  assert.equal(chooseLocalModel([], '', ''), '');
});

test('roleplay uses local Ollama even when the host selects llama.cpp', async t => {
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'local' }, { name: 'remote:cloud' }] }));
    assert.equal(req.url, '/api/chat');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, 'local');
    assert.deepEqual(JSON.parse(body).messages, [
      { role: 'system', content: '설정' },
      { role: 'assistant', content: '사용자가 작성한 문맥', images: ['aGVsbG8='] },
      { role: 'assistant', content: '이전 답변' },
      { role: 'assistant', content: '이어질 문맥' },
    ]);
    res.end(JSON.stringify({ message: { content: 'local reply' }, done: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const [{ handler }] = createRisuRoutes({ env: { OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}`, LLM_BACKEND: 'llamacpp', VRAM_EXCLUSIVE: 'false', CLI_MODELS: 'false' } });
  const proxy = http.createServer(handler);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const base = `http://127.0.0.1:${proxy.address().port}/risuai/ollama/api`;
  assert.deepEqual((await (await fetch(base + '/tags')).json()).models, [{ name: 'local' }]);
  const reply = await fetch(base + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'local', messages: [
    { role: 'system', content: '설정' },
    { role: 'user', content: '사용자가 작성한 문맥', images: ['aGVsbG8='] },
    { role: 'assistant', content: '이전 답변' },
    { role: 'user', content: '이어질 문맥' },
  ], stream: false }) });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).message.content, 'local reply');
  const invalid = await fetch(base + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(base + '/pull', { method: 'POST' })).status, 404);
});

test('roleplay with a CLI model reaches the CLI, as a reply rather than a continuation', async t => {
  // Ollama must never see it: it has no agy model and answers "not found".
  let ollamaHit = false;
  const upstream = http.createServer((req, res) => { ollamaHit = true; res.writeHead(404); res.end('{"error":"model not found"}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-risu-agy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-agy.mjs');
  await fs.writeFile(script, [
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "let input = ''; let sent = false;",
    "process.stdin.on('data', (d) => { input += d; if (sent || !input.includes('\\n')) return; sent = true;",
    "  const said = input.includes('Continue the last') ? 'CONTINUED' : (input.includes('[User]') ? 'REPLIED' : 'OTHER');",
    "  out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: said } });",
    "  out({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 1, output_tokens: 1 } } });",
    "  setTimeout(() => process.exit(0), 20); });",
  ].join('\n'));
  const bin = path.join(dir, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  // In npm's shim form: resolveBinary only runs a .cmd it can read the script
  // out of, and otherwise falls through to the real agy on PATH.
  if (process.platform === 'win32') await fs.writeFile(bin, '@ECHO off\r\nnode "%~dp0\\fake-agy.mjs" %*\r\n');
  else { await fs.writeFile(bin, `#!${process.execPath}\n${await fs.readFile(script, 'utf8')}`); await fs.chmod(bin, 0o755); }

  const [{ handler }] = createRisuRoutes({ env: {
    OLLAMA_URL: `http://127.0.0.1:${upstream.address().port}`, VRAM_EXCLUSIVE: 'false',
    CLI_PROVIDERS: 'agy', AGY_CLI_PATH: bin, AGY_AGENTS_DIR: dir, CLI_MCP: 'false', CLI_WEB: 'false',
  } });
  const proxy = http.createServer(handler);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const reply = await fetch(`http://127.0.0.1:${proxy.address().port}/risuai/ollama/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'agy:gemini-3.1-pro-high', stream: false, messages: [
      { role: 'system', content: '설정' },
      { role: 'assistant', content: '이전 답변' },
      { role: 'user', content: '다음 말' },
    ] }),
  });
  const body = await reply.json();
  assert.equal(ollamaHit, false);
  assert.equal(reply.status, 200, JSON.stringify(body));
  assert.equal(body.message.content, 'REPLIED');
});

test('binary asset MIME survives hashed filenames', () => {
  for (const [bytes, expected] of [
    [[137,80,78,71], 'image/png'], [[255,216,255], 'image/jpeg'],
    [Buffer.from('GIF89a'), 'image/gif'], [Buffer.from('RIFF1234WEBP'), 'image/webp'],
    [Buffer.from('RIFF1234WAVE'), 'audio/wav'], [Buffer.from('OggS'), 'audio/ogg'],
    [Buffer.from('fLaC'), 'audio/flac'], [Buffer.from('ID3'), 'audio/mpeg'],
    [Buffer.from('0000ftypisom'), 'video/mp4'], [Buffer.from('0000ftypavif'), 'image/avif'],
    [[26,69,223,163], 'video/webm'],
  ]) assert.equal(assetMime(new Uint8Array(bytes), 'assets/hash'), expected);
  assert.equal(assetMime(new Uint8Array(), 'test.svg'), 'image/svg+xml');
  assert.equal(assetMime(new Uint8Array(), 'unknown'), 'application/octet-stream');
});

test('dev and production RisuAI routes serve the same bytes without SPA fallback', async t => {
  const dist = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-risu-test-'));
  t.after(() => fs.rm(dist, { recursive: true, force: true }));
  await fs.writeFile(path.join(dist, 'index.html'), '<html>Risu</html>');
  await fs.writeFile(path.join(dist, 'version.json'), '{}');
  await fs.writeFile(path.join(dist, 'test.wasm'), new Uint8Array([0,97,115,109]));
  const [{ handler }] = createRisuRoutes({ dist });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const prefix of ['', '/risuai']) {
    const response = await fetch(base + prefix + '/');
    assert.equal(await response.text(), '<html>Risu</html>');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
    assert.deepEqual(await (await fetch(base + prefix + '/status')).json(), { installed: true });
    const wasm = await fetch(base + prefix + '/test.wasm');
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.deepEqual(new Uint8Array(await wasm.arrayBuffer()), new Uint8Array([0,97,115,109]));
    const head = await fetch(base + prefix + '/test.wasm', { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '4');
    assert.equal(await head.text(), '');
    assert.equal((await fetch(base + prefix + '/missing.js')).status, 404);
    assert.equal((await fetch(base + prefix + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + prefix + '/%2e%2e%2fsecret')).status, 403);
    assert.equal((await fetch(base + prefix + '/%5csecret')).status, 403);
    assert.equal((await fetch(base + prefix + '/%00')).status, 403);
  }
});
