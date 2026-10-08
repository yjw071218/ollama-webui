import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CliActivity } from '../server/cliActivity.js';
import { AgyTranscriptState, watchAgyTranscript, runCli, PROVIDERS } from '../server/cliModels.js';
import { CLI_ACTIVITY_LABELS, cliActivityLabel, cliToolPhase } from '../src/cliActivity.js';

const planner = (index, name, args = {}) => ({ step_index: index, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name, args }] });
const result = (index, status = 'DONE') => ({ step_index: index, type: 'GENERIC', status });
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-activity-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'a.py'), 'before\n');
  fs.writeFileSync(path.join(dir, 'user.py'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'brain/\nagents/\nfake-agy.mjs\nagy.cmd\n');
  fs.writeFileSync(path.join(dir, 'user.py'), 'user edit\n');
  return dir;
};

test('extended phases use tool names, with a safe label for unfamiliar tools', () => {
  for (const [name, phase] of [['view_file', 'reading'], ['find_by_name', 'searching'],
    ['read_url_content', 'browsing'], ['replace_file_content', 'editing'], ['write_to_file', 'writing'],
    ['manage_task', 'planning'], ['spawn_agent', 'delegating'], ['command_status', 'waiting'],
    ['generate_image', 'generating'], ['run_command', 'running']]) {
    assert.equal(cliToolPhase(name), phase);
    assert.ok(cliActivityLabel(phase).endsWith('…'));
  }
  assert.equal(cliToolPhase('call_mcp_tool', { ToolName: 'read_file' }), 'reading');
  assert.equal(cliToolPhase('mcp__files__edit_file'), 'editing');
  assert.equal(cliToolPhase('unknown', { prompt: 'search edit run tests' }), 'tools');
  assert.equal(cliActivityLabel('unknown'), '');
  assert.equal(cliActivityLabel('constructor'), '');
  assert.equal(Object.keys(CLI_ACTIVITY_LABELS).length, 15);
});

