// The synchronous copy written on the way out (src/unloadJournal.js), so one
// refresh shows what was on screen rather than what storage had got to.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const { writeJournal, takeJournal, withJournal } = await import('../src/unloadJournal.js');

const chat = (id, updatedAt, extra = {}) => ({ id, updatedAt, createdAt: updatedAt, messages: [{ role: 'user', content: id }], ...extra });

test('written on the way out, read once by the next page', () => {
  writeJournal('k', [chat('a', 5), chat('b', 9)]);
  const first = takeJournal('k');
  assert.deepEqual(first.chats.map(c => c.id), ['b', 'a']);
  assert.equal(takeJournal('k').chats.length, 0, 'cleared after reading');
});

test('a newer journalled copy replaces the stored one; an older does not', () => {
  const stored = [chat('a', 10, { messages: [{ role: 'user', content: 'old' }] }), chat('b', 20)];
  const merged = withJournal(stored, { at: 100, chats: [chat('a', 30), chat('b', 15)] });
  assert.equal(merged.find(c => c.id === 'a').updatedAt, 30);
  assert.equal(merged.find(c => c.id === 'b').updatedAt, 20);
});

test('a chat started just before leaving is added; an old one missing from storage was deleted', () => {
  const now = Date.now();
  const merged = withJournal([], { at: now, chats: [chat('new', now - 1000), chat('gone', now - 60 * 60 * 1000)] });
  assert.deepEqual(merged.map(c => c.id), ['new']);
});

test('nothing to lay over leaves the stored list as it was', () => {
  const stored = [chat('a', 1)];
  assert.equal(withJournal(stored, { at: 0, chats: [] }), stored);
  assert.equal(withJournal(stored, { at: 5, chats: [chat('a', 1)] }), stored);
});

test('drafts with no messages and oversized chats are not written', () => {
  writeJournal('k2', [{ id: 'draft', updatedAt: 1, messages: [] }]);
  assert.equal(takeJournal('k2').chats.length, 0);
  const huge = chat('huge', 2, { messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] });
  writeJournal('k3', [huge, chat('small', 1)]);
  assert.deepEqual(takeJournal('k3').chats.map(c => c.id), ['small']);
});
