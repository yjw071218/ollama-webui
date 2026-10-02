import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// State in a scratch folder, before anything reads the environment.
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpui-'));
process.env.WEBUI_DATA_DIR = data;
process.env.WEBUI_COMMAND_SPOOL = path.join(data, 'spool');

const { activityOf } = await import('../src/agentActivity.js');
const { ansiSpans, lineTone, outputLines, errorCount, stripAnsi } = await import('../src/terminalText.js');
const state = await import('../server/workbenchState.js');
const { urlsIn } = await import('../server/liveCommands.js');
const { writeFile, editFile } = await import('../server/workbench.js');

test('steps carry their time, arguments and result', () => {
  const text = [
    '[at: 1700000000000]',
    '[tool: files / read_text_file · C:\\a.js]',
    '[input: {"path":"C:\\\\a.js"}]',
    '[result]',
    'line one',
    '[/output]',
    '[at: 1700000002500]',
    '[tool: workbench / run_command · npm test]',
    '[at: 1700000010000]',
    '[command: npm test → exit 0]',
    'ok',
    '[/output]',
  ].join('\n');
  const steps = activityOf(text).filter(s => s.type === 'step');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].ms, 2500);
  assert.equal(steps[0].input, '{"path":"C:\\\\a.js"}');
  assert.equal(steps[0].result, 'line one');
  assert.equal(steps[1].ms, 7500);
  assert.equal(steps[1].output, 'ok');
});

test('terminal text: colours, tones, filter', () => {
  assert.deepEqual(ansiSpans('\u001b[31mred\u001b[0m plain'), [{ text: 'red', fg: 'red', bold: false }, { text: ' plain', fg: null, bold: false }]);
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[39m'), 'ok');
  assert.equal(lineTone('npm ERR! missing script'), 'error');
  assert.equal(lineTone('    at foo (C:\\a.js:3:9)'), 'error');
  assert.equal(lineTone('warning: unused'), 'warn');
  assert.equal(lineTone('Tests: 3 passed, 0 failed'), 'ok');
  assert.equal(outputLines('a\nfind me\nb', { query: 'FIND' }).length, 1);
  assert.equal(errorCount('ok\nError: x\nfine'), 1);
});

test('a dev server address is found in its output', () => {
  assert.deepEqual(urlsIn('  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m'), ['http://localhost:5173/']);
  assert.deepEqual(urlsIn('listening on http://0.0.0.0:3000.'), ['http://localhost:3000']);
});

test('the policy narrows and never widens', () => {
  const start = [path.resolve('C:\\'), path.resolve('D:\\')];
  assert.deepEqual(state.effectiveAccess(start, {}, { ...state.DEFAULT_POLICY }).roots, start);
  const narrowed = state.effectiveAccess(start, {}, { ...state.DEFAULT_POLICY, roots: ['C:\\work', 'Z:\\elsewhere'] });
  assert.deepEqual(narrowed.roots, [path.resolve('C:\\work')]);
  // Commands off in the file stay off whatever the policy says.
  assert.equal(state.effectiveAccess(start, { noCommands: true }, { ...state.DEFAULT_POLICY, commands: true }).commands, false);
  assert.equal(state.effectiveAccess(start, {}, { ...state.DEFAULT_POLICY, readOnly: true }).commands, false);
});

test('approval rules: prefixes and regexes, bad ones refused', () => {
  state.writePolicy({ autoApprove: ['npm test', '/^git (status|diff)$/'] });
  assert.equal(state.autoApproved('npm test -- --watch=false'), true);
  assert.equal(state.autoApproved('git status'), true);
  assert.equal(state.autoApproved('git push'), false);
  assert.throws(() => state.writePolicy({ autoApprove: ['/(/'] }), /Bad rule/);
  state.writePolicy({ autoApprove: [] });
});

test('a workbench change can be put back, a new file removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-'));
  const existing = path.join(dir, 'a.txt');
  fs.writeFileSync(existing, 'one\n');
  editFile(existing, 'one', 'two');
  editFile(existing, 'two', 'three');
  assert.equal(state.hasBackup(existing), true);
  state.restoreBackup(existing);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'one\n');      // before the first edit
  assert.equal(state.hasBackup(existing), false);

  const created = path.join(dir, 'new.txt');
  writeFile(created, 'hello');
  assert.deepEqual(state.restoreBackup(created), { restored: 'deleted' });
  assert.equal(fs.existsSync(created), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test.after(() => fs.rmSync(data, { recursive: true, force: true }));
