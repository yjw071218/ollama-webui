// What happens around one CLI answer: resuming a conversation instead of
// sending it again, answering with another model when one is over its limit,
// keeping the account, hearing when a limit is over, agy's MCP servers, and
// the delegate never being handed to a CLI.
//
// None of it runs a real CLI. The two end-to-end checks use fake ones -- a
// Claude Code that is over its limit or answers with a session, and an agy
// that answers -- run through the same interceptor the server mounts.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Everything these write goes here, never into server/data.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cliextras-data-'));
process.env.WEBUI_DATA_DIR = DATA;
const AGY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cliextras-agyagents-'));

const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const C = await load('server/cliModels.js');
const S = await load('server/cliSessions.js');
const F = await load('server/cliFallback.js');
const U = await load('server/cliUsage.js');
const P = await load('server/push.js');
const { turnMetrics } = await load('src/turnMetrics.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ resuming */

eq('resumed by default', S.resumeEnabled('claude-code', {}), true);
eq('CLI_RESUME=false resumes nothing', S.resumeEnabled('codex', { CLI_RESUME: 'false' }), false);
eq('a list names which', S.resumeEnabled('agy', { CLI_RESUME: 'claude-code,codex' }), false);
eq('and includes those', S.resumeEnabled('codex', { CLI_RESUME: 'claude-code,codex' }), true);

{
  const history = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there.' },
  ];
  const key = S.historyKey('claude-code', 'opus', history);
  eq('whitespace does not change the key',
    S.historyKey('claude-code', 'opus', [history[0], { role: 'user', content: '  Hello\n' }, { role: 'assistant', content: 'Hi   there.' }]), key);
  eq('nor reasoning the app strips before sending',
    S.historyKey('claude-code', 'opus', [history[0], history[1], { role: 'assistant', content: '<think>hm</think>Hi there.' }]), key);
  check('an edited answer is another key', S.historyKey('claude-code', 'opus', [history[0], history[1], { role: 'assistant', content: 'Hi.' }]) !== key);
  check('another model is another key', S.historyKey('claude-code', 'sonnet', history) !== key);
  check('another instruction is another key', S.historyKey('claude-code', 'opus', [{ role: 'system', content: 'Be long.' }, history[1], history[2]]) !== key);

  const split = S.splitForResume([...history, { role: 'user', content: 'And you?', images: ['data:image/png;base64,QUJD'] }]);
  eq('split at the last answer', split.prefix.length, 3);
  eq('with what came after it', split.tail.length, 1);
  eq('nothing to resume before any answer', S.splitForResume(history.slice(0, 2)), null);
  eq('nor with nothing after the answer', S.splitForResume(history), null);
  const one = S.tailRequest(split.tail);
  eq('one new message is sent as itself', one.prompt, 'And you?');
  deep('with its pictures, bare', one.images, ['QUJD']);
  const tool = S.tailRequest([{ role: 'tool', content: '42' }, { role: 'system', content: 'Use it.' }], { formatInstruction: 'JSON only.' });
  check('a tool result is labelled', tool.prompt.startsWith('[Tool result]\n42'));
  check('an instruction after it too', tool.prompt.includes('[System instruction]\nUse it.'));
  check('and the format asked for is kept', tool.prompt.endsWith('JSON only.'));
}

{
  let now = 1_000_000;
  const file = path.join(DATA, 'sessions-test.json');
  const store = S.createSessionStore({ file: () => file, now: () => now });
  store.remember('k1', { id: 'sess-1', provider: 'claude-code' });
  eq('a session is found by its history', store.find('k1')?.id, 'sess-1');
  now += 73 * 3600 * 1000;
  eq('and forgotten after three days', store.find('k1'), null);
  eq('or kept longer when asked', store.find('k1', { CLI_RESUME_TTL_HOURS: '100' })?.id, 'sess-1');
  store.forget('k1');
  eq('a session that would not resume is dropped', store.find('k1', { CLI_RESUME_TTL_HOURS: '100' }), null);
  check('and it is on disk', fs.existsSync(file));
}

/* ------------------------------------------------- resuming, per CLI */

