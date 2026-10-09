import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localStudioFile } from '../server/studioFiles.js';
test('offline ComfyUI files resolve within the media folder only', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'studio-files-test-'));
  try {
    mkdirSync(path.join(root, 'ComfyUI/output/webui'), { recursive: true });
    writeFileSync(path.join(root, 'ComfyUI/output/webui/image.png'), 'test');
    writeFileSync(path.join(root, 'ComfyUI/secret.png'), 'private');
    const query = new URLSearchParams({ filename: 'image.png', subfolder: 'webui', type: 'output' });
    assert.equal(localStudioFile(query, { COMFYUI_PATH: root }).mime, 'image/png');
    query.set('filename', 'secret.png'); query.set('subfolder', '..');
    assert.equal(localStudioFile(query, { COMFYUI_PATH: root }), null);
    query.set('filename', '../secret.png'); query.set('subfolder', '');
    assert.equal(localStudioFile(query, { COMFYUI_PATH: root }), null);
    query.set('type', '..'); assert.equal(localStudioFile(query, { COMFYUI_PATH: root }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('view endpoint serves original bytes when ComfyUI refuses connections', async () => {
  const { createServer } = await import('node:http');
  const { createStudioRoutes } = await import('../server/studio.js');
  const root = mkdtempSync(path.join(os.tmpdir(), 'studio-offline-test-'));
  mkdirSync(path.join(root, 'ComfyUI/output'), { recursive: true });
  writeFileSync(path.join(root, 'ComfyUI/output/image.png'), 'original-image-bytes');
  const route = createStudioRoutes({ COMFYUI_PATH: root, COMFYUI_URL: 'http://127.0.0.1:1' }).find(r => r.path === '/studio/view');
  const server = createServer((req, res) => route.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/studio/view?filename=image.png&preview=webp;85`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(await response.text(), 'original-image-bytes');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
