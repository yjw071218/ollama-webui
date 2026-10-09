import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function localPath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new Error('Invalid local path');
  let target = value;
  if (/^file:\/\//i.test(value)) target = fileURLToPath(value);
  else { try { target = decodeURIComponent(value); } catch { throw new Error('Invalid path encoding'); } }
  // Only absolute drive paths; reject device paths, network shares and alternate streams.
  if (!/^[a-z]:[\\/]/i.test(target) || target.slice(2).includes(':') || /[\x00-\x1f]/.test(target)) throw new Error('Invalid local path');
  return path.win32.normalize(target);
}
