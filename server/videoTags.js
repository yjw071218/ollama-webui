/**
 * What the tagger saw in each finished video, kept.
 *
 * Tagging a clip is ten or twenty seconds of ComfyUI's time. A video is shown
 * in the Studio, in the chat that asked for it and in the gallery, on a laptop
 * and a phone -- and each of those used to have only the prompt to go on. Kept
 * per file, on disk, so the frames are looked at once and every place the video
 * turns up after that has the answer straight away.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 1000;
const TYPES = new Set(['output', 'temp', 'input']);

/**
 * A video ComfyUI wrote, as the name its loaders take and a key to keep it
 * under. Null for anything that is not a plain file in one of ComfyUI's own
 * folders: this is a name handed to a node that opens files, and `..` in it
 * is a way out of the folder.
 */
const mediaFile = ({ filename, subfolder = '', type = 'output' } = {}, extensions) => {
  const name = String(filename || '');
  const folder = String(subfolder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const kind = String(type || 'output');
  if (!name || /[\\/]/.test(name) || name.startsWith('.') || !TYPES.has(kind)) return null;
  if (folder.split('/').some(part => part === '..' || part === '.')) return null;
  if (!extensions.test(name)) return null;
  const relative = folder ? `${folder}/${name}` : name;
  return { key: `${kind}:${relative}`, annotated: `${relative} [${kind}]` };
};

export const videoFile = (body) => mediaFile(body, /\.(mp4|webm|mov|mkv|gif|webp)$/i);

/**
 * And a still, for the same reason.
 *
 * The safeguard asked the browser's classifier what was in a finished picture
 * and the prompt what had been asked for. Neither is the tagger, and the
 * tagger is the thing in this install that actually knows: a 224-pixel
 * MobileNet reading a drawing is guessing, while WD14 was trained on precisely
 * this vocabulary and names what it sees in the same words a prompt is written
 * in. A picture whose prompt was unremarkable and whose classifier said
 * nothing could be explicit and shown, which is the whole failure the
 * safeguard exists to prevent.
 *
 * The same validation as a video and for the same reason: this name is handed
 * to a node that opens files, so `..` in it is a way out of the folder.
 */
export const pictureFile = (body) => mediaFile(body, /\.(png|jpe?g|webp|bmp|gif)$/i);

/**
 * Tags kept per file, whether the file is a video or a still.
 *
 * A picture's entry is a list of one, which is what lets `verdictFromFrames`
 * judge both without knowing which it has: the strongest frame is the verdict,
 * and a still has one frame. The name says video because that is what it was
 * written for; it is used for both.
 */
export const createVideoTagCache = ({ file = null } = {}) => {
  let entries = {};
  if (file) {
    try { entries = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { entries = {}; }
  }
  let pending = null;
  const save = () => {
    if (!file || pending) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(entries));
      } catch (e) { /* a lost cache is a video tagged twice, not a failure */ }
    }, 500);
    pending.unref?.();
  };
  return {
    get: (key) => entries[key] || null,
    set(key, frames) {
      entries[key] = { frames, at: Date.now() };
      const keys = Object.keys(entries);
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => entries[a].at - entries[b].at)
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach(k => { delete entries[k]; });
      }
      save();
      return entries[key];
    },
  };
};
