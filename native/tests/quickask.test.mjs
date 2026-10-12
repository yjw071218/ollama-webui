import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { canShare, whyNoSheet } from '../../src/share.js';

const root = fileURLToPath(new URL('..', import.meta.url));
test('PROCESS_TEXT targets only the floating activity', () => {
  const manifest = readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  const activities = [...manifest.matchAll(/<activity\b[^>]*>[\s\S]*?<\/activity>/g)].map(m => m[0]);
  const targets = activities.filter(a => a.includes('android.intent.action.PROCESS_TEXT'));
  assert.equal(targets.length, 1);
  assert.match(targets[0], /android:name="\.QuickAskActivity"/);
  assert.match(targets[0], /android:taskAffinity=""/);
});

test('native sharing works without HTTPS only when the bridge offers it', () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { share() {} } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: false } });
    assert.equal(canShare(), false); assert.equal(whyNoSheet(), 'insecure');
    window.ollamaNative = { capabilities: { share: true } };
    assert.equal(canShare(), true); assert.equal(whyNoSheet(), '');
    delete navigator.share;
    assert.equal(canShare(), false);
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
    if (win) Object.defineProperty(globalThis, 'window', win); else delete globalThis.window;
  }
});

test('Android text clipboard bridge preserves binary clipboard APIs', async () => {
  const binaryRead = () => Promise.resolve(['image']);
  const binaryWrite = () => Promise.resolve();
  const clipboard = Object.create({ read: binaryRead, write: binaryWrite });
  const calls = [];
  const host = { postMessage(raw) {
    const request = JSON.parse(raw); calls.push(request);
    host.onmessage({ data: JSON.stringify({ id: request.id, value: request.method === 'clipboardRead' ? 'selected' : true }) });
  } };
  const context = { navigator: { language: 'ko', clipboard }, NativeHost: host,
    document: { readyState: 'loading', addEventListener() {} },
    HTMLAnchorElement: class { click() {} }, addEventListener() {},
    setTimeout, clearTimeout, DOMException };
  context.window = context; context.top = context;
  vm.runInNewContext(readFileSync(path.join(root, 'android/app/src/main/assets/native.js'), 'utf8'), context);
  assert.equal(context.navigator.clipboard.read, binaryRead);
  assert.equal(context.navigator.clipboard.write, binaryWrite);
  await context.navigator.clipboard.writeText('hello');
  assert.equal(await context.navigator.clipboard.readText(), 'selected');
  assert.deepEqual(calls.map(c => c.method), ['clipboardWrite', 'clipboardRead']);
  assert.equal(context.ollamaNative.capabilities.share, true);
});

test('main and floating activities can close independently and reuse their origin', () => {
  const out = mkdtempSync(path.join(os.tmpdir(), 'quickask-gateway-'));
  const bin = path.join(process.env.JAVA_HOME || path.join(root, '.tools/jdk'), 'bin');
  const exe = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  const source = path.join(root, 'android/app/src/main/java/io/github/yjw071218/ollamawebui/client');
  try {
    const compile = spawnSync(exe('javac'), ['-encoding', 'UTF-8', '-d', out,
      path.join(source, 'L.java'), path.join(source, 'LoopbackProxy.java'), path.join(source, 'ClientGateways.java'),
      path.join(root, 'tests/ClientGatewaysHarness.java')], { encoding: 'utf8', timeout: 30000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(exe('java'), ['-cp', out, 'io.github.yjw071218.ollamawebui.client.ClientGatewaysHarness'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /PASS shared gateway/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
