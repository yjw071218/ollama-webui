/**
 * A prompt for MiniMax H3, as a timeline.
 *
 * H3 is a joint audio-video DiT: one prompt makes the picture *and* the sound,
 * at 24 fps, and it holds a clip together far better when the prompt says what
 * happens when -- `[0s-2s] …`, `[2s-5s] …` -- than when it is one paragraph
 * describing a still. So the model is taught the timeline format (the guide
 * below, sent only when the conversation is about video), and whatever it writes
 * is then made to agree with the clip actually being rendered: timecodes that
 * start at zero, run without gaps, and end exactly at the clip's length. A
 * prompt with no timecodes at all becomes one segment spanning the whole clip,
 * which is still the format and still true.
 *
 * Pure, so the arithmetic is tested rather than trusted.
 */

/* What H3 can make: about five seconds at the least, fifteen as a long clip,
   and the workflow refuses anything past twenty. */
export const VIDEO_SECONDS = { min: 5, max: 20, fallback: 5 };

const TIMECODE = /\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–~]\s*(\d+(?:\.\d+)?)\s*s?\s*\]/g;

/** The segments of a timeline prompt, in order; empty when there are no timecodes. */
export const timelineOf = (prompt) => {
  const text = String(prompt || '');
  const marks = [...text.matchAll(TIMECODE)];
  return marks.map((mark, i) => ({
    start: Number(mark[1]),
    end: Number(mark[2]),
    text: text.slice(mark.index + mark[0].length, marks[i + 1]?.index ?? text.length).trim(),
  })).filter(s => s.text);
};

/** How long the prompt says the clip is: where its last segment ends. */
export const durationFromTimeline = (prompt) => {
  const segments = timelineOf(prompt);
  if (!segments.length) return null;
  const end = Math.max(...segments.map(s => s.end));
  return Number.isFinite(end) && end > 0 ? end : null;
};

export const clampSeconds = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.round(n), VIDEO_SECONDS.min), VIDEO_SECONDS.max);
};

const seconds = (n) => `${Number.isInteger(n) ? n : Number(n.toFixed(1))}s`;

/**
 * The prompt, as a timeline covering exactly `duration` seconds.
 *
 * Segments are kept in the order written and joined end to start, so a gap or
 * an overlap the model left becomes a clean hand-off; the first starts at 0 and
 * the last ends at the clip's length. Segments that would start after the clip
 * has ended are dropped rather than squeezed into nothing.
 */
export const normalizeTimeline = (prompt, duration) => {
  const total = Number(duration) || VIDEO_SECONDS.fallback;
  const segments = timelineOf(prompt);
  if (!segments.length) {
    const body = String(prompt || '').trim();
    return body ? `[0s-${seconds(total)}] ${body}` : '';
  }
  const kept = segments.filter((s, i) => i === 0 || s.start < total);
  const lines = [];
  let from = 0;
  kept.forEach((segment, i) => {
    const last = i === kept.length - 1;
    let to = last ? total : Math.min(Math.max(segment.end, from + 0.5), total);
    if (!last && to >= total) to = Math.max(from + 0.5, total - 0.5 * (kept.length - 1 - i));
    lines.push(`[${seconds(from)}-${seconds(to)}] ${segment.text}`);
    from = to;
  });
  return lines.join('\n');
};

/**
 * The guide the model reads when a video is on the table -- condensed from the
 * H3 prompting guide. Long enough to teach the format, short enough to be worth
 * sending; it is left out of every turn that is not about video.
 */
export const H3_GUIDE = `Writing a video prompt (MiniMax H3 — one prompt makes the video and its stereo audio, 24 fps)
Write the prompt for generate_video as a timeline, in English, present tense:
  [0s-2s] What happens in this window.
  [2s-5s] What happens next.
Rules:
- Segments start at [0s-, run without gaps, and the last ends at the clip's length (set that length as duration).
- ~5s: 2-3 segments; ~8s: 3-4; ~10s: 4-5; ~15s: 5-8. Each segment 1-3 sentences.
- Describe motion, not a still: what moves and how, camera movement (pan, dolly, zoom, tracking, static) and shot type (wide, medium, close-up).
- Give setting and light, the subjects and where they are in frame, and the mood.
- Imply the sound through what is seen — waves crash, rain patters, a door clicks, a crowd cheers. No separate audio notes.
- Connect segments with "then", "as", "while", "gradually", "suddenly". Describe the scene directly; never "show me" or "create a video of".
- Missing details (setting, light, camera) are yours to choose; do not ask.
- Animating a picture they can see: set from="last_image" and describe what happens to what is in it.
Example (~5s):
  [0s-2s] A golden retriever puppy sleeps curled up on a sunlit wooden floor, dust motes floating in the morning light.
  [2s-5s] The puppy slowly wakes, stretches its front paws with a tiny squeaky yawn, then sits up and looks around, tail starting to wag.`;

/** Is this question about a video? Decides whether the guide is sent. */
export const asksForVideo = (text) =>
  /영상|동영상|비디오|애니메이션|움직이|움직여|무빙|클립|video|clip|animate|animation|movie|film|footage|motion/i.test(String(text || ''));
