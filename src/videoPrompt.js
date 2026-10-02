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

/* What H3 can make in one pass is five to fifteen seconds. Longer than that is
   rendered as segments joined at their keyframes -- see server/h3Motion.js --
   so the ceiling here is what anybody would sit through being rendered, not
   what the model can hold together. Two minutes, the Studio's own ceiling:
   the chat stopping at one was a second, lower limit nobody had chosen, and a
   "2분짜리 MV" came back as a minute. Ten minutes now: segments are rendered
   as separate prompts and joined on disk (server/longVideo.js), so length no
   longer costs RAM, only time. */
export const VIDEO_SECONDS = { min: 5, max: 600, fallback: 5 };

/* How long one rendered segment may be.
 *
 * The floor is the shortest clip H3 makes anything of; the ceiling is the top
 * of the range it was trained on. Anything longer than the ceiling is rendered
 * as several segments joined at their keyframes -- see server/h3Motion.js --
 * which is why this lives here rather than in the server: the browser needs it
 * to work out the picture size (a segment's cost, not the whole clip's) and the
 * server needs it to cut the timeline. */
export const SEGMENT_SECONDS = { min: 5, max: 15, fallback: 10 };

/** How a clip of `seconds` is cut into segments no longer than `most`. */
export const segmentPlan = (seconds, most = SEGMENT_SECONDS.fallback) => {
  const total = Math.max(1, Number(seconds) || 0);
  const cap = Math.min(Math.max(Number(most) || SEGMENT_SECONDS.fallback, SEGMENT_SECONDS.min), SEGMENT_SECONDS.max);
  const count = Math.max(1, Math.ceil(total / cap));
  /* Equal segments rather than "as many full ones as fit, plus a stub": they
     share one length node in the graph, and a two-second tail after four
     ten-second segments is a change of pace anybody can see at the join. */
  const each = total / count;
  return { count, seconds: Math.round(each * 100) / 100, total };
};

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

/* A length in what they wrote -- "10초", "1분", "15 seconds", "a 10-second
   clip" -- or asking for a long one outright. */
const NAMED_LENGTH = /\d+(?:\.\d+)?\s*-?\s*(?:초|분|s(?:ec(?:ond)?s?)?\b|min(?:ute)?s?\b)|길게|더\s*긴|긴\s*(?:영상|동영상|비디오|클립)|오래|longer|long\s+(?:video|clip|one)/i;

/**
 * Did they ask for a length? Decides whether the model's `duration` is used.
 *
 * A model left to choose writes an eight-second timeline for "영상으로 만들어줘"
 * as readily as a five-second one, and each extra second is more GPU. So a clip
 * nobody gave a length is five seconds, whatever the model set.
 */
export const namesLength = (text) => NAMED_LENGTH.test(String(text || ''));

/* The least a long clip is drawn at: below about 512×512 H3's faces fall apart. */
const MIN_LONG_AREA = 512 * 512;

/**
 * The picture area for a clip of `duration` seconds.
 *
 * H3 holds every frame at once, so a clip costs about frames × pixels. Up to
 * five seconds the area is left as it is; past that it shrinks in proportion,
 * so a ten-second clip costs about what five seconds does at the full size --
 * half the pixels, 1088×1088 becoming about 768×768. Never below 512×512, and
 * never larger than it was.
 */
export const videoArea = (area, duration) => {
  const seconds = Number(duration) || VIDEO_SECONDS.fallback;
  if (seconds <= VIDEO_SECONDS.fallback) return area;
  return Math.max(Math.round(area * VIDEO_SECONDS.fallback / seconds), Math.min(area, MIN_LONG_AREA));
};

/* ------------------------------------------------- and it has to fit in RAM

   The card is not the only thing a long clip fills. Segments are decoded one
   after another and held until they are joined, so the *whole* clip sits in
   system memory as frames -- and `ImageBatch` then makes a second copy of all
   of it to join them.

   ComfyUI's IMAGE tensors are float32 RGB: twelve bytes per pixel per frame,
   times two for the copy. A minute at 24fps is 1,440 frames, which at
   1088x1088 is 40GB. There is no error for that on a machine with 62GB of RAM
   already over-committed -- there is a computer that stops responding for ten
   minutes while it pages, which is what was actually happening. */
const BYTES_PER_PIXEL_PER_FRAME = 12;   // float32 RGB
const WHILE_JOINING = 2;                // the pile, and the joined copy of it

