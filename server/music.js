/**
 * Songs, from ACE-Step 1.5.
 *
 * ## What this is talking to
 *
 * `engines/ace-step` is a whole music model with a REST API of its own: post a
 * task to `/release_task`, poll `/query_result` until it says 1, then fetch the
 * audio. It is started by this app on the first request that needs it -- see
 * server/engines.js -- because a music button that only works if you remembered
 * to run a batch file first is a music button that does not work.
 *
 * ## Why the result is copied here
 *
 * ACE-Step writes its audio into its own temporary folder and serves it back by
 * absolute path. A chat message holding that address would be a link that works
 * until the folder is cleaned, and a song in a conversation from last week
 * should still play. So the bytes are fetched once and written under
 * `data/music/`, and the message points at this server.
 *
 * ## The card
 *
 * There is one graphics card and three things want it: the chat model, ComfyUI,
 * and now this. A song is asked for from a conversation, which means a language
 * model is loaded at that moment by definition, so the same release the Studio
 * does before drawing happens here before generating -- and ACE-Step is started
 * with its own offload-to-CPU flag so a song made an hour ago is not what makes
 * the next picture run out of memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { enginesFor, IDLE_MS, ENGINES_DIR } from './engines.js';
import { decodeByteFallback } from '../src/byteFallback.js';
import { vramGuard } from './vram.js';
import { assertMemoryAvailable } from './resourceSafety.js';
import { rememberLiveJob, forgetLiveJob } from './liveJobs.js';
import { noteFinished, sendPush } from './push.js';

export const MUSIC_DIR = path.join(DATA_DIR, 'music');

/* What a song may be asked for. Held to these here rather than trusted from the
   browser: `audio_duration` past ten minutes is a refusal from ACE-Step after
   the wait rather than before it, and `batch_size` is the difference between
   one song and eight of them on a card that has room for about one. */
export const MUSIC_LIMITS = {
  duration: { min: 10, max: 300, fallback: 60 },
  steps: { min: 1, max: 60, fallback: 8 },
  batch: { min: 1, max: 4, fallback: 1 },
};

const clamp = (value, { min, max, fallback }) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
};

/**
 * The task ACE-Step is asked for, from what the app was asked for.
 *
 * Pure, and the reason it is: every one of these names has three spellings in
 * that API (`audio_duration` / `duration` / `audioDuration`) and picking the
 * wrong one is not an error, it is a song of the wrong length.
 */
export const musicTask = (job = {}) => {
  /* Byte-fallback tokens spelled out -- `<0xE3><0x80><0x80>` for a Japanese
     full-width space -- are characters, and are sent to be sung as characters,
     whatever path the lyrics came by. See parseToolArgs in src/tools.js. */
  const lyrics = decodeByteFallback(String(job.lyrics || '')).trim();
  const instrumental = !!job.instrumental || !lyrics;
  return {
    prompt: decodeByteFallback(String(job.prompt || job.style || '')).trim(),
    // An instrumental is asked for by saying so in the tags, which is what the
    // model was trained on; an empty lyric field alone gives it licence to sing.
    lyrics: instrumental ? '[instrumental]' : lyrics,
    audio_duration: clamp(job.duration, MUSIC_LIMITS.duration),
    inference_steps: clamp(job.steps, MUSIC_LIMITS.steps),
    batch_size: clamp(job.batch, MUSIC_LIMITS.batch),
    vocal_language: String(job.language || 'en').trim() || 'en',
    audio_format: 'mp3',
    /* The 5Hz language model writes the audio codes the DiT then follows, and
       it is what makes a song sound arranged rather than assembled. It is also
       what fills in a key and a tempo nobody named. */
    thinking: job.thinking !== false,
    use_format: !!job.polish,
    ...(job.bpm ? { bpm: clamp(job.bpm, { min: 30, max: 300, fallback: 120 }) } : {}),
    ...(job.key ? { key_scale: String(job.key).trim() } : {}),
    ...(job.timeSignature ? { time_signature: String(job.timeSignature).trim() } : {}),
    ...(Number.isFinite(Number(job.seed)) && Number(job.seed) >= 0
      ? { use_random_seed: false, seed: Number(job.seed) }
      : { use_random_seed: true }),
  };
};

/**
 * What `/query_result` said, in this app's terms.
 *
 * `result` arrives as a JSON string inside JSON, and `status` is an integer
 * where 0 means two different things (queued, running) -- both of which are
 * "not yet" here.
 */
