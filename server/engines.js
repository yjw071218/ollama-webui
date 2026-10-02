/**
 * The engines this app runs itself: GPT-SoVITS for speech, ACE-Step for songs.
 *
 * ## Inside the project, and started by it
 *
 * Both used to live somewhere else on the disk, found through `.env`, and both
 * had to be started by hand -- a PowerShell window left open for the voice, a
 * batch file for the music. They now live under `engines/`, whole: their own
 * Python, their weights, the voices trained on this machine. The app starts one
 * the first time something needs it and says so when it cannot.
 *
 * `engines/` is gitignored. It is tens of gigabytes, none of it source, and the
 * voices in it are nobody else's to publish.
 *
 * `.env` still wins where it says something (`GPT_SOVITS_PATH`, `ACE_STEP_PATH`,
 * and the `_PYTHON` beside each), so an install kept elsewhere on purpose goes
 * on working.
 *
 * ## Why every start writes a log
 *
 * The old launcher ran detached with its output thrown away. A server that
 * failed to start -- a port in use, a missing weight, CUDA out of memory --
 * failed silently, and from the app it looked exactly like one still loading.
 * Now each start writes `engines/logs/<id>.log`, and a start that dies reports
 * the last lines of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENGINES_DIR = path.resolve(HERE, '..', 'engines');

/* What each engine is. Pure data, so resolving one is testable without a disk.
 *
 * `python` is a list of places a bundled interpreter may be, in order: the
 * GPT-SoVITS integration package ships `runtime/`, ACE-Step's installer makes a
 * uv `.venv`, and its portable build ships `python_embeded` instead. */
export const ENGINE_SPECS = {
  'gpt-sovits': {
    id: 'gpt-sovits',
    label: 'GPT-SoVITS',
    dir: 'gpt-sovits',
    rootEnv: 'GPT_SOVITS_PATH',
    pythonEnv: 'GPT_SOVITS_PYTHON',
    python: ['runtime/python.exe', 'runtime/bin/python'],
    script: 'api_v2.py',
    hostEnv: 'TTS_HOST',
    portEnv: 'TTS_PORT',
    port: 9880,
    args: ({ host, port, env }) => [
      '-a', host, '-p', String(port),
      '-c', env.GPT_SOVITS_CONFIG || 'GPT_SoVITS/configs/tts_infer.yaml',
    ],
    /* api_v2 has no health route; `/tts` with no text answers 400 in JSON, and
       any answer at all means the server is listening. */
    health: '/tts',
    anyAnswer: true,
    // Loading BERT, HuBERT and two checkpoints onto the card.
    startupMs: 180000,
  },
  'ace-step': {
    id: 'ace-step',
    label: 'ACE-Step 1.5',
    dir: 'ace-step',
    rootEnv: 'ACE_STEP_PATH',
    pythonEnv: 'ACE_STEP_PYTHON',
    python: ['.venv/Scripts/python.exe', 'python_embeded/python.exe', '.venv/bin/python'],
    script: 'acestep/api_server.py',
    hostEnv: 'ACE_STEP_HOST',
    portEnv: 'ACE_STEP_PORT',
    port: 8001,
    args: ({ host, port }) => ['--host', host, '--port', String(port)],
    health: '/health',
    anyAnswer: false,
    /* The DiT, the VAE, the text encoder and -- on a card with room -- the 5Hz
       language model. Measured at a little over two minutes cold. */
    startupMs: 420000,
    /* A 16GB card shares itself with ComfyUI and the chat model, so a song
       finished an hour ago must not be what makes the next picture run out of
       memory. The answer is not to park it in RAM -- see below -- it is to stop
       it once it has been idle a while. */
    extraEnv: {
      /* Deliberately *not* ACESTEP_OFFLOAD_TO_CPU. That flag parks the models
         in system RAM between songs, which is a model on the CPU and eight
         gigabytes of a machine that is already paging. They stay on the card
         while it works, and the engine is stopped when it is idle instead --
         see `stopIfIdle`. */
      // No update check against GitHub on every start.
      CHECK_UPDATE: 'false',
      /* Started by a server, its output goes to a log file rather than to a
       * console -- and ACE-Step asks `sys.stderr.isatty()` to decide whether to
       * draw progress bars, on a stderr it has already replaced with a logger
       * that has no `isatty`:
       *
       *   AttributeError: 'StderrLogger' object has no attribute 'isatty'
       *   ERROR:    Application startup failed. Exiting.
       *
       * The question is only asked when this variable is unset -- `env or not
       * isatty()` short-circuits -- so answering it is the fix, and the answer
       * is the right one anyway: progress bars in a log file are noise. */
      ACESTEP_DISABLE_TQDM: '1',
      /* The 5Hz language model, chosen rather than left to ACE-Step.
       *
       * Its own GPU tiers call a 16GB card "tier6" and pick the 4B model -- which
       * does not fit beside the DiT and the VAE on that card when the fast
       * nano-vllm backend is not installed. Measured: the load stopped at
       * "CUDA out of memory ... 14.97 GiB is allocated by PyTorch", and from
       * then every song failed with "5Hz LM init failed" until the engine was
       * restarted. The 1.7B model is installed here and fits. `.env` can say
       * otherwise with ACESTEP_LM_MODEL_PATH. */
      ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-1.7B',
      // Fragmentation is most of what "0 bytes free" is on a card this full.
      PYTORCH_CUDA_ALLOC_CONF: 'expandable_segments:True',
    },
  },
};

