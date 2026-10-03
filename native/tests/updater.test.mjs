import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  selectUpdate, releaseNotes, expectedHash, trustedDownloadURL, downloadUpdate, portableScript, encodePowerShell,
} from '../desktop/updates.mjs';

const asset = (name, size = 1000) => ({ name, size, state: 'uploaded', browser_download_url: 'https://github.com/x/releases/download/t/' + name });
const release = (tag, more = {}) => ({
  tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-04T00:00:00Z',
  body: '## 이번 버전\n- 앱 안에서 업데이트\n- 진행률 표시\n\n## 서버 연결형 Android / Windows 앱\n- 오래된 설명',
  assets: [asset(`OllamaWebUI-Client-${tag.slice(8)}-x64-Setup.exe`), asset(`OllamaWebUI-Client-${tag.slice(8)}-x64-Portable.exe`),
    asset(`OllamaWebUI-Client-${tag.slice(8)}.apk`), asset('SHA256SUMS.txt', 300)],
  ...more,
});

test('picks the installer that matches how the app was installed, with notes and checksums', () => {
  const list = [release('native-v1.0.7'), release('native-v1.0.8', { prerelease: true }), release('v9.9.9')];
  const setup = selectUpdate(list, '1.0.6');
  assert.equal(setup.version, '1.0.7');
  assert.equal(setup.asset.name, 'OllamaWebUI-Client-1.0.7-x64-Setup.exe');
  assert.match(setup.sumsUrl, /SHA256SUMS\.txt$/);
  assert.equal(setup.notes, '- 앱 안에서 업데이트\n- 진행률 표시');
  assert.equal(selectUpdate(list, '1.0.6', 'portable').asset.name, 'OllamaWebUI-Client-1.0.7-x64-Portable.exe');
  assert.equal(selectUpdate(list, '1.0.6', 'android').asset.name, 'OllamaWebUI-Client-1.0.7.apk');
  assert.equal(selectUpdate(list, '1.0.7'), null);
  // An oddly named asset is never chosen.
  const odd = release('native-v1.0.9', { assets: [asset('OllamaWebUI-Client-1.0.9-x64-Setup.exe.evil.exe')] });
  assert.equal(selectUpdate([odd], '1.0.6'), null);
});

test('release notes fall back to the start of the body and are capped', () => {
  assert.equal(releaseNotes('- a\n- b'), '- a\n- b');
  assert.equal(releaseNotes('x'.repeat(5000)).length, 4001);
  assert.equal(releaseNotes(null), '');
});

test('checksum list lookup is exact', () => {
  const sums = 'a'.repeat(64) + '  file.exe\n' + 'B'.repeat(64) + ' *other.apk\n';
  assert.equal(expectedHash(sums, 'file.exe'), 'a'.repeat(64));
  assert.equal(expectedHash(sums, 'other.apk'), 'b'.repeat(64));
  assert.equal(expectedHash(sums, 'file'), null);
});

test('only GitHub hosts over HTTPS are trusted', () => {
  for (const ok of ['https://github.com/a', 'https://objects.githubusercontent.com/b', 'https://release-assets.githubusercontent.com/c'])
    assert.ok(trustedDownloadURL(ok), ok);
  for (const bad of ['http://github.com/a', 'https://github.com.evil.example/a', 'https://evil.example/a',
    'https://user@github.com/a', 'file:///C:/x', 'nonsense'])
    assert.equal(trustedDownloadURL(bad), false, bad);
});

async function fixture(t, routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const host = '127.0.0.1:' + server.address().port;
  const dir = await mkdtemp(path.join(tmpdir(), '업데이트-test-'));
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  return { base: 'http://' + host, extraHosts: [host], dir };
}
const payload = Buffer.alloc(300_000, 7);
const sha = createHash('sha256').update(payload).digest('hex');
const info = (base, more = {}) => ({ version: '1.0.7', asset: { name: 'App-Setup.exe', size: payload.length, url: base + '/asset' }, sumsUrl: base + '/sums', ...more });