{
  const files = fs.mkdtempSync(path.join(os.tmpdir(), 'cliextras-files-'));
  const request = { system: 'Be brief.', prompt: 'Hi', images: [] };
  const plain = C.buildInvocation(C.PROVIDERS['claude-code'], 'opus', request, { files });
  check('Claude keeps no session when it will not be resumed', plain.args.includes('--no-session-persistence'));
  const kept = C.buildInvocation(C.PROVIDERS['claude-code'], 'opus', request, { files, persist: true });
  check('and keeps one when it may be', !kept.args.includes('--no-session-persistence'));
  const resumed = C.buildInvocation(C.PROVIDERS['claude-code'], 'opus', request, { files, resume: 'sess-9', persist: true });
  eq('a resumed Claude is told which session', resumed.args[resumed.args.indexOf('--resume') + 1], 'sess-9');

  const codex = C.buildInvocation(C.PROVIDERS.codex, 'gpt-5.5', request, { files, persist: true });
  const opened = codex.session.accept({ id: 1, result: {} }).write[1];
  eq('a Codex thread that may be resumed starts', opened.method, 'thread/start');
  eq('and is not ephemeral', opened.params.ephemeral, false);
  const codexResume = C.buildInvocation(C.PROVIDERS.codex, 'gpt-5.5', request, { files, resume: 'thr-7' });
  const reopened = codexResume.session.accept({ id: 1, result: {} }).write[1];
  eq('a resumed one is picked up', reopened.method, 'thread/resume');
  eq('by its id', reopened.params.threadId, 'thr-7');
  eq('with its instructions', reopened.params.baseInstructions, 'Be brief.');
  const turn = codexResume.session.accept({ id: 2, result: { thread: { id: 'thr-7' } } }).write[0];
  eq('and the turn goes to it', turn.params.threadId, 'thr-7');
  const done = codexResume.session.accept({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  eq('it says which thread answered', done.sessionId, 'thr-7');
  const ephemeral = C.buildInvocation(C.PROVIDERS.codex, 'gpt-5.5', request, { files });
  ephemeral.session.accept({ id: 1, result: {} });
  ephemeral.session.accept({ id: 2, result: { thread: { id: 'thr-x' } } });
  eq('an ephemeral thread is not offered for resuming',
    ephemeral.session.accept({ method: 'turn/completed', params: { turn: { status: 'completed' } } }).sessionId, undefined);

  const agyEnv = { AGY_AGENTS_DIR: AGY_DIR };
  const agy = C.buildInvocation(C.PROVIDERS.agy, 'm', request, { files, resume: 'conv-3', env: agyEnv });
  eq('a resumed agy is told which conversation', agy.args[agy.args.indexOf('--conversation') + 1], 'conv-3');
  check('and is not sent the instructions again', !agy.stdin.includes('<instructions>'));
  const fresh = C.buildInvocation(C.PROVIDERS.agy, 'm', request, { files, env: agyEnv });
  check('a fresh one is', fresh.stdin.includes('<instructions>'));

  const reader = new C.ClaudeReader();
  reader.accept({ type: 'system', subtype: 'init', session_id: 'sess-2' });
  const result = reader.accept({ type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 900 }, total_cost_usd: 0.01 });
  eq('Claude says which session answered', result.sessionId, 'sess-2');
  eq('and how much came from the cache', result.usage.cached, 900);
  const agyReader = new C.AgyReader();
  agyReader.accept({ event: 'init', conversation_id: 'conv-5' });
  eq('agy says which conversation, when it does', agyReader.accept({ event: 'result', result: { status: 'SUCCESS', usage: {} } }).sessionId, 'conv-5');
  fs.rmSync(files, { recursive: true, force: true });
}

/* ------------------------------------------------------- agy's servers */

{
  const servers = {
    files: { transport: 'stdio', command: 'npx', args: ['-y', 'fs', 'D:\\x'], env: { A: '1' }, allow: ['read_file'] },
    web: { transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer t' } },
  };
  deep('agy takes the servers by default, like Claude Code and Codex', C.nativeMcpOf(C.PROVIDERS.agy, {}), ['stdio', 'http']);
  eq('  unless CLI_AGY_MCP=off', C.nativeMcpOf(C.PROVIDERS.agy, { CLI_AGY_MCP: 'off' }).length, 0);
  deep('CLI_AGY_MCP=on hands them over', C.nativeMcpOf(C.PROVIDERS.agy, { CLI_AGY_MCP: 'on' }), ['stdio', 'http']);
  eq('but not to agy run as itself', C.nativeMcpOf(C.PROVIDERS.agy, { CLI_AGY_MCP: 'on', CLI_AGY_AGENT: 'off' }).length, 0);
  const mapped = C.agyMcpServers(servers);
  eq('a stdio server starts through the proxy', mapped.files.command, process.execPath);
  check('with its own command after it', mapped.files.args.includes('npx') && mapped.files.args.includes('D:\\x'));
  deep('and its allow-list in agy\'s words', mapped.files.enabledTools, ['read_file']);
  eq('an http server by serverUrl', mapped.web.serverUrl, 'http://127.0.0.1:9/mcp');
  const text = C.agyAgentFile({ name: 'ollama-webui-chat-mcp', vision: false, servers });
  check('the agent file carries them', text.includes('mcpServers: {"files":'));
  check('and none of the reader\'s own', text.includes('inheritMcp: false'));
  check('and tells the model it has them', text.includes('MCP servers (files, web)'));
  check('an agent without servers says nothing of them', !C.agyAgentFile({ name: 'x', vision: false }).includes('mcpServers'));
  const env = { AGY_AGENTS_DIR: AGY_DIR, CLI_AGY_MCP: 'on' };
  eq('the agent with servers has its own name', C.ensureAgyAgent(env, { servers }), 'ollama-webui-chat-mcp');
  check('and is written', fs.existsSync(path.join(AGY_DIR, 'ollama-webui-chat-mcp', 'agent.md')));
  eq('the plain one is still the plain one', C.ensureAgyAgent(env, {}), 'ollama-webui-chat');

  check('the delegate is known by its script', C.isDelegate({ command: 'node', args: ['C:\\x\\server\\mcpDelegate.mjs', '--no-fallback'] }));
  check('and nothing else is taken for it', !C.isDelegate({ command: 'node', args: ['server/mcpWorkbench.mjs'] }));
  const mcpFile = path.join(DATA, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: {
    delegate: { command: 'node', args: [path.join(ROOT, 'server', 'mcpDelegate.mjs')] },
    work: { command: 'node', args: [path.join(ROOT, 'server', 'mcpWorkbench.mjs'), DATA] },
  } }));
  const tools = C.toolsFor(C.PROVIDERS['claude-code'], { MCP_CONFIG: mcpFile }, { wanted: true, cwd: DATA });
  check('a CLI is never handed the delegate', !('delegate' in tools.servers));
  check('while the others go as before', 'work' in tools.servers);
}

