/**
 * What is actually in a finished picture, according to the tagger.
 *
 * The safeguard had two witnesses for a still and both of them can miss.
 *
 * The prompt knows what was *asked for*, which is not what arrived: "1girl,
 * beach, sitting" is an unremarkable request and the picture it produced is
 * whatever the model produced. And the classifier (nsfwClassifier.js) is a
 * 224-pixel MobileNet trained on photographs; handed a drawing it is guessing,
 * and on illustration -- which is most of what this install makes -- it guesses
 * wrong often enough that a picture nobody asked to be explicit could be
 * explicit and shown. That is the whole failure the safeguard exists for.
 *
 * The tagger is not guessing. WD14 was trained on precisely the vocabulary
 * these prompts are written in, so `nude` from the tagger means what `nude` in
 * a prompt means, and the lists in safeguard.js judge both without knowing
 * which they have. A video has been judged this way for a while (see
 * videoSafety.js); this is the same thing for a still, and deliberately the
 * same code underneath -- a picture's tags are a list of one, which is what
 * lets `verdictFromFrames` read both.
 *
 * ## It strengthens, it never weakens
 *
 * The tagger's answer is combined with the other two by `strongest`, never in
 * place of them. A tagger that is absent, slow, or wrong in the lenient
 * direction cannot uncover anything: the worst it can do is leave the picture
 * judged exactly as it was before this file existed.
 *
 * ## And it costs a round trip, so it is asked once
 *
 * Tagging runs in ComfyUI, queued behind whatever else is running. So it is
 * asked one picture at a time, the answer is kept here for the session and on
 * the server for ever (`picture-tags.json`), and a job that already carries a
 * verdict is never asked at all.
 */

import { promptSignal, strongest } from './safeguard.js';
import { verdictFromFrames, decidingTags } from './videoSafety.js';

export { verdictFromFrames, decidingTags };

/**
 * Which file a picture is, for the server.
 *
 * From a `/studio/view?…` address where there is one, and otherwise from the
 * name the picture kept: everything these workflows save goes under `webui/`
 * (see `stampOutputs`), so a name on its own is enough to find it. A picture
 * with neither -- one the reader attached from their own camera roll -- has no
 * copy in ComfyUI's folders and cannot be tagged; null says so.
 */
export const pictureFileOf = ({ url = '', filename = '', subfolder, type } = {}) => {
  const text = String(url || '');
  if (text.startsWith('/studio/view?')) {
    const query = new URLSearchParams(text.slice('/studio/view?'.length));
    const name = query.get('filename');
    if (name) return { filename: name, subfolder: query.get('subfolder') || '', type: query.get('type') || 'output' };
  }
  const name = String(filename || '');
  if (!name || /[\\/]/.test(name)) return null;
  if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(name)) return null;
  return { filename: name, subfolder: subfolder ?? 'webui', type: type || 'output' };
};

const keyOf = (file) => `${file.type}:${file.subfolder}/${file.filename}`;

/* One at a time. Opening a gallery of sixty pictures should not put sixty
   tagging jobs into ComfyUI's queue ahead of whatever is being generated;
   each is answered in turn, and once answered it is kept. */
const known = new Map();
const MAX_KNOWN = 1000;
const waiting = [];
let busy = false;

const next = () => {
  if (busy || !waiting.length) return;
  busy = true;
  const { file, resolve, reject } = waiting.shift();
  fetch('/studio/picture-tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
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

/** What the tagger makes of one picture, asked once per visit. */
export const judgePicture = (file) => {
  if (!file?.filename) return Promise.reject(new Error('no file'));
  const key = keyOf(file);
  if (!known.has(key)) {
    const asked = new Promise((resolve, reject) => { waiting.push({ file, resolve, reject }); next(); });
    // A failure is not remembered: ComfyUI may simply not have been running.
    asked.catch(() => known.delete(key));
    known.set(key, asked);
    while (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
  }
  return known.get(key);
};
