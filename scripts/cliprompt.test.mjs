import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requestApproval, listApprovals, decideApproval, watchApprovalDir, codexQuestionOf, codexQuestionReply, claudeAnswers,
} from '../server/cliProject.js';
import { envForRequest, askOf } from '../server/cliModels.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

// Asking can only be switched on from the browser, never off.
assert.equal(askOf(envForRequest({}, { 'x-cli-approvals': 'ask' })), true);
assert.equal(askOf(envForRequest({}, { 'x-cli-approvals': 'skip' })), false);
assert.equal(askOf(envForRequest({ CLI_ASK: '1' }, {})), true);
console.log('PASS approvals header only makes a chat stricter');

// A question keeps everything the CLI sent and returns the chosen labels.
const asked = requestApproval({
  owner: 'u1', provider: 'claude-code', kind: 'question', title: 'Which?',
  questions: [{ id: 'Which?', header: 'Lib', question: 'Which?', multiSelect: true,
    options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }],
});
const [item] = listApprovals('u1');
assert.equal(item.questions[0].options[1].description, 'second');
assert.equal(item.questions[0].multiSelect, true);
assert.equal(listApprovals('someone-else').length, 0);
assert.equal(decideApproval('u1', item.id, 'answer', { 'Which?': ['A', 'custom text'] }), true);
assert.deepEqual(await asked, { decision: 'answer', answers: { 'Which?': ['A', 'custom text'] } });
assert.deepEqual(claudeAnswers([{ id: 'Which?', question: 'Which?' }], { 'Which?': ['A', 'B'] }), { 'Which?': 'A, B' });
console.log('PASS question options, answers and owner isolation');

// A plain approval still resolves with the decision string.
const plain = requestApproval({ owner: 'u1', provider: 'codex', kind: 'command', title: 'npm test' });
decideApproval('u1', listApprovals('u1')[0].id, 'accept');
assert.equal(await plain, 'accept');

// Claude Code's AskUserQuestion through the permission-prompt files.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-'));
const stop = watchApprovalDir(dir, (q) => {
  assert.equal(q.kind, 'question');
  return Promise.resolve({ decision: 'answer', answers: { 'Pick one': ['Yes'] } });
});
fs.writeFileSync(path.join(dir, '1.req.json'), JSON.stringify({ tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Pick one', header: 'H', options: [{ label: 'Yes', description: '' }], multiSelect: false }] } }));
let res;
for (let i = 0; i < 40 && !res; i++) { await delay(100); try { res = JSON.parse(fs.readFileSync(path.join(dir, '1.res.json'), 'utf8')); } catch { /* not yet */ } }
stop();
assert.equal(res.behavior, 'allow');
assert.deepEqual(res.updatedInput.answers, { 'Pick one': 'Yes' });
assert.equal(res.updatedInput.questions[0].header, 'H');
console.log('PASS Claude AskUserQuestion round trip');

// Codex requestUserInput.
const m = { id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', header: 'Env', question: 'Where?', options: [{ label: 'dev', description: 'd' }] }] } };
const cq = codexQuestionOf(m);
assert.equal(cq.kind, 'question');
assert.equal(cq.questions[0].id, 'q1');
assert.deepEqual(codexQuestionReply(m, { decision: 'answer', answers: { q1: ['dev'] } }), { id: 7, result: { answers: { q1: { answers: ['dev'] } } } });
assert.equal(codexQuestionOf({ id: 1, method: 'item/commandExecution/requestApproval' }), null);
console.log('PASS Codex requestUserInput round trip');
process.exit(0);
