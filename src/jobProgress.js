/**
 * The arithmetic behind a progress bar.
 *
 * Split from the component that draws it because all four of these are pure,
 * all four have a wrong answer that is silent, and a function that can only be
 * exercised by rendering React against a running ComfyUI is one that never gets
 * exercised.
 */

/**
 * The half-denoised frame, as an URL that changes only when the frame does.
 *
 * The sequence number is the whole point. The bytes behind a given job id
 * change several times a second; without something in the URL to say which
 * frame is meant, the browser serves the first one from cache for the rest of
 * the generation — a preview that appears once and then freezes, which looks
 * exactly like the job hanging.
 */
export const previewUrl = (id, seq) =>
  (!id || !seq ? null : `/studio/preview?id=${encodeURIComponent(id)}&seq=${seq}`);

/**
 * Whether the latest frame is a clip rather than a still.
 *
 * MiniMax's preview node sends the whole video as it stands at each step --
 * an MP4 -- and an <img> given one shows a broken-image icon. An animated WebP
 * is also the whole clip, but an <img> plays that on its own, so only a real
 * video type needs the other element.
 */
export const isClip = (mime) => /^video\//i.test(String(mime || ''));

/**
 * The shape to hold for a frame that may not have arrived yet.
 *
 * Measured beats asked-for beats a default, and the result is kept inside
 * what fits in a conversation: a 1:4 strip would be a card taller than the
 * screen, and a 4:1 one a letterbox slot. Reserving the right shape before the
 * first frame is what stops the chat jumping when it lands.
 */
export const frameRatio = (measured, asked, video = false) => {
  const pick = [measured, asked].map(Number).find(n => Number.isFinite(n) && n > 0);
  const ratio = pick || (video ? 16 / 9 : 1);
  return Math.min(Math.max(ratio, 0.5), 2.2);
};

/** Width over height, from `{ width, height }` or a `"WxH"` string; null when neither. */
export const sizeRatio = (size) => {
  const [width, height] = typeof size === 'string'
    ? size.split('x').map(Number)
    : [Number(size?.width), Number(size?.height)];
  return width > 0 && height > 0 ? width / height : null;
};

/**
 * One line of what is being made, for the card's header.
 *
 * A video prompt is a timeline -- `[0s-3s] …` on line after line -- and a
 * picture prompt can be a paragraph. What the header wants is enough to tell
 * this job from the last one, so: whitespace collapsed, timeline markers
 * dropped, and cut at a word near `limit`.
 */