/* ----------------------------------------------------------- fallback */

deep('the model asked for comes first', F.candidatesFor('claude-code:opus', { CLI_FALLBACK: 'codex:gpt-5.5, claude-code:opus ,qwen3:8b' }),
  ['claude-code:opus', 'codex:gpt-5.5', 'qwen3:8b']);
deep('no chain, no fallback', F.candidatesFor('codex:gpt-5.5', {}), ['codex:gpt-5.5']);
check('a limit is known by its words', F.isLimitError("You've hit your limit · resets 3pm"));
check('an ordinary failure is not a limit', !F.isLimitError('Claude Code exited with code 1'));
check('a missing CLI is unavailable', F.isUnavailableError('Codex CLI (codex) was not found. Install it or set CODEX_CLI_PATH in .env.'));
{
  const now = Date.parse('2026-09-30T12:00:00Z');
  const hour = 3600 * 1000;
  eq('allowed is not blocked', F.blockedUntil({ status: 'allowed', windows: [] }, now), null);
  deep('blocked until the full window resets', F.blockedUntil({
    status: 'rejected', windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: now + hour }, { id: 'seven_day', usedPercent: 40, resetsAt: now + 90 * hour }],
  }, now), { until: now + hour });
  deep('a refusal with no time is believed for a while', F.blockedUntil({ status: 'rejected', windows: [], updatedAt: now - 60_000 }, now), { until: null });
  eq('and then tried again', F.blockedUntil({ status: 'rejected', windows: [], updatedAt: now - 20 * 60_000 }, now), null);
  eq('back when the last full window resets', C.backAt({
    status: 'rejected', windows: [{ id: 'five_hour', usedPercent: 100, resetsAt: now + hour }, { id: 'seven_day', usedPercent: 100, resetsAt: now + 50 * hour }],
  }, now), now + 50 * hour);
  eq('no reset time, no promise', C.backAt({ status: 'rejected', windows: [] }, now), null);
  const { due, left } = C.dueWaiters([{ provider: 'codex', owner: 'a', until: now - 2 * 60_000 }, { provider: 'agy', owner: 'b', until: now + hour }], now);
  eq('a wait that is over is due', due.length === 1 && due[0].owner, 'a');
  eq('one that is not is kept', left.length === 1 && left[0].owner, 'b');
}

/* ------------------------------------------------------------ the ledger */

