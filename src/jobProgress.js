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
