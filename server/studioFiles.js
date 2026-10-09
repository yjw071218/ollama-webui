import fs from 'node:fs';
import path from 'node:path';
import { ENGINES_DIR } from './engines.js';

// Resolve only media underneath a configured/local ComfyUI data directory.
export function localStudioFile(query, env = {}) {
  const type = query.get('type') || 'output';
  if (!['output', 'input', 'temp'].includes(type)) return null;
  const name = query.get('filename') || '';
  const sub = query.get('subfolder') || '';
  if (!name || /[\\/:\0]/.test(name) || path.isAbsolute(sub)) return null;
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac' }[path.extname(name).toLowerCase()];
  if (!mime) return null;
  const parent = path.resolve(ENGINES_DIR, '../..');
  const roots = env.COMFYUI_PATH ? [env.COMFYUI_PATH] : [path.join(ENGINES_DIR, 'comfyui'), path.join(parent, 'ComfyUI'), path.join(parent, 'ComfyUI-Easy-Install', 'ComfyUI-Easy-Install')];
  for (const root of roots) for (const dir of [path.join(root, 'ComfyUI', type), path.join(root, type)]) {
    try {
      const base = fs.realpathSync(dir);
      const file = fs.realpathSync(path.resolve(base, sub, name));
      const rel = path.relative(base, file);
      if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !fs.statSync(file).isFile()) continue;
      return { file, mime };
    } catch { /* another installation or a missing file */ }
  }
  return null;
}
