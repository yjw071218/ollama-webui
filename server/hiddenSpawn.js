import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hiddenLaunch.mjs');

/**
 * spawn(command, args, { ...options, detached: true }) for a program that must
 * outlive this server, without console windows flashing on Windows.
 * See server/hiddenLaunch.mjs for why. Elsewhere, and when a test passes its
 * own spawnImpl, it is the plain call.
 */
export const spawnDetachedHidden = (command, args, options = {}, { spawnImpl = spawn, platform = process.platform } = {}) => {
  const opts = { ...options, detached: true, windowsHide: true };
  if (platform !== 'win32' || spawnImpl !== spawn) return spawnImpl(command, args, opts);
  const spec = Buffer.from(JSON.stringify({ command, args })).toString('base64');
  return spawnImpl(process.execPath, [LAUNCHER, spec], opts);
};