export const readResult = (entry) => {
  const status = Number(entry?.status);
  let items = [];
  try {
    const parsed = typeof entry?.result === 'string' ? JSON.parse(entry.result) : entry?.result;
    items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch {
    items = [];
  }
  const failed = status === 2 || items.some(i => Number(i?.status) === 2);
  return {
    done: status === 1,
    failed,
    error: failed ? String(entry?.error || items.find(i => i?.error)?.error || 'ACE-Step reported a failure') : '',
    tracks: items
      .map(item => ({
        // `/v1/audio?path=…` as ACE-Step wrote it; the path is what this server
        // fetches with, and never what the browser is given.
        source: String(item?.file || ''),
        lyrics: String(item?.lyrics || ''),
        prompt: String(item?.prompt || ''),
        seed: String(item?.seed_value || ''),
        metas: item?.metas || {},
      }))
      .filter(t => t.source),
  };
};

/**
 * What ACE-Step holds, for the loaded-models list.
 *
 * It has no endpoint that says what is on the card, so this is what it loads,
 * measured on disk: the DiT, the VAE, the 5Hz language model it was started
 * with (see ACESTEP_LM_MODEL_PATH in server/engines.js) and the text encoder.
 * All on the card -- it is started without CPU offload. Marked approximate,
 * because a file's size and the memory its tensors take are near, not equal.
 */
const dirBytes = (dir) => {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(full);
    else if (/\.(safetensors|bin|pt|pth)$/i.test(entry.name)) {
      try { total += fs.statSync(full).size; } catch { /* gone */ }
    }
  }
  return total;
};
let residentCache = null;
export const aceStepResident = ({ root, lm = 'acestep-5Hz-lm-1.7B', dit = 'acestep-v15-turbo' } = {}) => {
  const key = `${root}|${lm}|${dit}`;
  if (residentCache?.key === key) return residentCache.value;
  const checkpoints = path.join(root || '', 'checkpoints');
  const size = [dit, 'vae', lm, 'Qwen3-Embedding-0.6B'].reduce((sum, name) => sum + dirBytes(path.join(checkpoints, name)), 0);
  const value = {
    name: 'ACE-Step 1.5',
    model: 'ace-step',
    size,
    size_vram: size,
    source: 'ace-step',
    approximate: true,
    details: { parameter_size: `${dit.replace(/^acestep-/, '')} + ${lm.replace(/^acestep-5Hz-lm-/, 'LM ')}` },
  };
  residentCache = { key, value };
  return value;
};

/* The stages of one song, in the order ACE-Step goes through them. Measured on
   a 30-second song: planning 0-16s (reported as 10%), writing the audio codes
   16-49s (50%), the DiT 49-52s (52-80%), decoding 52-56s (80%), the file 56s
   (99%). The card shows these as its track, and the percentage between. */
export const MUSIC_PHASES = ['loading', 'planning', 'composing', 'performing', 'mixing', 'saving'];

/**
 * Where a song has got to, from what ACE-Step said.
 *
 * `stage` is ACE-Step's own sentence -- "Phase 1: Generating CoT metadata",
 * "Generating music (batch size: 1)..." -- and it is matched by what it says,
 * because the numbers in front of it are the model's and move between versions.
 */
