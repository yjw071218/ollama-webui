import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canCaptureScreen, captureScreen } from '../../src/capture.js';
test('Android screenshot delegates to the consent-backed native implementation', async () => {
  const previous = globalThis.window;
  try {
    const file = new Blob(['test'], { type: 'image/jpeg' });
    globalThis.window = { ollamaNative: { captureScreen: async () => file } };
    assert.equal(canCaptureScreen(), true); assert.equal(await captureScreen(), file);
    globalThis.window.ollamaNative.captureScreen = async () => null;
    assert.equal(await captureScreen(), null);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});
