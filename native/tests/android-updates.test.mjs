import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.JAVA_HOME || path.join(root, '.tools/jdk');
const exe = name => path.join(javaHome, 'bin', process.platform === 'win32' ? name + '.exe' : name);
const androidJar = path.join(process.env.ANDROID_HOME || path.join(root, '.tools/android-sdk'), 'platforms/android-35/android.jar');

test('Android update logic: versions, notes, checksums and trusted hosts', { skip: !existsSync(exe('javac')) || !existsSync(androidJar) }, () => {
  const out = path.join(root, 'artifacts/java-tests-updates'); mkdirSync(out, { recursive: true });
  const src = path.join(root, 'android/app/src/main/java/io/github/yjw071218/ollamawebui/client/ReleaseUpdates.java');
  const built = spawnSync(exe('javac'), ['-encoding', 'UTF-8', '-cp', androidJar, '-d', out, src,
    path.join(root, 'tests/ReleaseUpdatesAccess.java'), path.join(root, 'tests/ReleaseUpdatesHarness.java')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(exe('java'), ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', out + path.delimiter + androidJar, 'ReleaseUpdatesHarness'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /FAIL/);
  assert.ok((run.stdout.match(/PASS/g) || []).length >= 14, run.stdout);
});
