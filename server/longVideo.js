/**
 * A long clip as separate ComfyUI jobs, joined on disk.
 *
 * ## Why not one graph
 *
 * A long MiniMax H3 clip used to be one prompt: every segment chained inside a
 * single graph (see `applyH3Chain` in server/h3Motion.js), joined with
 * `ImageBatch`. That holds every decoded frame of every segment in system RAM
 * until the join -- and the join copies them all again. Twelve bytes a pixel a
 * frame, twice: a minute at 1088x1088 is forty gigabytes. So a long clip was
 * shrunk until it fit, and two minutes came out at 340x340.
 *
 * ## What happens instead
 *
 * Each segment is its own prompt. ComfyUI writes it to a file and lets go of its
 * frames; this reads the file, takes its last frame, hands that picture back to
 * ComfyUI as the next segment's opening keyframe, and queues the next one. When
 * the last segment is written, ffmpeg joins the files -- streaming, off disk.
 * RAM holds one segment, so a segment of a ten-minute clip is drawn at the size
 * a ten-second clip is.
 *
 * ## What else a clip can be
 *
 * - **Cut** rather than continuous: no segment is pinned to the one before --
 *   each is its own shot, still carrying the reference picture for who is in it
 *   -- and the join cross-fades between them. What a music video is.
 * - **Set to a song**: the sound H3 wrote is replaced by a track this app made
 *   (server/music.js), padded or cut to the picture.
 * - **Captioned**: timed lines burnt in as styled subtitles -- given, or the
 *   song's own lyrics spread over the clip.
 *
 * ## What survives
 *
 * The job's state is written to `<id>.state.json` at every step, with the
 * segment template and the prompts, so a server restart resumes it at the
 * segment it was on (see `resume`). The segment files stay in `<id>.parts`, so
 * one segment can be drawn again and the clip re-joined (see `redo`), and the
 * storyboard of segments not yet started can be rewritten while earlier ones
 * render (see `setPrompt`).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
// Shared with the browser, which sizes a clip by its segments and reads captions out of a prompt.
import { segmentSecondsForTempo, parseCaptionLines } from '../src/videoPrompt.js';
export { segmentSecondsForTempo, parseCaptionLines };

/** Names this module writes, and the only names `/studio/view` will serve from it. */
export const LONG_FILE = /^(long-[a-z0-9]{6,32})(?:-v(\d{1,3}))?\.mp4$/;
export const isLongId = (id) => /^long-[a-z0-9]{6,32}$/.test(String(id || ''));
const outputName = (id, version) => (version > 1 ? `${id}-v${version}.mp4` : `${id}.mp4`);

/** The seconds of a cross-fade between two cuts. Long enough to read as a transition, short enough not to smear a shot. */
export const FADE_SECONDS = 0.5;

/**
 * Lyrics as timed caption lines.
 *
 * ACE-Step's lyrics are sections -- `[verse]`, `[chorus]` -- and lines, with no
 * times. Without timings the honest thing is an even spread over the part of
 * the song that is usually sung: from a short intro to just before the end.
 * It will not land on every syllable; it keeps each line on screen while
 * roughly that line is being sung, which is what a lyric caption is for.
 */
export const lyricsToCaptions = (lyrics, duration, { introShare = 0.08, outroShare = 0.05 } = {}) => {
  const total = Number(duration) || 0;
  const lines = String(lyrics || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^\[[^\]]*\]$/.test(line) && line !== '[instrumental]');
  if (!total || !lines.length) return [];
  const start = total * introShare;
  const span = total * (1 - introShare - outroShare);
  const each = span / lines.length;
  return lines.map((text, i) => ({
    start: Math.round((start + i * each) * 100) / 100,
    end: Math.round((start + (i + 1) * each - 0.1) * 100) / 100,
    text,
  }));
};

