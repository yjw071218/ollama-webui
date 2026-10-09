import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CliActivity } from '../server/cliActivity.js';
import { CodexSession, agyMcpServers, agyServerEnv } from '../server/cliModels.js';
import { createMcpPool } from '../server/mcp.js';
import { createChatJobStore, replayChatJob } from '../server/chatJobs.js';

const stub = path.resolve('scripts/fixtures/mcp-stub-server.mjs');
const event = (method, item) => ({ method, params: { item } });
const until = async predicate => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(40); }
  assert.fail('timed out waiting for recovery');
};

test('Codex activity follows actual events, including overlapping tools and hidden reasoning', () => {
  const a = new CliActivity('codex');
  assert.equal(a.accept({ method: 'turn/started' }), undefined);
  assert.equal(a.accept(event('item/started', { id: 'r', type: 'reasoning' })), 'thinking');
  assert.equal(a.accept(event('item/started', { id: 't1', type: 'commandExecution' })), 'running');
  assert.equal(a.accept(event('item/started', { id: 't2', type: 'mcpToolCall' })), undefined);
  assert.equal(a.accept(event('item/completed', { id: 't1' })), 'tools');
  assert.equal(a.accept(event('item/completed', { id: 'r' })), undefined);
  assert.equal(a.accept(event('item/completed', { id: 't2' })), '');
  assert.equal(a.accept({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Thinking about Running' } }), 'responding');
  assert.equal(a.accept({ method: 'turn/completed' }), '');
});

test('Claude activity keeps running until the tool result, not just the argument block end', () => {
  const a = new CliActivity('claude-code');
  const accept = event => a.accept({ type: 'stream_event', event });
  assert.equal(accept({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }), 'thinking');
  accept({ type: 'content_block_stop', index: 0 });
  assert.equal(accept({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Bash', id: 'tool' } }), 'running');
  assert.equal(accept({ type: 'content_block_stop', index: 1 }), undefined);
  assert.equal(a.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] } }), '');
});

test('Codex shell edits produce file cards without including preexisting changes or repeating native edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-changes-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.py'), 'before\n');
    fs.writeFileSync(path.join(dir, 'dirty.py'), 'original\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    fs.writeFileSync(path.join(dir, 'dirty.py'), 'user change\n');
    const session = new CodexSession({ thread: { cwd: dir }, turn: {} });
    const item = { id: 'cmd', type: 'commandExecution', cwd: dir, command: 'python edit.py' };
    session.accept(event('item/started', item));
    execFileSync(process.execPath, ['-e', "require('fs').writeFileSync('a.py', 'after\\n'); require('fs').writeFileSync('new.py', 'new\\n')"], { cwd: dir });
    const result = session.accept(event('item/completed', { ...item, exitCode: 1, status: 'failed' }));
    assert.match(result.content, /📝.*a\.py/);
    assert.match(result.content, /📝.*new\.py/);
    assert.doesNotMatch(result.content, /dirty\.py/);
    assert.equal(session.accept(event('item/completed', item)).content, undefined);
    fs.writeFileSync(path.join(dir, 'a.py'), 'native\n');
    const native = session.accept(event('item/completed', { type: 'fileChange', changes: [{ path: path.join(dir, 'a.py'), diff: '@@ -1 +1 @@\n-after\n+native' }] }));
    assert.match(native.content, /📝.*a\.py/);
    assert.equal(session.accept(event('item/completed', item)).content, undefined);
    session.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('chat replay preserves CLI activity and original start for followers and reconnects', () => {
  const store = createChatJobStore();
  const job = store.begin('job', { owner: 'u', chat: 'c' });
  store.appendFrame('job', { cli_started: { startedAt: 123, provider: 'codex' } });
  store.appendFrame('job', { cli_activity: { phase: 'running', at: 456 } });
  const frames = replayChatJob(job).trim().split('\n').map(JSON.parse);
  assert.equal(frames[0].cli_started.startedAt, 123);
  assert.equal(frames[1].cli_activity.phase, 'running');
  assert.equal(store.live('other-user', 'c').length, 0);
  assert.equal(store.live('u', 'c')[0].id, 'job');
});

test('another client follows status-only frames and uses the original elapsed time', async () => {
  const app = fs.readFileSync('src/App.jsx', 'utf8');
  const begin = app.lastIndexOf('  useEffect(() => {', app.indexOf('if (!isStorageLoaded || !currentSessionId || isGenerating)'));
  const ending = '}, [currentSessionId, isStorageLoaded, isGenerating]);';
  const source = app.slice(begin, app.indexOf(ending, begin) + ending.length);
  const frames = [
    { cli_started: { startedAt: 1000, provider: 'codex' }, cli_activity: { phase: 'thinking', at: 1001 } },
    { cli_activity: { phase: 'running', at: 1002 } },
    { cli_activity: { phase: 'responding', at: 1003 }, message: { content: '답변' } },
    { done: true },
  ].map(frame => new TextEncoder().encode(JSON.stringify(frame) + '\n'));
  const updates = [];
  let cleanup;
  const before = Date.now();
  vm.runInNewContext(source, {
    isStorageLoaded: true, currentSessionId: 'c', isGenerating: false,
    AbortController, TextDecoder,
    useEffect: run => { cleanup = run(); },
    setFollowed: value => updates.push(typeof value === 'function' ? value(updates.at(-1)) : value),
    setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {},
    fetchJsonQuietly: async () => ({ job: { id: 'job', startedAt: 1000 }, now: 11000 }),
    resumableChatReader: () => ({ read: async () => frames.length ? { done: false, value: frames.shift() } : { done: true } }),
    decodeByteFallback: text => text, fenceThinking: text => text,
    sessionsRef: { current: [] }, askedCount: () => 0,
  });
  await new Promise(resolve => setImmediate(resolve));
  cleanup();
  assert.deepEqual(updates.slice(0, 3).map(u => u.cliActivity.phase), ['thinking', 'running', 'responding']);
  assert.equal(updates[0].cliStarted.startedAt, 1000);
  assert.ok(Math.abs(updates[0].startedAt - (before - 10000)) < 100);
  assert.equal(updates[1].live, true);
  assert.equal(updates.at(-1).live, false);
  assert.equal(updates.at(-1).cliActivity, null);
  // Before the first word (or with reasoning hidden), a remote reply must
  // already have a row on which the activity and elapsed time can be shown.
  const overlayBegin = app.indexOf('  const messages = useMemo(() => {');
  const overlayEnd = '}, [currentSession, followed, currentSessionId]);';
  const overlay = app.slice(overlayBegin, app.indexOf(overlayEnd, overlayBegin) + overlayEnd.length);
  const shown = vm.runInNewContext(overlay + '\nmessages;', {
    currentSession: { messages: [{ role: 'user', content: '작업해 줘' }] },
    currentSessionId: 'c', followed: updates[0], useMemo: run => run(), askedCount: () => 1,
    dismissedFollowRef: { current: null },
  });
  assert.equal(shown.length, 2);
  assert.equal(shown[1].cliActivity.phase, 'thinking');
});

test('MCP pool reconnects a crashed child while idle and respects disable and shutdown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-recover-'));
  const config = { mcpServers: { stub: { command: process.execPath, args: [stub] } } };
  const write = () => fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(config));
  write();
  const pool = createMcpPool({}, { cwd: dir, home: dir });
  try {
    const first = await pool.connect('stub');
    await assert.rejects(pool.callTool('stub', 'exit_now', {}));
    await until(() => first.connection.dead);
    // No list/call/connect request triggers recovery: only the watchdog.
    await delay(1400);
    const checkedAt = Date.now();
    const recovered = await pool.connect('stub');
    assert.ok(recovered.startedAt < checkedAt, 'watchdog recovered before any client request');
    assert.notEqual(recovered, first);
    assert.ok(recovered.startedAt > first.startedAt);
    config.mcpServers.stub.disabled = true; write();
    await until(() => recovered.connection.dead);
    await assert.rejects(pool.connect('stub'), /switched off/);
    pool.close();
    await assert.rejects(pool.connect('stub'), /closed/);
  } finally { pool.close(); await delay(150); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

for (const provider of ['CLI', 'agy']) test(`${provider} stdio bridge survives child crashes, repeats handshake and never replays tool calls`, async () => {
  const servers = { stub: { transport: 'stdio', command: process.execPath, args: [stub], env: { STUB_VAR: 'recovery-test' } } };
  const run = provider === 'agy' ? agyMcpServers(servers).stub
    : { command: process.execPath, args: ['server/mcpStdioProxy.mjs', '--cwd', process.cwd(), '--', process.execPath, stub] };
  const child = spawn(run.command, run.args, { env: { ...process.env, ...(provider === 'agy' ? agyServerEnv(servers) : {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '', stderr = '';
  const replies = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
      const message = JSON.parse(line);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  const ask = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    await until(() => replies.has(id));
    return replies.get(id);
  };
  try {
    assert.ok((await ask(1, 'initialize', { capabilities: { roots: {} }, clientInfo: { name: 'test' }, protocolVersion: '2025-03-26' })).result);
    assert.match((await ask(2, 'tools/call', { name: 'exit_now' })).error.message, /result is unknown/);
    assert.match((await ask(3, 'tools/call', { name: 'echo' })).error.message, /not executed/);
    await until(() => stderr.includes('connection restored'));
    const reply = await ask(4, 'tools/call', { name: 'client_caps' });
    const caps = JSON.parse(reply.result.content[0].text);
    assert.deepEqual(caps.capabilities, {});
    if (provider === 'agy') assert.equal((await ask(5, 'tools/call', { name: 'env' })).result.content[0].text, 'STUB_VAR=recovery-test');
    assert.equal((stderr.match(/server exited/g) || []).length, 1);
  } finally {
    child.stdin.end();
    await until(() => child.exitCode !== null);
  }
});