export const musicProgress = (entry) => {
  let items = [];
  try {
    const parsed = typeof entry?.result === 'string' ? JSON.parse(entry.result) : entry?.result;
    items = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch {
    items = [];
  }
  const first = items[0] || {};
  const stage = String(first.stage || '');
  const progress = Number(first.progress);
  const phase = /CoT|metadata|Phase 1/i.test(stage) ? 'planning'
    : /audio codes|Phase 2/i.test(stage) ? 'composing'
      : /Generating music|diffusion|DiT/i.test(stage) ? 'performing'
        : /Decod/i.test(stage) ? 'mixing'
          : /Preparing|sav|succeeded/i.test(stage) ? 'saving'
            : /queued/i.test(stage) ? 'queued'
              : Number.isFinite(progress) && progress > 0 ? 'planning' : 'queued';
  return {
    phase,
    phases: MUSIC_PHASES,
    fraction: Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : null,
    stage,
  };
};

/** The `path=` an audio URL carries, whatever form the server wrote it in. */
export const audioPathOf = (source) => {
  const text = String(source || '');
  const at = text.indexOf('path=');
  if (at < 0) return '';
  return decodeURIComponent(text.slice(at + 5).split('&')[0]);
};

/** A safe local name for a saved song: never a path, always this run's. */
/** The reason in ACE-Step's log for the last job it failed, shortened; '' when there is none. */
export const lastEngineFailure = (log) => {
  const lines = String(log || '').split(/\r?\n/).filter(line => /Job [0-9a-f-]+ FAILED:/.test(line));
  const last = lines.at(-1);
  if (!last) return '';
  return last.replace(/^.*?FAILED:\s*/, '').replace(/\s+See documentation.*$/, '').slice(0, 400);
};

/** A failure that no further song can get past without a restart. */
export const brokenEngine = (why) => /LM init failed|CUDA out of memory|OutOfMemoryError/i.test(String(why || ''));

const logText = () => {
  try { return fs.readFileSync(path.join(ENGINES_DIR, 'logs', 'ace-step.log'), 'utf8').slice(-200000); }
  catch { return ''; }
};

/**
 * The lyrics to keep with a song.
 *
 * ACE-Step hands back its own copy of the lyrics, rewritten by its language
 * model, and that copy is decoded token by token in Python with errors replaced:
 * a Hangul syllable cut between two tokens comes back as two or three U+FFFD --
 * "끝없는 루프 속에서 너�� 찾아낼 거야" where the request said 너를. What was sent
 * is what was asked to be sung, so a broken copy gives way to it.
 */
export const sungLyrics = (returned, submitted) => {
  const back = String(returned || '');
  const sent = String(submitted || '');
  if (back.includes('�') && sent && sent !== '[instrumental]') return sent;
  return back;
};

const submittedLyrics = new Map();
const rememberLyrics = (id, lyrics) => {
  submittedLyrics.set(id, lyrics);
  // A handful at most are ever in flight; this only stops a leak.
  if (submittedLyrics.size > 200) submittedLyrics.delete(submittedLyrics.keys().next().value);
};

export const trackName = (taskId, index, format = 'mp3') =>
  `${String(taskId).replace(/[^a-zA-Z0-9_-]/g, '')}-${index + 1}.${format}`;

const sendJson = (res, payload, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
};

const readBody = (req, limit = 512 * 1024) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > limit) reject(new Error('Request too large'));
  });
  req.on('end', () => {
    try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); }
  });
  req.on('error', reject);
});