const assTime = (seconds) => {
  const cs = Math.max(0, Math.round(Number(seconds) * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/**
 * Captions as an ASS subtitle file, styled the way an anime MV sets its lyrics.
 *
 * Bold, white, a thick dark outline so it reads over any shot, near the bottom,
 * each line fading in with a small pop and fading out. Sized to the picture, so
 * a 768 square and a 1536 upscale carry the same proportion of text. Malgun
 * Gothic, because it is on every Windows machine and has Hangul, kana and Latin.
 */
export const captionsAss = (captions, { width = 1088, height = 1088, font = 'Malgun Gothic' } = {}) => {
  const size = Math.max(18, Math.round(Math.min(width, height) * 0.058));
  const outline = Math.max(2, Math.round(size / 11));
  const escape = (text) => String(text).replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
  const events = (captions || [])
    .filter(c => Number(c.end) > Number(c.start) && String(c.text || '').trim())
    .map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Lyric,,0,0,0,,`
      + `{\\fad(180,220)\\t(0,160,\\fscx112\\fscy112)\\t(160,320,\\fscx100\\fscy100)}${escape(c.text)}`);
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Lyric,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00301828,&H80000000,-1,0,0,0,100,100,1,0,1,${outline},${Math.round(outline / 2)},2,${Math.round(width * 0.05)},${Math.round(width * 0.05)},${Math.round(height * 0.07)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
};

/**
 * The ffmpeg arguments that join the segments into one file.
 *
 * Continuous (the default): each later segment opens on a repeat of the frame
 * before it, so half a frame's time is trimmed from its picture -- half, because
 * the next frame's stored timestamp is rounded down about half the time -- and
 * exactly one frame's time from its sound. A loop trims the first segment's
 * opening frame too.
 *
 * Cut: nothing repeats, so nothing is trimmed; with `transition: 'fade'` each
 * pair cross-fades over FADE_SECONDS, which needs every segment's length to
 * place the fade (`durations`).
 */
export const joinArgs = ({
  inputs, output, fps = 24, hasAudio = true, loop = false, crf = 17,
  cut = false, transition = 'none', durations = [],
}) => {
  const frame = 1 / (Number(fps) > 0 ? Number(fps) : 24);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const file of inputs) args.push('-i', file);
  const filters = [];
  const fading = cut && transition === 'fade' && inputs.length > 1
    && durations.length === inputs.length && durations.every(d => Number(d) > FADE_SECONDS * 2);

  if (fading) {
    const rate = Number(fps) > 0 ? Number(fps) : 24;
    inputs.forEach((_, i) => {
      filters.push(`[${i}:v]settb=AVTB,fps=${rate},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
      if (hasAudio) filters.push(`[${i}:a]aresample=async=1,asetpts=PTS-STARTPTS[a${i}]`);
    });
    let video = 'v0';
    let audio = 'a0';
    let offset = 0;
    for (let i = 1; i < inputs.length; i += 1) {
      offset += Number(durations[i - 1]) - FADE_SECONDS;
      const nextVideo = i === inputs.length - 1 ? 'v' : `vx${i}`;
      filters.push(`[${video}][v${i}]xfade=transition=fade:duration=${FADE_SECONDS}:offset=${offset.toFixed(3)}[${nextVideo}]`);
      video = nextVideo;
      if (hasAudio) {
        const nextAudio = i === inputs.length - 1 ? 'a' : `ax${i}`;
        filters.push(`[${audio}][a${i}]acrossfade=d=${FADE_SECONDS}[${nextAudio}]`);
        audio = nextAudio;
      }
    }
  } else {
    const labels = [];
    inputs.forEach((_, i) => {
      const cutPicture = !cut && (i > 0 || loop) ? frame / 2 : 0;
      filters.push(`[${i}:v]trim=start=${cutPicture.toFixed(6)},setpts=PTS-STARTPTS[v${i}]`);
      if (hasAudio) {
        const cutSound = !cut && i > 0 ? frame : 0;
        filters.push(`[${i}:a]atrim=start=${cutSound.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
      }
      labels.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`);
    });
    filters.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output);
  return args;
};

/**
 * The finishing pass: a song in place of H3's sound, captions burnt in, or both.
 *
 * The song is padded with silence or cut to the picture, never the other way
 * round -- the picture is what took an hour. Captions are a filename relative
 * to the working folder, because ffmpeg's filter syntax and a Windows path
 * (`C:\…`) disagree about what a colon means.
 */
export const finishArgs = ({ input, output, soundtrack = '', captionsFile = '', duration = 0, crf = 17 }) => {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (soundtrack) args.push('-i', soundtrack);
  if (captionsFile) args.push('-vf', `subtitles=${captionsFile}`);
  args.push('-map', '0:v');
  if (soundtrack) args.push('-map', '1:a', '-af', 'apad');
  else args.push('-map', '0:a?');
  args.push(...(captionsFile ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']));
  args.push('-c:a', 'aac', '-b:a', '192k');
  if (Number(duration) > 0) args.push('-t', Number(duration).toFixed(3));
  args.push('-movflags', '+faststart', output);
  return args;
};

/** The ffmpeg arguments that write a clip's last frame as a PNG. `-update` keeps overwriting it, so the last one written stays. */
export const lastFrameArgs = (input, output) =>
  ['-y', '-hide_banner', '-loglevel', 'error', '-sseof', '-1', '-i', input, '-an', '-update', '1', output];

const runTool = (run, command, args, timeout, cwd) => new Promise((resolve, reject) => {
  run(command, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(cwd ? { cwd } : {}) }, (error, stdout, stderr) => {
    if (error) {
      const detail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' ');
      reject(new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : `: ${error.message}`}`));
    } else resolve(String(stdout || ''));
  });
});

/* The job as written to disk. Everything `drive` needs to carry on after a
   restart, and nothing that only this process can hold. */
const PERSISTED = [
  'id', 'owner', 'chat', 'count', 'segment', 'state', 'phase', 'current', 'files', 'parts', 'firstFrame',
  'startedAt', 'finishedAt', 'error', 'version', 'redo', 'spec', 'segmentStates',
];

/**
 * The runner. One per data folder -- see `longVideosFor`.
 *
 * `bind` gives it the three things only the Studio routes have: how to build a
 * segment's graph, how to queue one, and how to read a finished prompt's files.
 * Until then nothing runs, and `resume` waits for it.
 */
export const createLongVideos = ({
  base,
  dir,
  withTimeout,
  fetchImpl = fetch,
  run = execFile,
  ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe = process.env.FFPROBE_PATH || 'ffprobe',
  pollMs = 3000,
  silentMs = 300000,
  log = console,
} = {}) => {
  const jobs = new Map();
  let handlers = null;
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const stateFile = (id) => path.join(dir, `${id}.state.json`);
  const partsDir = (id) => path.join(dir, `${id}.parts`);

  const save = (job) => {
    const record = Object.fromEntries(PERSISTED.map(key => [key, job[key]]));
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${stateFile(job.id)}.tmp`, JSON.stringify(record));
      fs.renameSync(`${stateFile(job.id)}.tmp`, stateFile(job.id));
    } catch (e) { log.warn?.(`[long-video] could not save ${job.id}: ${e.message}`); }
  };

  const load = (id) => {
    if (jobs.has(id)) return jobs.get(id);
    if (!isLongId(id)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(stateFile(id), 'utf8'));
      return record?.id === id ? record : null;
    } catch { return null; }
  };

  /** A segment's prompt, waited for. Resolves with its history entry; throws with ComfyUI's own error. */
  const waitFor = async (job, promptId) => {
    let missing = 0;
    let silent = 0;
    for (;;) {
      if (job.cancelled) throw new Error('stopped');
      await sleep(pollMs);
      const history = await withTimeout(`${base}/history/${encodeURIComponent(promptId)}`, { timeout: 15000 }).catch(() => null);
      const entry = history?.[promptId];
      if (entry) {
        const status = entry.status || {};
        if (status.completed === false || status.status_str === 'error') {
          const message = (status.messages || [])
            .filter(m => m?.[0] === 'execution_error')
            .map(m => m?.[1]?.exception_message)
            .filter(Boolean)[0];
          throw new Error(message || `segment ${job.segment + 1} failed in ComfyUI`);
        }
        if (status.completed || Object.keys(entry.outputs || {}).length) return entry;
        continue;
      }
      const queue = await withTimeout(`${base}/queue`, { timeout: 15000 }).catch(() => null);
      if (!queue) {
        // Not answering at all. A restart is worth sitting through -- once it is back the
        // prompt is in neither the queue nor the history, and the `vanished` arm below
        // queues the segment again -- but a process that died for good must not leave the
        // clip running forever. ComfyUI dies this way: a VRAM allocation it cannot make
        // takes the whole process down mid-sample, so nothing ever reports the failure.
        if ((silent += 1) > Math.ceil(silentMs / Math.max(pollMs, 1))) {
          throw new Error(`ComfyUI stopped answering while segment ${job.segment + 1} was being made`);
        }
        continue;
      }
      silent = 0;
      const ids = [...(queue.queue_running || []), ...(queue.queue_pending || [])].map(item => item?.[1]);
      if (ids.includes(promptId)) { missing = 0; continue; }
      // Neither queued nor in the history, for a minute: ComfyUI restarted, or it was cleared.
      if ((missing += 1) > Math.ceil(60000 / Math.max(pollMs, 1))) {
        throw Object.assign(new Error(`segment ${job.segment + 1} disappeared from ComfyUI's queue`), { vanished: true });
      }
    }
  };

  const download = async (item, file) => {
    const query = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' });
    const res = await fetchImpl(`${base}/view?${query}`);
    if (!res.ok || !res.body) throw new Error(`ComfyUI HTTP ${res.status} reading ${item.filename}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  };

  const upload = async (file, name) => {
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), name);
    form.append('subfolder', 'webui-long');
    form.append('overwrite', 'true');
    const res = await fetchImpl(`${base}/upload/image`, { method: 'POST', body: form });
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data?.name) throw new Error(`ComfyUI would not take the keyframe (HTTP ${res.status})`);
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  };

  const probe = async (file, entries, stream = '') => runTool(run, ffprobe,
    ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'csv=p=0', file], 30000)
    .catch(() => '');
  const hasAudio = async (file) => (await probe(file, 'stream=index', 'a')).trim().length > 0;
  const durationOf = async (file) => Number((await probe(file, 'format=duration')).trim()) || 0;

  /** The segment files, joined, finished, and written as this version's output. */
  const assemble = async (job) => {
    const spec = job.spec;
    const work = partsDir(job.id);
    const parts = job.parts.map(name => path.join(work, name));
    job.phase = 'joining';
    save(job);
    const audio = (await Promise.all(parts.map(hasAudio))).every(Boolean);
    const durations = spec.cut ? await Promise.all(parts.map(durationOf)) : [];
    const joined = path.join(work, 'joined.mp4');
    await runTool(run, ffmpeg, joinArgs({
      inputs: parts, output: joined, fps: spec.fps, hasAudio: audio, loop: spec.loop,
      cut: !!spec.cut, transition: spec.transition || 'none', durations,
    }), 3600000);

    const version = (Number(job.version) || 0) + 1;
    const output = path.join(dir, outputName(job.id, version));
    const soundtrack = spec.soundtrack && fs.existsSync(spec.soundtrack) ? spec.soundtrack : '';
    let captions = Array.isArray(spec.captions) ? spec.captions : [];
    const length = await durationOf(joined);
    if (!captions.length && spec.lyricsCaptions && spec.lyrics) captions = lyricsToCaptions(spec.lyrics, spec.songSeconds || length);
    if (soundtrack || captions.length) {
      let captionsFile = '';
      if (captions.length) {
        captionsFile = 'captions.ass';
        const [width, height] = (await probe(joined, 'stream=width,height', 'v:0')).trim().split(',').map(Number);
        fs.writeFileSync(path.join(work, captionsFile), captionsAss(captions, { width: width || spec.width, height: height || spec.height }));
      }
      await runTool(run, ffmpeg, finishArgs({
        input: joined, output, soundtrack, captionsFile, duration: length,
      }), 3600000, work);
      fs.rmSync(joined, { force: true });
    } else {
      fs.renameSync(joined, output);
    }
    job.version = version;
    job.output = { filename: outputName(job.id, version), subfolder: '', type: 'webui', media: 'video' };
  };

  /** One segment, drawn: queued, waited for, downloaded, and its last frame handed on. */
  const drawSegment = async (job, i) => {
    const spec = job.spec;
    job.segment = i;
    job.segmentStates[i] = 'running';
    // A cut is its own shot: nothing is carried over from the one before.
    const firstFrame = spec.cut ? '' : (i === 0 ? '' : job.firstFrame);
    if (!job.current) {
      const graph = await handlers.build(spec, i, firstFrame);
      job.current = await handlers.submit(graph, spec, i);
      save(job);
    }
    let entry;
    try {
      entry = await waitFor(job, job.current);
    } catch (error) {
      // ComfyUI restarted under it: the segment is queued again rather than the clip lost.
      if (!error.vanished || job.cancelled) throw error;
      job.current = null;
      return drawSegment(job, i);
    }
    const video = handlers.outputsOf(entry).find(item => item.media === 'video');
    if (!video) throw new Error(`segment ${i + 1} produced no video`);
    job.files[i] = { filename: video.filename, subfolder: video.subfolder || '', type: video.type || 'output' };
    const name = `segment-${String(i).padStart(3, '0')}${path.extname(video.filename) || '.mp4'}`;
    await download(video, path.join(partsDir(job.id), name));
    job.parts[i] = name;
    if (!spec.cut && i < job.count - 1) {
      const still = path.join(partsDir(job.id), `segment-${String(i).padStart(3, '0')}-last.png`);
      await runTool(run, ffmpeg, lastFrameArgs(path.join(partsDir(job.id), name), still), 120000);
      job.firstFrame = await upload(still, `${job.id}-${i}.png`);
    }
    job.current = null;
    job.segmentStates[i] = 'done';
    save(job);
  };

  const drive = async (job) => {
    fs.mkdirSync(partsDir(job.id), { recursive: true });
    const release = handlers.hold?.() || (() => {});
    job.state = 'running';
    job.error = null;
    save(job);
    try {
      const from = job.redo ? job.redo.from : job.segment;
      const to = job.redo ? job.redo.to : job.count - 1;
      for (let i = from; i <= to; i += 1) {
        if (job.cancelled) throw new Error('stopped');
        // Done already: before a restart, or outside a redo's range.
        if (job.segmentStates[i] === 'done') continue;
        await drawSegment(job, i);
      }
      await assemble(job);
      job.state = 'done';
      job.phase = 'done';
      job.redo = null;
      job.segment = job.count - 1;
      handlers.onDone?.(job);
    } catch (error) {
      job.state = 'failed';
      job.error = job.cancelled ? 'stopped' : error.message;
      if (job.redo) {
        // A redo that failed leaves the clip as it was: the last good version still plays.
        job.state = job.version ? 'done' : 'failed';
        job.redoError = job.error;
        job.redo = null;
      }
      if (job.segmentStates[job.segment] === 'running') job.segmentStates[job.segment] = 'failed';
      if (!job.cancelled) log.warn?.(`[long-video] ${job.id}: ${error.message}`);
      handlers.onFail?.(job);
    } finally {
      job.current = null;
      job.finishedAt = Date.now();
      job.cancelled = false;
      save(job);
      release();
    }
  };

  const startDriving = (job) => {
    jobs.set(job.id, job);
    job.done = (async () => {
      while (!handlers) await sleep(100);
      return drive(job);
    })();
    return job;
  };

  const status = (id) => {
    const job = load(id);
    if (!job) return null;
    const output = job.version ? { filename: outputName(job.id, job.version), subfolder: '', type: 'webui', media: 'video' } : null;
    if (job.state === 'running') {
      return {
        state: 'running', segment: (Number(job.segment) || 0) + 1, segments: job.count, phase: job.phase,
        current: job.current, redo: job.redo || null, output,
      };
    }
    if (job.state === 'done' && output) return { state: 'done', output, ...(job.redoError ? { redoError: job.redoError } : {}) };
    return { state: 'failed', error: job.error || 'failed' };
  };

  return {
    dir,
    bind: (given) => { handlers = given; },
    has: (id) => !!load(id),
    ownerOf: (id) => load(id)?.owner ?? null,

    /**
     * Start one. `spec` is everything a segment is built from, and all of it is
     * written to disk: count, total, segmentSeconds, fps, loop, cut, transition,
     * prompts, the segment template, and the finishing (soundtrack, captions).
     */
    start: (spec, { owner = '', chat = '' } = {}) => {
      fs.mkdirSync(dir, { recursive: true });
      const id = `long-${crypto.randomBytes(8).toString('hex')}`;
      const job = {
        id, owner, chat, count: spec.count, segment: 0, state: 'running', phase: 'segments', current: null,
        files: [], parts: [], firstFrame: '', startedAt: Date.now(), version: 0, redo: null, spec,
        segmentStates: Array.from({ length: spec.count }, () => 'pending'), cancelled: false,
      };
      save(job);
      return startDriving(job);
    },

    /**
     * Carry on with every clip a restart interrupted, at the segment it was on.
     * A segment whose prompt ComfyUI still has is waited for, not queued again.
     */
    resume: () => {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return []; }
      const resumed = [];
      for (const name of names) {
        const match = /^(long-[a-z0-9]{6,32})\.state\.json$/.exec(name);
        if (!match || jobs.has(match[1])) continue;
        const job = load(match[1]);
        if (!job || job.state !== 'running' || !job.spec) continue;
        job.cancelled = false;
        log.log?.(`[long-video] resuming ${job.id} at segment ${(Number(job.segment) || 0) + 1} of ${job.count}`);
        startDriving(job);
        resumed.push(job.id);
      }
      return resumed;
    },

    status,

    /** The storyboard: each segment's prompt and how far it has got. */
    info: (id) => {
      const job = load(id);
      if (!job?.spec) return null;
      return {
        id: job.id,
        state: job.state,
        count: job.count,
        segmentSeconds: job.spec.segmentSeconds,
        cut: !!job.spec.cut,
        transition: job.spec.transition || 'none',
        prompts: job.spec.prompts || [],
        segments: job.segmentStates || [],
        redo: job.redo || null,
        version: job.version || 0,
      };
    },

    /** Rewrite a segment that has not started yet. Returns false for one that has. */
    setPrompt: (id, segment, prompt) => {
      const job = load(id);
      const i = Number(segment);
      if (!job?.spec || !Number.isInteger(i) || i < 0 || i >= job.count) return false;
      if (job.segmentStates?.[i] !== 'pending') return false;
      job.spec.prompts[i] = String(prompt || '').slice(0, 4000);
      save(job);
      return true;
    },

    /**
     * Draw one segment again -- with a new prompt, if given -- and re-join.
     *
     * A continuous clip pins the next segment to this one's last frame, so a
     * redone segment leaves a jump at the next seam unless the ones after it are
     * redone too (`following`). A cut has no such seam.
     */
    redo: (id, segment, { prompt, following = false } = {}) => {
      const job = load(id);
      const i = Number(segment);
      if (!job?.spec || job.state === 'running') return { ok: false, error: job ? 'That clip is still being made.' : 'Not found' };
      if (!Number.isInteger(i) || i < 0 || i >= job.count) return { ok: false, error: 'No such segment' };
      if (!job.parts?.length || job.parts.length < job.count) return { ok: false, error: 'This clip has no segments to redo.' };
      if (typeof prompt === 'string' && prompt.trim()) job.spec.prompts[i] = prompt.slice(0, 4000);
      const to = following && !job.spec.cut ? job.count - 1 : i;
      for (let k = i; k <= to; k += 1) job.segmentStates[k] = 'pending';
      job.redo = { from: i, to };
      job.segment = i;
      job.redoError = null;
      /* The frame this segment opens on is the last frame of the one before,
         which is still on disk -- and still in ComfyUI's input folder under the
         name it was uploaded as. */
      job.firstFrame = i > 0 && !job.spec.cut ? `webui-long/${job.id}-${i - 1}.png` : '';
      startDriving(job);
      return { ok: true, from: i, to };
    },

    /** The ComfyUI prompt this long job is waiting on, for progress and cancel. */
    currentOf: (id) => jobs.get(id)?.current || null,

    /** Ids still being made, for a cancel that means everything. */
    running: () => [...jobs.values()].filter(job => job.state === 'running').map(job => job.id),

    cancel: (id) => {
      const job = jobs.get(id);
      if (!job) return null;
      job.cancelled = true;
      return job.current;
    },

    /** A finished file's path, or null for any name this module did not write. */
    fileFor: (filename) => {
      const name = String(filename || '');
      if (!LONG_FILE.test(name)) return null;
      const file = path.join(dir, name);
      return fs.existsSync(file) ? file : null;
    },

    /** The segment files ComfyUI kept for a clip, for the safeguard's tagger. */
    segmentsOf: (filename) => {
      const match = LONG_FILE.exec(String(filename || ''));
      if (!match) return [];
      return (load(match[1])?.files || []).filter(Boolean);
    },
  };
};

/* One runner per data folder and ComfyUI, shared by every set of routes: the
   routes are created more than once (api.js, vite.config.js, tests), and two
   runners would each resume the same interrupted clip. */
const runners = new Map();
export const longVideosFor = (options) => {
  const key = `${options.dir}|${options.base}`;
  if (!runners.has(key)) runners.set(key, createLongVideos(options));
  return runners.get(key);
};