/**
 * Where an engine is and how it would be run, without running anything.
 *
 * `exists` is injected so the precedence -- `.env`, then `engines/`, then
 * nothing -- is a thing a test can check.
 */
export const resolveEngine = (id, env = {}, { exists = fs.existsSync, dir = ENGINES_DIR } = {}) => {
  const spec = ENGINE_SPECS[id];
  if (!spec) return null;

  const given = String(env[spec.rootEnv] || '').trim();
  const bundled = path.join(dir, spec.dir);
  const root = given || bundled;
  const from = given ? 'env' : 'bundled';

  const pythonGiven = String(env[spec.pythonEnv] || '').trim();
  const python = pythonGiven
    || spec.python.map(rel => path.join(root, rel)).find(p => exists(p))
    || '';

  const host = String(env[spec.hostEnv] || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(env[spec.portEnv]) || spec.port;

  let problem = '';
  if (!exists(root)) {
    problem = given
      ? `${spec.rootEnv} does not exist: ${root}`
      : `${spec.label} is not in engines/${spec.dir}.`;
  } else if (!exists(path.join(root, spec.script))) {
    problem = `${spec.label} at ${root} has no ${spec.script}.`;
  } else if (!python) {
    problem = `No Python for ${spec.label}: none of ${spec.python.join(', ')} exists, and ${spec.pythonEnv} is not set.`;
  }

  return {
    id,
    label: spec.label,
    root,
    from,
    python,
    host,
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    installed: !problem,
    problem,
  };
};

/** The process an engine is started as. */
export const engineCommand = (resolved, env = {}) => {
  const spec = ENGINE_SPECS[resolved.id];
  const extraPath = resolved.id === 'gpt-sovits' && env.FFMPEG_BIN ? env.FFMPEG_BIN : '';
  return {
    command: resolved.python,
    args: [spec.script, ...spec.args({ host: resolved.host, port: resolved.port, env })],
    cwd: resolved.root,
    env: {
      ...process.env,
      ...(spec.extraEnv || {}),
      // What this install's .env chose instead -- it is not in process.env.
      ...(resolved.id === 'ace-step' && env.ACESTEP_LM_MODEL_PATH ? { ACESTEP_LM_MODEL_PATH: String(env.ACESTEP_LM_MODEL_PATH) } : {}),
      ...(resolved.id === 'ace-step' && env.ACESTEP_INIT_LLM ? { ACESTEP_INIT_LLM: String(env.ACESTEP_INIT_LLM) } : {}),
      // GPT-SoVITS shells out to ffmpeg for anything that is not 32 kHz wav.
      ...(extraPath ? { PATH: `${extraPath}${path.delimiter}${process.env.PATH || ''}` } : {}),
      // Output as it happens, so the log says where a start got to.
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
    },
  };
};

/** The last lines of a log, for an error message. */
export const logTail = (text, lines = 12) => String(text || '')
  .split(/\r?\n/)
  .map(line => line.trimEnd())
  .filter(Boolean)
  .slice(-lines)
  .join('\n');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Stop whatever is listening on a port, when the handle for it is gone.
 *
 * A web server restart leaves the engines running -- deliberately, they outlive
 * it -- and then nothing here has a process to kill. The port is the only thing
 * left that identifies it.
 */
const killListener = async (port) => {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  if (process.platform !== 'win32') return false;
  const found = await run('netstat', ['-ano']);
  const pids = new Set(found.split(/\r?\n/)
    .filter(line => line.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(line))
    .map(line => line.trim().split(/\s+/).pop())
    .filter(pid => /^\d+$/.test(pid) && pid !== '0'));
  let killed = false;
  for (const pid of pids) {
    await run('taskkill', ['/PID', pid, '/T', '/F']);
    killed = true;
  }
  return killed;
};

/**
 * The engines, as one thing the routes share.
 *
 * One per process, keyed by nothing: two starts of the same engine at once
 * would be two Pythons fighting over one port, and the loser's error is the
 * one somebody would read.
 */
/** How long an engine may sit doing nothing before it gives the card back. */
export const IDLE_MS = 10 * 60 * 1000;

export const createEngines = (env = {}, { fetchImpl = fetch, spawnImpl = spawn, dir = ENGINES_DIR, now = Date.now } = {}) => {
  const starting = new Map();
  const children = new Map();
  const lastUsed = new Map();
  const logDir = path.join(dir, 'logs');

  const up = async (id) => {
    const resolved = resolveEngine(id, env, { dir });
    if (!resolved) return false;
    const spec = ENGINE_SPECS[id];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetchImpl(`${resolved.url}${spec.health}`, { signal: controller.signal });
      return spec.anyAnswer ? true : res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const status = async (id) => {
    const resolved = resolveEngine(id, env, { dir });
    if (!resolved) return null;
    return {
      id,
      label: resolved.label,
      installed: resolved.installed,
      problem: resolved.problem,
      // Where it is, by folder name only: a full path is a fact about this
      // machine that has no business in a browser.
      root: path.basename(resolved.root),
      bundled: resolved.from === 'bundled',
      port: resolved.port,
      running: resolved.installed ? await up(id) : false,
      starting: starting.has(id),
    };
  };

  /**
   * Start an engine if it is not already answering, and wait until it does.
   *
   * Resolves `{ ok: true }` once it answers, or `{ ok: false, error }` with the
   * end of its log when the process exits first or the wait runs out.
   */
  const ensure = (id, { wait = true } = {}) => {
    if (starting.has(id)) return wait ? starting.get(id) : Promise.resolve({ ok: true, starting: true });
    const run = (async () => {
      const resolved = resolveEngine(id, env, { dir });
      if (!resolved) return { ok: false, error: `Unknown engine: ${id}` };
      if (!resolved.installed) return { ok: false, error: resolved.problem };
      if (await up(id)) return { ok: true, already: true };

      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `${id}.log`);
      const out = fs.openSync(logFile, 'w');
      const { command, args, cwd, env: childEnv } = engineCommand(resolved, env);
      let exited = null;
      let child;
      try {
        child = spawnImpl(command, args, {
          cwd,
          env: childEnv,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', out, out],
        });
      } catch (e) {
        fs.closeSync(out);
        return { ok: false, error: `${resolved.label} could not be started: ${e.message}` };
      }
      child.on('exit', (code) => { exited = code ?? 'signal'; });
      child.on('error', (e) => { exited = e.message; });
      // It outlives this request, and this server: a restart of the web app
      // should not take the voice down with it.
      child.unref();
      children.set(id, child);
      fs.closeSync(out);

      const spec = ENGINE_SPECS[id];
      const deadline = Date.now() + spec.startupMs;
      while (Date.now() < deadline) {
        if (exited !== null) {
          const tail = logTail(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
          return { ok: false, error: `${resolved.label} stopped while starting (${exited}).${tail ? `\n${tail}` : ''}` };
        }
        if (await up(id)) return { ok: true, started: true };
        await sleep(1500);
      }
      return { ok: false, error: `${resolved.label} did not answer within ${Math.round(spec.startupMs / 1000)}s. See engines/logs/${id}.log.` };
    })().finally(() => starting.delete(id));
    starting.set(id, run);
    return wait ? run : Promise.resolve({ ok: true, starting: true });
  };

  /* Who is holding the card, and when they last did anything with it.
   *
   * A song takes about as long as the song, and the browser polls while it
   * runs, so "used" is touched all the way through one. */
  const touch = (id) => { lastUsed.set(id, now()); };

  /**
   * Stop an engine that has been idle for longer than `idleMs`.
   *
   * Called before anything else wants the GPU, and on a timer after a job
   * finishes. `idleMs: 0` stops it whatever it was doing, which is only for a
   * shutdown; every caller passes a real number.
   *
   * Killing rather than unloading, because ACE-Step has no unload: what it
   * costs is a restart next time (half a minute once the weights are cached),
   * and what it buys is eight gigabytes of VRAM that would otherwise sit there
   * until the machine was rebooted.
   */
  const stopIfIdle = async (id, idleMs = IDLE_MS) => {
    if (starting.has(id)) return { stopped: false, reason: 'starting' };
    const since = now() - (lastUsed.get(id) ?? 0);
    if (since < idleMs) return { stopped: false, reason: 'busy' };
    if (!(await up(id))) return { stopped: false, reason: 'not running' };
    const child = children.get(id);
    let stopped = false;
    try {
      if (child?.pid) { process.kill(child.pid); stopped = true; }
    } catch {
      // Already gone, or not ours to kill -- either way it is not holding the
      // card on our account.
    }
    if (!stopped) {
      /* Not started by this process -- a server restart leaves the engine
         running and the handle behind. Found by the port it answers on. */
      const resolved = resolveEngine(id, env, { dir });
      stopped = await killListener(resolved.port);
    }
    if (stopped) { children.delete(id); lastUsed.delete(id); }
    return { stopped };
  };

  return {
    status,
    ensure,
    up,
    touch,
    stopIfIdle,
    resolve: (id) => resolveEngine(id, env, { dir }),
    list: () => Promise.all(Object.keys(ENGINE_SPECS).map(status)),
  };
};

const shared = new Map();

/** The one set of engines for this process and this configuration. */
export const enginesFor = (env = {}) => {
  const key = Object.values(ENGINE_SPECS)
    .flatMap(s => [env[s.rootEnv], env[s.pythonEnv], env[s.hostEnv], env[s.portEnv]])
    .join('|');
  if (!shared.has(key)) shared.set(key, createEngines(env));
  return shared.get(key);
};
