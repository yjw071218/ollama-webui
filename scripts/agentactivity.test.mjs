import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { activityOf, hasActivity, activitySummary, toolKind } from '../src/agentActivity.js';
import { answerChangesIn } from '../src/fileChanges.js';

const RUN = [
  'Let me look at the file first.',
  '',
  '[tool: workbench / read_file · C:\\repo\\src\\App.jsx]',
  '',
  '[tool: workbench / edit_file · C:\\repo\\src\\App.jsx]',
  '',
  '[tool: workbench / run_command · npm test]',
  '',
  '[command: npm test → exit 1]',
  'FAIL scripts/a.test.mjs',
  '[/output]',
  'The test failed; fixing it.',
].join('\n');

test('steps and prose come apart, with a command result joined to its call', () => {
  const segments = activityOf(RUN);
  const steps = segments.filter(s => s.type === 'step');
  assert.deepEqual(steps.map(s => s.kind), ['read', 'edit', 'command']);
  assert.equal(steps[2].status, 'failed');
  assert.equal(steps[2].code, 1);
  assert.equal(steps[2].output, 'FAIL scripts/a.test.mjs');
  const prose = segments.filter(s => s.type === 'prose').map(s => s.text);
  assert.deepEqual(prose, ['Let me look at the file first.', 'The test failed; fixing it.']);
  assert.deepEqual(activitySummary(segments), { steps: 3, commands: 1, edits: 1, failed: 1, running: false });
});

test('the last step is running only while the answer is live', () => {
  const text = '[running: npm run build]';
  assert.equal(activityOf(text, { live: true })[0].status, 'running');
  assert.equal(activityOf(text, { live: false })[0].status, 'done');
});

test('codex running + command lines become one step', () => {
  const steps = activityOf('[running: git status]\n[command: git status → exit 0]\nclean\n[/output]').filter(s => s.type === 'step');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'done');
  assert.equal(steps[0].output, 'clean');
});

test('a failed tool marks the call before it; plain reasoning has no activity', () => {
  const steps = activityOf('[tool: files / read_text_file]\n[tool failed: ENOENT]').filter(s => s.type === 'step');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'failed');
  assert.equal(hasActivity('I think [this] is fine.'), false);
  assert.equal(toolKind('Bash'), 'command');
  assert.equal(toolKind('files / list_directory'), 'search');
});

test('a CLI answer gives up its diffs to the changed-files panel', () => {
  const answer = 'Done.\n\n📝 **`C:\\a.js`** (+1 −1)\n```diff\n-a\n+b\n```\n\nAll good.';
  const { changes, text } = answerChangesIn(answer);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].file, 'C:\\a.js');
  assert.equal(text, 'Done.\n\nAll good.');
});

test('a workbench command is visible in the spool while it runs, and after', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-'));
  process.env.WEBUI_COMMAND_SPOOL = dir;
  const { commandSpool, listCommands } = await import(`../server/liveCommands.js?x=${Date.now()}`);
  const { runCommand } = await import('../server/workbench.js');
  const monitor = commandSpool({ command: 'echo hi', cwd: dir });
  const result = await runCommand('echo hi', { cwd: dir, monitor });
  assert.equal(result.code, 0);
  const [entry] = listCommands().filter(c => c.id === monitor.id);
  assert.equal(entry.status, 'done');
  assert.match(entry.output, /hi/);
  fs.rmSync(dir, { recursive: true, force: true });
});
