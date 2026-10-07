// The browser keys in the Windows app (desktop/shortcuts.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutFor } from '../desktop/shortcuts.mjs';

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, control: false, meta: false, shift: false, alt: false, ...mods });

test('F5 and Ctrl+R reload the page', () => {
  assert.equal(shortcutFor(key('F5')), 'reload');
  assert.equal(shortcutFor(key('r', { control: true })), 'reload');
});
test('Ctrl+F5, Shift+F5 and Ctrl+Shift+R reload without the cache', () => {
  assert.equal(shortcutFor(key('F5', { control: true })), 'hardReload');
  assert.equal(shortcutFor(key('F5', { shift: true })), 'hardReload');
  assert.equal(shortcutFor(key('R', { control: true, shift: true })), 'hardReload');
});
test('F11 toggles full screen', () => assert.equal(shortcutFor(key('F11')), 'fullscreen'));
test('everything else is left to the page', () => {
  assert.equal(shortcutFor(key('r')), null);           // typing an r
  assert.equal(shortcutFor(key('F5', { alt: true })), null);
  assert.equal(shortcutFor({ ...key('F5'), type: 'keyUp' }), null);
  assert.equal(shortcutFor(key('Enter')), null);
});
