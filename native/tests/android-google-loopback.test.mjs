import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLBACK_PAGE, CALLBACK_SCRIPT } from '../desktop/googleLoopback.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const javaHome = process.env.JAVA_HOME || path.join(root, '.tools/jdk');
const exe = name => path.join(javaHome, 'bin', process.platform === 'win32' ? name + '.exe' : name);
const androidJar = path.join(process.env.ANDROID_HOME || path.join(root, '.tools/android-sdk'), 'platforms/android-35/android.jar');
const pkg = path.join(root, 'android/app/src/main/java/io/github/yjw071218/ollamawebui/client');

test('Android Google loopback: handoff parsing, Google URL, and the same page as Windows', { skip: !existsSync(exe('javac')) || !existsSync(androidJar) }, () => {
  const out = path.join(root, 'artifacts/java-tests-google'); mkdirSync(out, { recursive: true });
  const built = spawnSync(exe('javac'), ['-encoding', 'UTF-8', '-cp', androidJar, '-d', out,
    path.join(pkg, 'GoogleLoopback.java'), path.join(pkg, 'ReleaseUpdates.java'),
    path.join(root, 'tests/GoogleLoopbackAccess.java'), path.join(root, 'tests/GoogleLoopbackHarness.java')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  // Through files: page/script contain quotes and newlines.
  const pageFile = path.join(out, 'page.txt'), scriptFile = path.join(out, 'script.txt');
  writeFileSync(pageFile, CALLBACK_PAGE.replace(/"Segoe UI","Malgun Gothic",/, '')); writeFileSync(scriptFile, CALLBACK_SCRIPT);
  const run = spawnSync(exe('java'), ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-cp', out + path.delimiter + androidJar,
    'GoogleLoopbackHarness', 'FILE:' + pageFile, 'FILE:' + scriptFile], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /FAIL/);
  assert.ok((run.stdout.match(/PASS/g) || []).length >= 12, run.stdout);
});