{
  const file = path.join(DATA, 'usage-test.jsonl');
  const now = Date.parse('2026-09-30T12:00:00');
  U.recordUsage({ at: now - 1000, provider: 'claude-code', model: 'opus', owner: 'u1', chat: 'c1', usage: { prompt: 100, eval: 20, cached: 80, costUsd: 0.05 }, resumed: true }, { file });
  U.recordUsage({ at: now - 2000, provider: 'codex', model: 'gpt-5.5', owner: 'u1', chat: 'c2', usage: { prompt: 10, eval: 5 }, fallbackFrom: 'claude-code:opus' }, { file });
  U.recordUsage({ at: now - 10 * 86400000, provider: 'claude-code', model: 'opus', owner: 'u1', chat: 'c1', usage: { prompt: 1, eval: 1, costUsd: 0.01 } }, { file });
  U.recordUsage({ at: now - 1000, provider: 'claude-code', model: 'opus', owner: 'u2', usage: { prompt: 999, eval: 1 } }, { file });
  fs.appendFileSync(file, '{"cut in ha');
  const lines = U.readUsage({ file });
  eq('every whole line is read back', lines.length, 4);
  const mine = U.summariseUsage(lines, { owner: 'u1', now });
  eq('today, per CLI', mine.totals.today['claude-code'].runs, 1);
  eq('with its price', mine.totals.today['claude-code'].costUsd, 0.05);
  eq('and its cache', mine.totals.today['claude-code'].cached, 80);
  eq('resumed answers are counted', mine.totals.today['claude-code'].resumed, 1);
  eq('and answers as a fallback', mine.totals.today.codex.fallbacks, 1);
  eq('the month holds the older one too', mine.totals.month['claude-code'].runs, 2);
  eq('another account is not mine', mine.totals.today['claude-code'].prompt, 100);
  eq('the costliest conversation first', mine.chats[0].chat, 'c1');
  deep('with which models', mine.chats[0].models, ['claude-code:opus']);
  eq('an error is kept short', U.usageLine({ provider: 'x', model: 'y', error: 'e'.repeat(500) }).error.length, 200);
}

/* ----------------------------------------------- the push, and a footer */

eq('one sentence is kept as it was', P.labelFor('Your answer is ready'), 'Your answer is ready');
deep('several are kept by kind', JSON.parse(P.labelFor('Ready', { cliReset: '{name} is back', 'bad key!': 'x' })), { ready: 'Ready', cliReset: '{name} is back' });
{
  const spent = turnMetrics([
    { role: 'assistant', metrics: { totalTime: '1.00', evalCount: 10, tokensPerSec: '10', costUsd: 0.01, cachedTokens: 100 } },
    { role: 'assistant', metrics: { totalTime: '2.00', evalCount: 20, tokensPerSec: '10', costUsd: 0.02, cachedTokens: 200, resumed: true } },
  ]);
  eq('a turn\'s price is every leg\'s', Math.round(spent.costUsd * 100) / 100, 0.03);
  eq('as is what came from the cache', spent.cachedTokens, 300);
  eq('and one resumed leg makes it resumed', spent.resumed, true);
}

/* ---------------------------------------------- end to end, with fakes */

const shim = (dir, name, script) => {
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, script);
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o755); return file; }
  const bin = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(bin, `@ECHO off\r\nnode "%dp0%\\${name}.mjs" %*\r\n`);
  return bin;
};
const nodeHead = process.platform === 'win32' ? '' : `#!${process.execPath}\n`;

const fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'cliextras-fakes-'));
const argvLog = path.join(fakes, 'argv.log');
const claudeBin = shim(fakes, 'claude', `${nodeHead}
import fs from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CLAUDE === 'limit') {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    out({ type: 'result', subtype: 'error', is_error: true, result: "You've hit your limit · resets 3pm" });
    return;
  }
  const said = JSON.parse(input.trim()).message.content[0].text;
  out({ type: 'system', subtype: 'init', session_id: 'sess-' + (process.argv.includes('--resume') ? 'again' : 'first') });
  out({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 5 } } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'You said: ' + said } } });
  out({ type: 'result', subtype: 'success', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 700 }, total_cost_usd: 0.004 });
});
`);
const agyBin = shim(fakes, 'agy', `${nodeHead}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.resume(); process.stdin.on('data', () => {});
out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'agy here.' } });
out({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 9, output_tokens: 2 } } });
process.exit(0);
`);

const ENV = {
  CLAUDE_CLI_PATH: claudeBin, AGY_CLI_PATH: agyBin, CLI_PROVIDERS: 'claude-code,agy',
  AGY_AGENTS_DIR: AGY_DIR, CLI_AGY_AGENT: 'off', PATH: '',
};