export const promptExcerpt = (prompt, limit = 140) => {
  const flat = String(prompt || '')
    // The same timecodes src/videoPrompt.js reads.
    .replace(/\[\s*\d+(?:\.\d+)?\s*s?\s*[-–~]\s*\d+(?:\.\d+)?\s*s?\s*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
};

/** `m:ss`, which is the only unit a generation is ever measured in. */
export const formatDuration = (ms) => {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * How fast the sampler is going, the way ComfyUI's own console says it:
 * seconds per step when a step takes a second or more, steps per second when
 * it takes less. '' with nothing measured yet.
 *
 * The one number that tells "slow because it is a big picture" from "slow
 * because the model has spilled out of VRAM" -- the second is several times
 * the first, and nothing else on the card changes when it happens.
 */
export const formatSpeed = (stepMs) => {
  const ms = Number(stepMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s/it`;
  return `${(1000 / ms).toFixed(1)}it/s`;
};

/**
 * How much longer, from how long it has taken to get this far.
 *
 * Deliberately refuses to answer early. In the first seconds the fraction is
 * tiny and noisy, and dividing by it produces "about 40 minutes remaining" for
 * a job that takes ninety seconds — a number that is worse than no number,
 * because a reader who sees it cancels. So: nothing until there is enough of
 * both elapsed time and progress for the arithmetic to mean anything.
 */
export const remainingMs = (fraction, elapsedMs) => {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  if (fraction <= 0.04 || fraction >= 1) return null;
  if (!(elapsedMs > 4000)) return null;
  return Math.max(0, (elapsedMs / fraction) - elapsedMs);
};

/**
 * Time left by the server's reckoning, counted down since it was said.
 *
 * The server places a run against earlier runs of the same workflow (see
 * server/studioTimings.js) and says how long it has left as of that message.
 * Messages come when something changes, so between them the figure is aged
 * here rather than left standing. Null when the server had nothing to go on,
 * and the caller falls back to `remainingMs`.
 */
export const learnedRemaining = (snapshot, receivedAt, now = Date.now()) => {
  if (!snapshot?.learned || !Number.isFinite(snapshot.remainingMs)) return null;
  const since = Number.isFinite(receivedAt) ? Math.max(0, now - receivedAt) : 0;
  return Math.max(0, snapshot.remainingMs - since);
};

/* What a failure was, from the words ComfyUI used. Checked in order: the first
   that matches names it. */
const FAILURES = [
  ['stopped', /^stopped$|interrupt/i],
  ['memory', /out of memory|OutOfMemory|CUDA error: out of memory|Allocation on device|not enough memory/i],
  // A module half on the card and half not: a model that did not fit, run by
  // a node that cannot cope with that.
  ['offloaded', /Input type \(CUDA[\w]*\) and weight type \(CPU|weight type \(CPU\w*\)|Expected all tensors to be on the same device|found at least two devices/i],
  ['missing', /No such file|not found|does not exist|Value not in list|could not find|FileNotFoundError/i],
];

/**
 * A failure, said in words a person can act on.
 *
 * What ComfyUI reports is the exception from inside a node -- "AnimaPiDDecode:
 * Input type (CUDABFloat16Type) and weight type (CPUBFloat16Type) should be the
 * same" -- which is exact and means nothing to anyone who did not write the
 * node. The common ones have a cause worth naming and something to do about
 * it; the rest say which node it was. The original is kept as `raw`, for the
 * details, because an explanation that replaced it would hide the one thing
 * worth pasting into a bug report.
 */
export const explainFailure = (error) => {
  const raw = String(error || '').trim();
  const colon = raw.indexOf(': ');
  const node = colon > 0 && colon < 60 && !/\s/.test(raw.slice(0, colon)) ? raw.slice(0, colon) : '';
  const found = FAILURES.find(([, pattern]) => pattern.test(raw));
  return { kind: found ? found[0] : 'generic', node, raw: raw === 'stopped' ? '' : raw };
};

/* Two gigabytes: past ComfyUI's own 0.7GB reserve by more than anyone would
   choose, and short of what a model needs. */
const RESERVE_WARN = 2 * 1024 ** 3;

/**
 * What is worth saying about memory while a job runs, from `/studio/loaded`.
 *
 * `offloaded` is the largest model ComfyUI holds, when less than nine tenths of
 * it is on the card -- the rest running from system RAM, which is why a job is
 * slow. `reserved` is ComfyUI holding back far more than its own figure for
 * other programs, the state that made every picture fail for an hour. Null
 * when there is nothing to say.
 */
export const memoryNote = (loaded) => {
  const models = (loaded?.models || []).filter(m => Number(m?.size) > 0 && !m.approximate);
  const largest = models.sort((a, b) => b.size - a.size)[0];
  const share = largest ? Math.min(1, (Number(largest.size_vram) || 0) / largest.size) : 1;
  const offloaded = largest && share < 0.9
    ? { name: largest.name, onGpu: Number(largest.size_vram) || 0, size: largest.size, share }
    : null;
  const reserved = Number(loaded?.reserved) > RESERVE_WARN ? Number(loaded.reserved) : null;
  return offloaded || reserved ? { offloaded, reserved } : null;
};

/**
 * What to call what it is doing.
 *
 * The phase comes from the server, which reads it off the class name of the
 * node ComfyUI says is running. A phase with no translation falls back to the
 * generic one rather than showing a bare key — a newly installed node pack
 * should not be able to put `studio.phase.frobnicating` on somebody's screen.
 */
export const phaseLabel = (phase, t) => {
  const key = `studio.phase.${phase || 'working'}`;
  const text = t(key);
  return text === key ? t('studio.phase.working') : text;
};