/** What a clip of this many seconds at this area will hold in RAM, in bytes. */
export const frameMemory = (area, totalSeconds, fps = 24) =>
  Math.round(area * BYTES_PER_PIXEL_PER_FRAME * WHILE_JOINING * fps * (Number(totalSeconds) || 0));

/**
 * The largest area a clip of this length may be drawn at and still fit.
 *
 * Eight gigabytes is the budget: enough that a minute of video is drawn at
 * about 500x500 rather than refused, and little enough that it is *spare* room
 * on a machine of this size rather than the last of it.
 */
export const frameBudgetArea = (totalSeconds, { budgetBytes = 8e9, fps = 24 } = {}) => {
  const frames = Math.max(1, Math.round(fps * (Number(totalSeconds) || 0)));
  return Math.max(MIN_LONG_AREA / 4, Math.floor(budgetBytes / (frames * BYTES_PER_PIXEL_PER_FRAME * WHILE_JOINING)));
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
- Segments start at [0s-, run without gaps, and the last ends at the clip's length.
- The clip is 5s. Only when they name a length ("10초", "15 seconds", "1분", "2분") set it as duration and write the timeline to it.
- Any length up to 600s (10 minutes) is ONE call to generate_video. Past 15s the app itself cuts the timeline into segments, renders them one after another and joins them at their keyframes into a single finished video -- the hybrid keyframe node does this; you do not. So never tell them you can only make 15 seconds, never split a long request into several calls, and never ask them to join clips themselves. For a music video, write the whole timeline: intro, build-up, chorus, outro, cut to cut. Every segment is drawn at the same resolution however long the clip is; it takes a few minutes per 10 seconds, so say that in one short sentence at most, then make it.
- A music video (MV, 뮤비, "노래에 맞춘 영상"): first call generate_music with the song's style and lyrics. When it is done, call generate_video with soundtrack="last_song" cut="true" captions="lyrics" and from="last_image" when there is a character picture. Leave duration out -- it becomes the song's length -- and write the whole timeline as a sequence of shots, one every ~10 seconds, each a different scene or framing of the same character, following the song: intro, verse, chorus, bridge, final chorus, outro. Anime MV style: quick camera moves, close-ups on the chorus, a wide establishing shot to open and close.
- cut="true" (without a song too) makes every ~10 seconds its own shot, cross-faded; leave it out for one continuous take. transition="none" is a hard cut.
- Captions: captions="lyrics" shows the song's lyrics. For other words on screen, add a line "CAPTIONS:" after the timeline and then timed lines like "[3s-6s] 첫 번째 대사".
- upscale="true" doubles the resolution; only when they ask for high quality or 고화질.
- loop="true" makes a clip that ends on the frame it started on, so it plays round and round without a seam — a Live2D-style idle. It needs a picture to pin to, so use it with from="last_image" (or a picture they have just attached), and write a timeline that comes back to where it began: the pose at the end should be the pose at the start.
- ~5s: 2-3 segments; ~8s: 3-4; ~10s: 4-5; ~15s: 5-8; longer, keep going at that rate. Each segment 1-3 sentences.
- Describe motion, not a still: what moves and how, camera movement (pan, dolly, zoom, tracking, static) and shot type (wide, medium, close-up).
- Give setting and light, the subjects and where they are in frame, and the mood.
- Imply the sound through what is seen — waves crash, rain patters, a door clicks, a crowd cheers. No separate audio notes.
- Connect segments with "then", "as", "while", "gradually", "suddenly". Describe the scene directly; never "show me" or "create a video of".
- Missing details (setting, light, camera) are yours to choose; do not ask.
- Animating a picture they can see: set from="last_image" and describe what happens to what is in it.
Example (~5s):
  [0s-2s] A golden retriever puppy sleeps curled up on a sunlit wooden floor, dust motes floating in the morning light.
  [2s-5s] The puppy slowly wakes, stretches its front paws with a tiny squeaky yawn, then sits up and looks around, tail starting to wag.`;

/**
 * One timeline, cut into the segments a long clip is actually rendered as.
 *
 * A minute of video is six ten-second clips joined at their keyframes (see
 * server/h3Motion.js), and each of those is conditioned by its own prompt. Two
 * things have to be true of that prompt or the segment ignores half of it:
 *
 * - It starts at 0s. The model is told what happens in *this* clip, and a
 *   segment whose timeline reads `[40s-50s]` is being handed timecodes past the
 *   end of everything it is going to draw.
 * - It carries whatever was happening across the boundary. A window that begins
 *   in the middle of `[8s-14s] she turns towards the window` keeps that line,
 *   trimmed to the part inside it -- otherwise the turn simply stops at the
 *   join, which is exactly where a join must not be visible.
 *
 * Returns one prompt per segment, always `count` of them.
 */
export const segmentPrompts = (prompt, count, seconds) => {
  const total = Math.max(1, Number(count) || 1);
  const span = Number(seconds) || VIDEO_SECONDS.fallback;
  const body = String(prompt || '').trim();
  if (total === 1) return [body];

  const segments = timelineOf(body);
  // No timecodes to cut: every segment is asked for the same thing, which is
  // the honest reading of a prompt that never said when anything happens.
  if (!segments.length) return Array.from({ length: total }, () => body);

  return Array.from({ length: total }, (_, i) => {
    const from = i * span;
    const to = (i + 1) * span;
    const inside = segments
      // Overlapping, not contained: the line that spans the boundary belongs to
      // both sides of it.
      .filter(s => s.end > from + 1e-6 && s.start < to - 1e-6)
      .map(s => ({
        start: Math.max(0, s.start - from),
        end: Math.min(span, s.end - from),
        text: s.text,
      }));
    if (!inside.length) return body;
    return inside
      .map((s, n) => `[${seconds2(n === 0 ? 0 : s.start)}-${seconds2(n === inside.length - 1 ? span : s.end)}] ${s.text}`)
      .join('\n');
  });
};

const seconds2 = (value) => `${Math.round(value * 10) / 10}s`;

/** Is this question about a video? Decides whether the guide is sent. */
export const asksForVideo = (text) =>
  /영상|동영상|비디오|애니메이션|움직이|움직여|무빙|클립|뮤비|엠브이|video|clip|animate|animation|movie|film|footage|motion/i.test(String(text || ''))
  // "2분 짜리 MV를 만들어줘" named no word above, so the model never saw the
  // video guide and told them, from its own guess, that 15 seconds was the most.
  || /(?:^|[^a-z])(?:mv|pv|amv)(?![a-z])/i.test(String(text || ''));

/**
 * A segment length that lands on the beat.
 *
 * A cut that falls between two beats of the song reads as a mistake. Whole
 * bars of 4/4, as close to ten seconds as H3's five to fifteen allows; null
 * when there is no tempo to go by.
 */
export const segmentSecondsForTempo = (bpm, { min = 5, max = 15, aim = 10 } = {}) => {
  const tempo = Number(bpm);
  if (!Number.isFinite(tempo) || tempo < 30 || tempo > 300) return null;
  const bar = 240 / tempo;
  let best = null;
  for (let bars = 1; bars * bar <= max + 1e-9; bars += 1) {
    const seconds = bars * bar;
    if (seconds < min - 1e-9) continue;
    if (best === null || Math.abs(seconds - aim) < Math.abs(best - aim)) best = seconds;
  }
  return best === null ? null : Math.round(best * 1000) / 1000;
};

/** `[0s-3s] text` lines, as captions. Anything that is not one is ignored. */
export const parseCaptionLines = (text) => String(text || '')
  .split(/\r?\n/)
  .map(line => /^\s*\[\s*(\d+(?:\.\d+)?)\s*s?\s*[-–~]\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*(.+)$/.exec(line))
  .filter(Boolean)
  .map(m => ({ start: Number(m[1]), end: Number(m[2]), text: m[3].trim() }))
  .filter(c => c.end > c.start && c.text);

/**
 * A video prompt and the captions written under it.
 *
 * The model writes the shots as a timeline and, for a music video, the words
 * on screen after a line that says `CAPTIONS:` -- the same `[0s-3s] text` form.
 * They are separated before the timeline is made to fit the clip, or the
 * lyrics would be drawn as shots.
 */
export const splitCaptions = (prompt) => {
  const text = String(prompt || '');
  const at = text.search(/^\s*CAPTIONS?\s*:\s*$/im);
  if (at < 0) return { timeline: text.trim(), captions: [] };
  return {
    timeline: text.slice(0, at).trim(),
    captions: parseCaptionLines(text.slice(at).replace(/^\s*CAPTIONS?\s*:\s*$/im, '')),
  };
};