/* One request through the interceptor the server mounts; the NDJSON back. */
const ask = async (env, body, headers = {}) => {
  const intercept = C.cliInterceptor(env);
  const chunks = [];
  const res = {
    statusCode: 200, headers: {}, writableEnded: false,
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c) chunks.push(String(c)); this.writableEnded = true; },
    on() {},
  };
  const req = { method: 'POST', url: '/api/chat', headers, rawBody: Buffer.from(JSON.stringify(body)) };
  let passed = false;
  await intercept(req, res, () => { passed = true; });
  return { passed, frames: chunks.join('').split('\n').filter(Boolean).map(l => JSON.parse(l)) };
};
const textOf = (frames) => frames.map(f => f.message?.content || '').join('');

{
  process.env.FAKE_CLAUDE = 'limit';
  const env = { ...ENV, CLI_FALLBACK: 'agy:gemini-x' };
  const first = await ask(env, { model: 'claude-code:opus', messages: [{ role: 'user', content: 'hi' }] });
  const last = first.frames.at(-1);
  eq('a CLI over its limit is answered for by the next one', textOf(first.frames), 'agy here.');
  eq('the answer says who wrote it', last.answered_by, 'agy:gemini-x');
  eq('and instead of whom', last.fallback_from, 'claude-code:opus');
  eq('and why', last.fallback_reason, 'limit');
  eq('it is still named as the model asked for', last.model, 'claude-code:opus');

  const before = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).length;
  const second = await ask(env, { model: 'claude-code:opus', messages: [{ role: 'user', content: 'again' }] });
  const after = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).length;
  eq('known to be over its limit, it is not even started', after, before);
  eq('and the next one answers straight away', second.frames.at(-1).answered_by, 'agy:gemini-x');

  const compare = await ask(env, { model: 'claude-code:opus', messages: [{ role: 'user', content: 'hi' }] }, { 'x-cli-fallback': 'off' });
  check('a comparison gets the failure, not another model', compare.frames.at(-1).error?.includes('limit') && !compare.frames.at(-1).answered_by);

  const waits = JSON.parse(fs.readFileSync(path.join(DATA, 'cli-reset-waiters.json'), 'utf8'));
  check('and whoever asked waits to hear it is back', waits.some(w => w.provider === 'claude-code' && w.until > Date.now()));
  const ledger = U.readUsage();
  check('the failure is in the account', ledger.some(l => l.provider === 'claude-code' && l.error));
  check('as is the answer given instead', ledger.some(l => l.provider === 'agy' && l.fallbackFrom === 'claude-code:opus'));
}

{
  // Over now: the limit is forgotten, and the conversation resumes.
  fs.rmSync(path.join(DATA, 'cli-limits.json'), { force: true });
  C.noteLimits('claude-code', { status: 'allowed', windows: [] });
  process.env.FAKE_CLAUDE = 'ok';
  const env = { ...ENV };
  const history = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'first question' }];
  const one = await ask(env, { model: 'claude-code:opus', messages: history }, { 'x-chat-conversation': 'chat-1' });
  const answer = textOf(one.frames);
  eq('a fresh conversation is answered whole', answer, 'You said: first question');
  eq('with its price on the last frame', one.frames.at(-1).cost_usd, 0.004);
  eq('and its cache', one.frames.at(-1).cached_count, 700);
  const two = await ask(env, { model: 'claude-code:opus', messages: [...history, { role: 'assistant', content: answer }, { role: 'user', content: 'second' }] });
  const argv = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
  eq('the next turn resumes the session', argv[argv.indexOf('--resume') + 1], 'sess-first');
  eq('and is sent only what is new', textOf(two.frames), 'You said: second');
  eq('which the last frame says', two.frames.at(-1).cli_resumed, true);
  const edited = await ask(env, { model: 'claude-code:opus', messages: [...history, { role: 'assistant', content: 'something else' }, { role: 'user', content: 'third' }] });
  const argv3 = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
  check('an edited history is not resumed', !argv3.includes('--resume'));
  check('it is sent whole', textOf(edited.frames).includes('<conversation>'));
  const off = await ask({ ...env, CLI_RESUME: 'false' }, { model: 'claude-code:opus', messages: [...history, { role: 'assistant', content: answer }, { role: 'user', content: 'second' }] });
  const argv4 = fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).at(-1);
  check('CLI_RESUME=false sends it whole', !argv4.includes('--resume') && argv4.includes('--no-session-persistence') && textOf(off.frames).includes('<conversation>'));
  const ledger = U.readUsage();
  check('the conversation is in the account', ledger.some(l => l.chat === 'chat-1' && l.costUsd === 0.004));
}

delete process.env.FAKE_CLAUDE;
for (const dir of [DATA, AGY_DIR, fakes]) fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