test('Codex and Claude distinguish edits/search/compaction and approval waits', () => {
  const codex = new CliActivity('codex');
  const event = (method, item) => ({ method, params: { item } });
  for (const [type, phase] of [['fileChange', 'editing'], ['webSearch', 'searching'], ['contextCompaction', 'compacting']]) {
    assert.equal(codex.accept(event('item/started', { id: type, type })), phase);
    assert.equal(codex.set('approval:1', 'waiting'), 'waiting');
    assert.equal(codex.set('approval:1', ''), phase);
    assert.equal(codex.accept(event('item/completed', { id: type, type })), '');
  }
  const claude = new CliActivity('claude-code');
  assert.equal(claude.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read', id: 'read' } } }), 'reading');
  assert.equal(claude.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }), undefined);
  assert.equal(claude.accept({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read' }] } }), '');
  assert.equal(claude.accept({ type: 'system', subtype: 'status', status: 'compacting' }), 'compacting');
  assert.equal(claude.accept({ type: 'system', subtype: 'compact_boundary' }), '');
});

test('agy shell writes are measured, including partial writes before a failure', () => {
  const dir = fixture();
  try {
    const phases = [];
    const state = new AgyTranscriptState({ cwd: dir, onActivity: phase => phases.push(phase) });
    assert.equal(state.accept(planner(1, 'run_command', { CommandLine: 'python edit.py', Cwd: dir })), '');
    assert.equal(phases.at(-1), 'running');
    state.accept(result(2, 'RUNNING'));
    fs.writeFileSync(path.join(dir, 'a.py'), 'shell edit\n');
    fs.writeFileSync(path.join(dir, 'new.py'), 'new\n');
    const cards = state.accept(result(2, 'ERROR'));
    assert.match(cards, /📝.*a\.py/);
    assert.match(cards, /📝.*new\.py/);
    assert.doesNotMatch(cards, /user\.py/);
    assert.equal(phases.at(-1), '');
    assert.equal(state.accept(result(2, 'ERROR')), '');
    assert.equal(state.finish(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agy native edits appear after success and failed planned writes do not become cards', () => {
  const dir = fixture();
  try {
    const state = new AgyTranscriptState({ cwd: dir });
    const target = path.join(dir, 'a.py');
    assert.equal(state.accept(planner(1, 'multi_replace_file_content', { TargetFile: target,
      Replacements: [{ TargetContent: 'before', ReplacementContent: 'after' }] })), '');
    assert.equal(state.activity.phase, 'editing');
    fs.writeFileSync(target, 'after\n');
    assert.match(state.accept(result(2)), /-before\n\+after/);
    state.accept(planner(3, 'run_command', { Cwd: dir, CommandLine: 'echo done' }));
    assert.equal(state.accept(result(4)), '');
    state.accept(planner(5, 'write_to_file', { TargetFile: path.join(dir, 'failed.py'), CodeContent: 'never written' }));
    assert.equal(state.accept(result(6, 'ERROR')), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agy keeps other pending tools active when one parallel result completes', () => {
  const phases = [];
  const state = new AgyTranscriptState({ onActivity: p => phases.push(p) });
  state.accept({ ...planner(1, 'view_file'), tool_calls: [{ name: 'view_file' }, { name: 'search_web' }] });
  assert.equal(phases.at(-1), 'searching');
  state.accept(result(2));
  assert.equal(state.activity.phase, 'searching');
  state.accept(result(3));
  assert.equal(state.activity.phase, '');
  const activity = state.activity;
  assert.equal(activity.accept({ event: 'step_update', step_update: { thinking_delta: 'thought' } }), 'thinking');
  assert.equal(activity.accept({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'answer' } }), 'responding');
  assert.equal(activity.accept({ event: 'result' }), '');
});

test('live agy transcript watcher emits shell cards/status and isolates known conversations', async () => {
  const dir = fixture();
  const brain = path.join(dir, 'brain');
  const transcript = path.join(brain, 'own', '.system_generated', 'logs', 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ ...planner(0, 'write_to_file', { TargetFile: path.join(dir, 'old.py'), CodeContent: 'old turn' }), created_at: new Date().toISOString() }) + '\n');
  const phases = [], cards = [];
  const watcher = watchAgyTranscript({ cwd: dir, env: { CLI_AGY_BRAIN_DIR: brain }, conversation: () => 'own',
    onActivity: p => phases.push(p), emit: (_notes, content) => cards.push(content) });
  const append = step => fs.appendFileSync(transcript, JSON.stringify({ created_at: new Date().toISOString(), ...step }) + '\n');
  try {
    append(planner(1, 'run_command', { Cwd: dir, CommandLine: 'python edit.py' }));
    for (let i = 0; i < 30 && !phases.includes('running'); i++) await delay(50);
    assert.ok(phases.includes('running'));
    fs.writeFileSync(path.join(dir, 'a.py'), 'changed\n');
    fs.appendFileSync(transcript, JSON.stringify({ ...result(2), created_at: new Date().toISOString() }));
    watcher.finish();
    assert.match(cards.join(''), /📝.*a\.py/);
    assert.doesNotMatch(cards.join(''), /old\.py/);
    assert.ok(!phases.includes('writing'));
    assert.equal(phases.at(-1), '');
    const foreign = [];
    const isolated = watchAgyTranscript({ env: { CLI_AGY_BRAIN_DIR: brain }, conversation: () => 'missing', emit: (...args) => foreign.push(args) });
    isolated.finish();
    assert.equal(foreign.length, 0);
  } finally { watcher.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agy subprocess connects transcript activity and shell diffs to the actual stream callbacks', async () => {
  const dir = fixture();
  const brain = path.join(dir, 'brain');
  const transcript = path.join(brain, 'test-run', '.system_generated', 'logs', 'transcript_full.jsonl');
  const script = path.join(dir, 'fake-agy.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
    import path from 'node:path';
    const file = ${JSON.stringify(transcript)}, root = ${JSON.stringify(dir)};
    const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
    const record = o => fs.appendFileSync(file, JSON.stringify({ created_at: new Date().toISOString(), ...o }) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      out({ event: 'init', conversation_id: 'test-run' });
      record({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { Cwd: root, CommandLine: 'python edit.py' } }] });
      setTimeout(() => {
        fs.writeFileSync(path.join(root, 'a.py'), 'subprocess edit\\n');
        record({ step_index: 2, type: 'GENERIC', status: 'DONE' });
      }, 850);
      setTimeout(() => {
        out({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'done' } });
        out({ event: 'result', result: { status: 'SUCCESS' } });
        process.exit(0);
      }, 1500);
    });`);
  let bin = script;
  if (process.platform === 'win32') {
    bin = path.join(dir, 'agy.cmd');
    fs.writeFileSync(bin, '@ECHO off\r\nnode "%dp0%\\fake-agy.mjs" %*\r\n');
  } else {
    fs.writeFileSync(script, `#!${process.execPath}\n${fs.readFileSync(script, 'utf8')}`);
    fs.chmodSync(script, 0o755);
  }
  const phases = [], deltas = [];
  try {
    await runCli({ provider: PROVIDERS.agy, model: 'test', request: { system: '', prompt: `Edit "${dir}"`, images: [] },
      env: { AGY_CLI_PATH: bin, AGY_AGENTS_DIR: path.join(dir, 'agents'), CLI_AGY_BRAIN_DIR: brain, CLI_TIMEOUT_MS: '10000' },
      onActivity: p => phases.push(p), onDelta: d => deltas.push(d) });
    assert.ok(phases.includes('running'));
    assert.ok(phases.includes('responding'));
    assert.equal(phases.at(-1), '');
    assert.match(deltas.map(d => d.content || '').join(''), /📝.*a\.py/);
    assert.doesNotMatch(deltas.map(d => d.content || '').join(''), /user\.py/);
  } finally { await delay(100); await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
