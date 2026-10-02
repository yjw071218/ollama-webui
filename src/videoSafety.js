/**
 * Whether a finished video should be shown straight away.
 *
 * A picture is judged by what was asked for and by the classifier looking at
 * it (see safeguard.js). A video had only the first: the classifier reads a
 * still, and handed a film it failed and the prompt was all that was left. So
 * a clip whose prompt said "dances on a beach" was shown whatever it turned
 * into.
 *
 * Now the frames are looked at: the server has ComfyUI's tagger read about ten
 * of them (see `videoTagGraph` in server/imageOps.js), and each frame's tags
 * are judged the way a prompt's are -- the same lists, so `nude` in a frame
 * means what `nude` in a prompt means. The strongest frame is the video's
 * verdict: a clip that is explicit for one second of five is an explicit clip.
 */

import { promptSignal, strongest } from './safeguard.js';

/** The verdict of a video from its frames' tags: 'explicit', 'suggestive' or 'safe'. */
export const verdictFromFrames = (frames = []) =>
  (Array.isArray(frames) ? frames : []).reduce((verdict, tags) => strongest(verdict, promptSignal(tags)), null) || 'safe';

/** The tags that decided it, so the reason can be shown. */
export const decidingTags = (frames = [], verdict) => {
  if (!verdict || verdict === 'safe') return [];
  const found = new Set();
  for (const tags of frames || []) {
    for (const tag of String(tags || '').split(',')) {
      const name = tag.trim();
      if (name && promptSignal(name) === verdict) found.add(name);
    }
  }
  return [...found];
};

/**
 * Which file a video is, for the server: from a `/studio/view?…` URL, or from
 * what a chat kept. A chat video is a data URL with its name beside it; made
 * through `stampOutputs` it lives in `webui/`, which is what an older message
 * that did not keep its folder is assumed to mean.
 */
export const videoFileOf = ({ url = '', filename = '', subfolder, type } = {}) => {
  const text = String(url || '');
  if (text.startsWith('/studio/view?')) {
    const query = new URLSearchParams(text.slice('/studio/view?'.length));
    const name = query.get('filename');
    if (name) return { filename: name, subfolder: query.get('subfolder') || '', type: query.get('type') || 'output' };
  }
  if (!filename) return null;
  return { filename, subfolder: subfolder ?? 'webui', type: type || 'output' };
};

const keyOf = (file) => `${file.type}:${file.subfolder}/${file.filename}`;

/* One at a time. Opening the gallery on twenty old videos should not queue
   twenty tagging jobs in ComfyUI at once; each is answered in turn, and once
   answered it is kept, here and on the server. */
const known = new Map();
const MAX_KNOWN = 1000;
const waiting = [];
let busy = false;

const remember = (key, promise) => {
  known.delete(key);
  known.set(key, promise);
  while (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
};

const next = () => {
  if (busy || !waiting.length) return;
  busy = true;
  const { file, duration, resolve, reject } = waiting.shift();
  fetch('/studio/video-tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...file, ...(duration ? { duration } : {}) }),
  })
    .then(r => r.json())
    .then((data) => {
      if (!data?.success || !Array.isArray(data.frames)) throw new Error(data?.error || 'tagging failed');
      const verdict = verdictFromFrames(data.frames);
      resolve({ verdict, frames: data.frames, tags: decidingTags(data.frames, verdict) });
    })
    .catch(reject)
    .finally(() => { busy = false; next(); });
};

/** The frames' verdict for one video, asked once per visit. */
export const judgeVideo = (file, { duration } = {}) => {
  if (!file?.filename) return Promise.reject(new Error('no file'));
  const key = keyOf(file);
  if (!known.has(key)) {
    const asked = new Promise((resolve, reject) => { waiting.push({ file, duration, resolve, reject }); next(); });
    // A failure is not remembered: ComfyUI may simply not have been running.
    asked.catch(() => known.delete(key));
    remember(key, asked);
  }
  return known.get(key);
};