test('downloads, reports progress and verifies size and SHA-256', async (t) => {
  const f = await fixture(t, {
    '/sums': (q, r) => r.end(sha + '  App-Setup.exe\n'),
    '/asset': (q, r) => { r.writeHead(302, { location: '/real' }); r.end(); },
    '/real': (q, r) => { r.write(payload.subarray(0, 100_000)); setTimeout(() => r.end(payload.subarray(100_000)), 20); },
  });
  const progress = [];
  const dest = path.join(f.dir, 'App-Setup.exe');
  const out = await downloadUpdate(info(f.base), dest, { extraHosts: f.extraHosts, onProgress: p => progress.push(p) });
  assert.equal(out.sha256, sha);
  assert.deepEqual(await readFile(dest), payload);
  assert.equal(progress.at(-1).percent, 100);
  assert.ok(progress.length >= 2);
  assert.deepEqual(await readdir(f.dir), ['App-Setup.exe']);
});

test('a tampered, truncated or oversized file is rejected and nothing is left behind', async (t) => {
  const bad = Buffer.from(payload); bad[5] = 9;
  const f = await fixture(t, {
    '/sums': (q, r) => r.end(sha + '  App-Setup.exe\n'),
    '/tampered': (q, r) => r.end(bad),
    '/short': (q, r) => r.end(payload.subarray(0, 1000)),
    '/long': (q, r) => r.end(Buffer.concat([payload, Buffer.alloc(10)])),
  });
  for (const [url, message] of [['/tampered', /SHA-256/], ['/short', /완료되지/], ['/long', /크기/]]) {
    const dest = path.join(f.dir, 'App-Setup.exe');
    await assert.rejects(downloadUpdate(info(f.base, { asset: { name: 'App-Setup.exe', size: payload.length, url: f.base + url } }), dest, { extraHosts: f.extraHosts }), message);
    assert.deepEqual(await readdir(f.dir), []);
  }
});

test('missing checksum entry, untrusted redirect and cancellation stop the download', async (t) => {
  const f = await fixture(t, {
    '/sums': (q, r) => r.end('0'.repeat(64) + '  Other.exe\n'),
    '/sums-ok': (q, r) => r.end(sha + '  App-Setup.exe\n'),
    '/away': (q, r) => { r.writeHead(302, { location: 'https://evil.example/x' }); r.end(); },
    '/slow': (q, r) => { r.write(payload.subarray(0, 1000)); },
  });
  const dest = path.join(f.dir, 'App-Setup.exe');
  await assert.rejects(downloadUpdate(info(f.base), dest, { extraHosts: f.extraHosts }), /검증 정보에 설치 파일이 없습니다/);
  await assert.rejects(downloadUpdate(info(f.base, { sumsUrl: f.base + '/sums-ok', asset: { name: 'App-Setup.exe', size: payload.length, url: f.base + '/away' } }), dest, { extraHosts: f.extraHosts }), /신뢰하지 않는/);
  const controller = new AbortController();
  const pending = downloadUpdate(info(f.base, { sumsUrl: f.base + '/sums-ok', asset: { name: 'App-Setup.exe', size: payload.length, url: f.base + '/slow' } }), dest,
    { extraHosts: f.extraHosts, signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(pending);
  assert.deepEqual(await readdir(f.dir), []);
  await assert.rejects(downloadUpdate({ asset: { url: 'x' } }, dest), /SHA256SUMS/);
});

test('portable swap script moves the new file over the old one, Korean and quote paths included', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "포터블 it's-"));
  try {
    const next = path.join(dir, '새 버전.exe'), target = path.join(dir, "기존 앱's.exe");
    await writeFile(next, 'new'); await writeFile(target, 'old');
    const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(portableScript(next, target, false))]);
    assert.equal(await readFile(target, 'utf8'), 'new');
    assert.equal(existsSync(next), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
  assert.throws(() => portableScript('relative.exe', 'C:\\a.exe'));
  assert.throws(() => portableScript('C:\\a\nb.exe', 'C:\\a.exe'));
});