const withTimeout = async (url, { method = 'GET', body, timeout = 30000, raw = false } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return res;
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!res.ok) throw new Error(`ACE-Step HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * `identify` says which account a request is acting as; see server/studio.js,
 * which takes the same thing for the same reason. A song is a five-minute job
 * too, and the reader's other devices have the same right to watch it happen.
 */
export const createMusicRoutes = (env = {}, { identify = () => '' } = {}) => {
  const routes = [];
  const route = (routePath, handler) => routes.push({ path: routePath, handler });
  const engines = enginesFor(env);
  const vram = vramGuard(env);

  const base = () => engines.resolve('ace-step').url;

  /* Songs being made. The engine is stopped the moment the last of them is done
     -- it has no unload, and eight or nine gigabytes of card held for a song
     finished a minute ago is what made the next picture or chat slow. A song
     that is abandoned (the tab closed mid-song) never reports done, so the
     idle stop set on each request still catches it. */
  const inflight = new Set();
  const settle = (id) => {
    inflight.delete(id);
    const keepMs = Math.max(0, Number(env.ACE_STEP_KEEP_MS) || 0);
    setTimeout(() => {
      if (inflight.size === 0) engines.stopIfIdle('ace-step', keepMs).catch(() => {});
    }, keepMs).unref?.();
  };

  /* Where a finished song is kept, and what it was. The file is the record: a
     JSON sidecar beside it holds the prompt and the lyrics, so a song found in
     the folder a month later still says what made it. */
  const saveTrack = async (taskId, index, track) => {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    const name = trackName(taskId, index);
    const file = path.join(MUSIC_DIR, name);
    const url = `${base()}/v1/audio?path=${encodeURIComponent(audioPathOf(track.source))}`;
    const res = await withTimeout(url, { timeout: 120000, raw: true });
    if (!res.ok) throw new Error(`Could not fetch the finished song (HTTP ${res.status})`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    fs.writeFileSync(`${file}.json`, JSON.stringify({
      taskId, index, at: Date.now(), ...track, source: undefined,
    }, null, 1));
    return { name, url: `/music/file/${name}`, ...track, source: undefined };
  };

  /** Whether ACE-Step is up, and start it if it is not. */
  route('/music/engine', async (req, res) => {
    const status = await engines.status('ace-step');
    if (req.method !== 'POST') return sendJson(res, { success: true, ...status });
    if (status.running) return sendJson(res, { success: true, ...status });
    const started = await engines.ensure('ace-step', { wait: false });
    sendJson(res, { success: started.ok !== false, ...status, ...started, starting: true });
  });

  /* Ask for a song.
   *
   * Answers with a task id as soon as ACE-Step has taken it, the same bargain
   * the Studio makes with ComfyUI: a generation outlives any sensible request
   * timeout, and a phone that locks its screen should not lose the song. */
  route('/music/generate', async (req, res) => {
    let job;
    try { job = await readBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }

    const task = musicTask(job);
    if (!task.prompt && !String(job.lyrics || '').trim()) {
      return sendJson(res, { success: false, error: 'A style or some lyrics are required' }, 400);
    }

    const engine = await engines.status('ace-step');
    if (!engine.installed) {
      return sendJson(res, { success: false, error: engine.problem }, 501);
    }

    /* The card, before the engine starts as well as before a song.
     *
     * ACE-Step loads every model it has onto the card the moment it starts, so
     * starting it on a card ComfyUI or the chat model is still holding is a
     * start that runs out of memory -- and a start that runs out of memory
     * leaves an engine that fails every song after it. A picture or video
     * still being drawn is not pulled out from under itself; the song waits. */
    if (!engine.running) {
      await vram.releaseLlm().catch(() => []);
      const comfy = await vram.releaseComfy().catch(() => 'idle');
      if (comfy === 'drawing') {
        return sendJson(res, {
          success: false,
          error: 'ComfyUI is still drawing a picture or video, which holds the graphics card. The song was not started; ask again when it is done.',
        }, 503);
      }
    }
    if (!engine.running) {
      /* Started, not waited for: loading the DiT and the 5Hz model takes
         minutes on a cold card, and an HTTP request held open for that is a
         request that times out somewhere in the middle. The caller polls
         /music/engine and asks again. */
      const started = await engines.ensure('ace-step', { wait: false });
      return sendJson(res, {
        success: false,
        starting: true,
        error: started.ok === false ? started.error : 'ACE-Step is starting; this takes a few minutes the first time.',
      }, 503);
    }

    /* The same admission check a picture goes through. A song is a GPU job with
       a language model in front of it, and starting one on a machine that is
       already out of RAM is how a slow minute becomes a stopped computer. */
    try { assertMemoryAvailable(); }
    catch (e) { return sendJson(res, { success: false, error: e.message }, e.statusCode || 503); }

    // The card, before the request rather than after it.
    const unloaded = await vram.releaseLlm();
    await vram.releaseComfy();
    // Being used, so nothing takes the card back underneath it.
    engines.touch('ace-step');

    try {
      const queued = await withTimeout(`${base()}/release_task`, { method: 'POST', body: task, timeout: 60000 });
      const id = queued?.data?.task_id;
      if (!id) {
        return sendJson(res, { success: false, error: queued?.error || 'ACE-Step refused the task' }, 502);
      }
      // What was asked to be sung, for when ACE-Step's copy of it comes back broken.
      rememberLyrics(id, task.lyrics);
      inflight.add(id);
      // The backstop for a song nobody comes back for: see `settle`.
      setTimeout(async () => {
        const done = await engines.stopIfIdle('ace-step').catch(() => null);
        // Stopped for being idle: whatever was still counted as being made was abandoned.
        if (done?.stopped) inflight.clear();
      }, IDLE_MS + 1000).unref?.();
      /* Which conversation it is being made for, when it is for one -- so the
         same card can go up on another device of the reader's. Pictures,
         edits and songs all land in one register; see server/liveJobs.js. */
      rememberLiveJob({
        id,
        owner: identify(req),
        chat: job.chat,
        kind: 'music',
        prompt: task.prompt || String(job.lyrics || '').slice(0, 200),
        model: 'ace-step',
      });
      sendJson(res, {
        success: true,
        id,
        queued: queued?.data?.queue_position ?? null,
        settings: {
          duration: task.audio_duration,
          steps: task.inference_steps,
          language: task.vocal_language,
          instrumental: task.lyrics === '[instrumental]',
          thinking: task.thinking,
        },
        ...(unloaded.length ? { unloaded } : {}),
      });
    } catch (e) {
      sendJson(res, { success: false, error: String(e.message || e) }, 502);
    }
  });

  /* How a song is getting on, and where it is once it is done. */
  route('/music/status', async (req, res) => {
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    if (!id) return sendJson(res, { success: false, error: 'No task id' }, 400);
    try {
      const answer = await withTimeout(`${base()}/query_result`, {
        method: 'POST', body: { task_id_list: [id] }, timeout: 30000,
      });
      const entry = (answer?.data || []).find(e => e?.task_id === id) || (answer?.data || [])[0];
      const read = readResult(entry);
      /* Still in use: the browser polls all the way through a song, and an
         engine being asked about is an engine that is working. */
      engines.touch('ace-step');
      if (!read.done) {
        // A song that fell over is not something to offer another device a
        // progress bar for.
        if (read.failed) forgetLiveJob(id);
        let error = read.error;
        if (read.failed) {
          /* ACE-Step's answer says only that it failed; its log says why. */
          const why = lastEngineFailure(logText());
          if (why) error = why;
          /* A model that could not be loaded stays not loaded: every song after
             it fails the same way until the engine starts again. So it is
             stopped, and the next song starts it clean. */
          if (brokenEngine(why)) {
            await engines.stopIfIdle('ace-step', 0).catch(() => {});
            error = `${why} -- ACE-Step was stopped so the next song starts it again with the card free.`;
          }
        }
        if (read.failed) settle(id);
        return sendJson(res, {
          success: true, id, done: false, failed: read.failed, error,
          // Where it has got to, for the card -- see musicProgress.
          ...(read.failed ? {} : { progress: musicProgress(entry) }),
        });
      }
      const tracks = [];
      for (const [index, track] of read.tracks.entries()) {
        tracks.push(await saveTrack(id, index, { ...track, lyrics: sungLyrics(track.lyrics, submittedLyrics.get(id)) }));
      }
      submittedLyrics.delete(id);
      /* Done, and off the card: see `settle`. The next song costs half a minute
         of starting, which is the price of the card being free in between. */
      settle(id);
      forgetLiveJob(id);
      // Several minutes of one, and the reader is very unlikely to have sat
      // and watched it. See server/push.js.
      noteFinished(identify(req), 'music');
      sendPush(identify(req)).catch(() => {});
      sendJson(res, { success: true, id, done: true, tracks });
    } catch (e) {
      sendJson(res, { success: false, error: String(e.message || e) }, 502);
    }
  });

  /* What ACE-Step is holding, shaped like Ollama's /api/ps, for the loaded-models
     list and the system monitor. Nothing when it is not running. */
  route('/music/loaded', async (req, res) => {
    const resolved = engines.resolve('ace-step');
    if (!resolved?.installed || !(await engines.up('ace-step'))) return sendJson(res, { models: [] });
    sendJson(res, {
      models: [{
        ...aceStepResident({ root: resolved.root, lm: env.ACESTEP_LM_MODEL_PATH || 'acestep-5Hz-lm-1.7B' }),
        busy: inflight.size > 0,
      }],
    });
  });

  /* Off the card now, from the list's unload button. Not while a song is being made. */
  route('/music/unload', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required' }, 405);
    if (inflight.size > 0) return sendJson(res, { success: false, error: 'A song is still being made.' }, 409);
    const done = await engines.stopIfIdle('ace-step', 0).catch(e => ({ stopped: false, error: e.message }));
    sendJson(res, { success: true, ...done });
  });

  /* A saved song. Only by the name this server wrote -- a path from the browser
     is a path to anywhere. */
  route('/music/file', (req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = path.join(MUSIC_DIR, name);
    if (!/^[a-zA-Z0-9_-]+\.(mp3|wav|flac)$/.test(name) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const size = fs.statSync(file).size;
    const type = name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.flac') ? 'audio/flac' : 'audio/mpeg';
    /* Range, because an <audio> element asks for one to seek, and a server that
       answers 200 to a range request is a player whose scrubber does nothing. */
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Content-Type', type);
      res.setHeader('Accept-Ranges', 'bytes');
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(file).pipe(res);
  });

  return routes;
};
