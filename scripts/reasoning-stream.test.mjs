import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexSession, AgyReader, watchAgyTranscript, buildInvocation, PROVIDERS } from '../server/cliModels.js';

test('Codex requests summaries on every new or resumed chat and project turn', () => {
  for (const project of [null, { dir: os.tmpdir(), mode: 'plan' }]) {
    for (const resume of ['', 'existing-thread']) {
      for (const think of [true, false]) {
        const invocation = buildInvocation(PROVIDERS.codex, 'test-model', { prompt: 'Hello', system: '', images: [] },
          { files: os.tmpdir(), env: {}, project, resume, think });
        const reader = invocation.session;
        reader.accept({ id: 1, result: {} });
        const start = reader.accept({ id: 2, result: { thread: { id: 'test-thread' } } }).write[0];
        assert.equal(start.params.summary, think ? 'detailed' : 'none');
      }
    }
  }
});

test('Codex opens thinking immediately and streams summaries without completion replay', () => {
  const reader = new CodexSession({ thread: {}, turn: {} });
  assert.equal(reader.accept({ method: 'item/started', params: { item: { id: 'r', type: 'reasoning' } } }).started, true);
  for (const delta of ['Live', ' summary']) {
    assert.equal(reader.accept({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta } }).thinking, delta);
  }
  assert.equal(reader.accept({ method: 'item/completed', params: { item: { id: 'r', type: 'reasoning', summary: ['Live summary'] } } }), null);
});

test('Codex retains completion fallback after a reasoning start without deltas', () => {
  const reader = new CodexSession({ thread: {}, turn: {} });
  reader.accept({ method: 'item/started', params: { item: { id: 'r', type: 'reasoning' } } });
  assert.equal(reader.accept({ method: 'item/completed', params: { item: { id: 'r', type: 'reasoning', summary: ['Summary'] } } }).thinking, 'Summary');
});

test('empty Codex raw delta does not suppress later summary deltas', () => {
  const reader = new CodexSession({ thread: {}, turn: {} });
  assert.equal(reader.accept({ method: 'item/reasoning/textDelta', params: { itemId: 'r', delta: '' } }), null);
  const out = reader.accept({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r', delta: 'Live summary' } });
  assert.equal(out.thinking, 'Live summary');
  assert.equal(out.reasoning, true);
});

test('agy preserves thinking and answer arriving in the same event', () => {
  const reader = new AgyReader();
  const out = reader.accept({ event: 'step_update', step_update: { thinking_delta: 'Summary', step_type: 'agent_response', text_delta: 'Answer' } });
  assert.equal(out.thinking, 'Summary');
  assert.equal(out.content, 'Answer');
});

test('agy growing planner summaries arrive before finish without duplicates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-stream-'));
  const file = path.join(root, 'own', '.system_generated', 'logs', 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const chunks = [], notes = [];
  const watcher = watchAgyTranscript({ env: { CLI_AGY_BRAIN_DIR: root }, conversation: () => 'own',
    emitReasoning: text => chunks.push(text), emit: text => notes.push(text) });
  const append = thinking => fs.appendFileSync(file, JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING', thinking }) + '\n');
  try {
    append('First');
    await delay(850);
    assert.equal(chunks.join(''), 'First');
    append('First second');
    append('First second');
    await delay(850);
    assert.equal(chunks.join(''), 'First second');
    watcher.finish();
    assert.equal(chunks.join(''), 'First second');
    assert.equal(notes.join(''), '', 'reasoning must not bypass the thinking toggle as tool notes');
  } finally {
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
