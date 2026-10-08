// A <think> the answer merely talks about must not swallow the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssistantMessage as parse } from '../src/messageParts.js';
const types = (s, o) => parse(s, o).map(b => b.type).join(',');

test('mid-sentence <think> is text, and is shown', () => {
  const b = parse('Rendering side — where the <think> is turned into a dropdown:\n\n```diff\n+x\n```\nDone.');
  assert.equal(b.length, 1); assert.equal(b[0].type, 'text');
  assert.match(b[0].content, /&lt;think&gt;/); assert.match(b[0].content, /Done\./);
});
test('an unclosed tag after the answer began is text, streaming or not', () => {
  assert.equal(types('Answer\n<think>\nmore'), 'text');
  assert.equal(types('Answer\n<think>\nmore', { streaming: true }), 'text');
});
test('real reasoning still folds', () => {
  assert.equal(types('<think>\nr\n</think>\n\nAnswer'), 'think,text');
  assert.equal(types('<think>\nso far', { streaming: true }), 'think');
  assert.equal(types('<think>\ncut off'), 'think');
  assert.equal(types('<think>\na\n</think>\nmid\n<think>\nb\n</think>\nend'), 'think,text,think,text');
});
test('tags in code stay literal', () => {
  assert.equal(parse('Use `<think>` here')[0].content, 'Use `<think>` here');
});
