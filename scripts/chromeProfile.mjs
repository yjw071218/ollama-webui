/**
 * A headless browser in a profile of its own, and that profile gone afterwards.
 *
 * Every browser test here made a profile in the temp folder and removed it with
 * `child.kill()` and then `fs.rmSync(...)`, with the error swallowed. On
 * Windows neither half works. `kill()` ends the main Chrome process only -- the
 * GPU, renderer and crashpad processes it started live on and keep the profile's
 * files open -- and a directory with open files cannot be deleted, so the
 * `rmSync` failed every time and said nothing. Over a week that was 89 profiles
 * from one test and a 33GB one from another: 60GB of temp folder.
 *
 * So the whole process tree is ended (`taskkill /T` on Windows), the removal is
 * retried while the handles close, and a removal that still fails says so. The
 * same close runs on process exit, for the tests that leave through
 * `process.exit` without cleaning up. And each launch first clears its own
 * leftovers more than an hour old, so a run that was killed half way through
 * is tidied by the next one rather than kept for ever.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const STALE_MS = 60 * 60 * 1000;

/** Remove `prefix*` directories in `dir` older than `olderThan`. Returns how many went. */
export const sweepProfiles = (prefix, { olderThan = STALE_MS, dir = os.tmpdir(), now = Date.now() } = {}) => {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory() || now - stat.mtimeMs < olderThan) continue;
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
    } catch (e) { /* still in use by a run that is still running */ }
  }
  return removed;
};

/** End a process and everything it started. Synchronous, so it works in an exit handler. */
export const killTree = (child) => {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGKILL'); } catch (e) { /* gone */ }
  }
};

/* A real pause in synchronous code: it has to work in an exit handler, where
   nothing asynchronous runs. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const STILL_HELD = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

/**
 * Remove a profile, waiting out the handles a just-killed browser still holds.
 *
 * Its own loop rather than `rmSync`'s `maxRetries`. Measured here: with the
 * whole process tree ended and twenty built-in retries, every profile still
 * failed with EPERM, and the same folders deleted cleanly a minute later --
 * Windows releases a dead process's files a moment after it dies, and the
 * built-in retries did not wait that long. So this sleeps between tries, for
 * up to `waitMs`, and says so if that was still not enough.
 */
export const removeProfile = (profile, { waitMs = 15000 } = {}) => {
  const start = Date.now();
  for (;;) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return true;
    } catch (e) {
      if (!STILL_HELD.has(e.code) || Date.now() - start > waitMs) {
        console.warn(`[chrome] could not remove ${profile}: ${e.code || e.message}`);
        return false;
      }
      sleepSync(250);
    }
  }
};

/**
 * Start `browser` with `args` in a new profile named `prefix…` in the temp
 * folder. `close()` ends it and removes the profile; it is safe to call twice
 * and runs by itself on process exit.
 */
export const launchChrome = (browser, prefix, args = []) => {
  sweepProfiles(prefix);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const child = spawn(browser, [...args, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let closed = false;
  const close = () => {
    if (closed) return true;
    closed = true;
    process.off('exit', close);
    killTree(child);
    return removeProfile(profile);
  };
  process.on('exit', close);
  return { child, profile, close };
};
