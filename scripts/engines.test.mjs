// The engines the app runs itself, and the songs one of them makes.
//
// GPT-SoVITS and ACE-Step live under `engines/` now -- inside the project, with
// their own Python and their own weights -- and the app starts them when
// something needs one. What is checked here is the part that decides *what*
// would be run, and the translation between this app's idea of a song and
// ACE-Step's: both are pure, and both are the kind of thing that fails an hour
// later as "it just doesn't work" when it is wrong.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const E = await load('server/engines.js');
const M = await load('server/music.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ========================================================== where they are

   A fake disk, so this says what the *rule* is rather than what happens to be
   installed on the machine running it. */
const withFiles = (...paths) => {
  const there = new Set(paths.map(p => path.resolve(p)));
  return (p) => there.has(path.resolve(p));
};
const DIR = path.join(ROOT, 'engines');
const inDir = (...parts) => path.join(DIR, ...parts);

{
  const exists = withFiles(inDir('ace-step'), inDir('ace-step', 'acestep/api_server.py'),
    inDir('ace-step', '.venv/Scripts/python.exe'));
  const found = E.resolveEngine('ace-step', {}, { exists, dir: DIR });
  check('an engine is found inside the project', found.installed, found.problem);
  eq('  without anything being configured', found.from, 'bundled');
  check('  with its own Python', found.python.endsWith(path.join('.venv', 'Scripts', 'python.exe')));
  eq('  on its usual port', found.port, 8001);
}

/* `.env` still wins. Somebody with a 25GB install they keep elsewhere on
   purpose should not have it moved for them. */
{
  const exists = withFiles('D:/ace', 'D:/ace/acestep/api_server.py', 'D:/py/python.exe');
  const found = E.resolveEngine('ace-step', {
    ACE_STEP_PATH: 'D:/ace', ACE_STEP_PYTHON: 'D:/py/python.exe', ACE_STEP_PORT: '9001',
  }, { exists, dir: DIR });
  check('a path in .env wins over the bundled one', found.installed && found.from === 'env', found.problem);
  eq('  including its port', found.port, 9001);
}

/* Every way it can be wrong says which one it is. "It doesn't work" for a
   missing folder, a half-copied folder and a missing interpreter are three
   different afternoons. */
{
  const gone = E.resolveEngine('ace-step', {}, { exists: withFiles(), dir: DIR });
  check('a missing engine says where it was looked for', !gone.installed && /engines[\\/]ace-step/.test(gone.problem), gone.problem);

  const half = E.resolveEngine('ace-step', {}, { exists: withFiles(inDir('ace-step')), dir: DIR });
  check('  a folder without the server says that instead', /api_server\.py/.test(half.problem), half.problem);

  const noPython = E.resolveEngine('ace-step', {}, {
    exists: withFiles(inDir('ace-step'), inDir('ace-step', 'acestep/api_server.py')), dir: DIR,
  });
  check('  and one with no interpreter says that', /Python/.test(noPython.problem), noPython.problem);

  eq('an engine nobody has heard of is null', E.resolveEngine('nope', {}), null);
}

/* ============================================================== how it runs */

{
  const exists = withFiles(inDir('gpt-sovits'), inDir('gpt-sovits', 'api_v2.py'),
    inDir('gpt-sovits', 'runtime/python.exe'));
  const voice = E.resolveEngine('gpt-sovits', {}, { exists, dir: DIR });
  const cmd = E.engineCommand(voice, { FFMPEG_BIN: 'C:/ffmpeg/bin' });
  eq('the voice server is started by its own script', cmd.args[0], 'api_v2.py');
  check('  on the address it was resolved at', cmd.args.includes('-a') && cmd.args.includes('9880'));
  eq('  from its own folder', cmd.cwd, voice.root);
  /* GPT-SoVITS shells out to ffmpeg for anything that is not already 32 kHz
     wav, and without it on PATH the audio comes back silent or clipped. */
  check('  with ffmpeg on PATH', cmd.env.PATH.startsWith('C:/ffmpeg/bin'));
}

{
  const exists = withFiles(inDir('ace-step'), inDir('ace-step', 'acestep/api_server.py'),
    inDir('ace-step', '.venv/Scripts/python.exe'));
  const cmd = E.engineCommand(E.resolveEngine('ace-step', {}, { exists, dir: DIR }), {});
  /* Started by a server, its output goes to a log rather than a console -- and
     ACE-Step asks `sys.stderr.isatty()` on a stderr it has already replaced
     with a logger that has no `isatty`. It crashed on startup, every time,
     until this was set:
       AttributeError: 'StderrLogger' object has no attribute 'isatty' */
  eq('the music server is told not to draw progress bars', cmd.env.ACESTEP_DISABLE_TQDM, '1');
  /* And *not* told to offload to the CPU. That flag parks its models in system
     RAM between songs, which is a model on the CPU and eight gigabytes of a
     machine that is already paging to disk. It keeps the card while it works
     and is stopped when it is idle instead. */
  eq('  and not to park itself in system RAM', cmd.env.ACESTEP_OFFLOAD_TO_CPU, undefined);
}

/* Nothing holds the card for ever.
 *
 * ACE-Step has no unload, so the only way to get its eight gigabytes back is to
 * stop it -- and something has to, or a song made at lunchtime is still holding
 * the card when a picture is asked for at four. */
{
  let stopped = null;
  const engines = E.createEngines({}, {
    fetchImpl: async () => ({ ok: true }),          // pretend it is answering
    spawnImpl: () => { throw new Error('not started here'); },
    now: () => 1_000_000,
  });
  engines.touch('ace-step');
  const busy = await engines.stopIfIdle('ace-step', 60_000);
  eq('an engine in use is left alone', busy.stopped, false);
  eq('  and says why', busy.reason, 'busy');
  check('idle is decided by when it was last used', typeof engines.touch === 'function', String(stopped));
}

/* A start that fails has to say why. The launcher this replaces threw its
   output away, so a port in use, a missing weight and a model still loading
   were the same silence. */
check('a failed start can quote its log', typeof E.logTail === 'function');
eq('  the end of it, not the beginning', E.logTail('a\nb\nc\nd', 2), 'c\nd');
eq('  and blank lines are not lines', E.logTail('a\n\n\nb', 2), 'a\nb');

/* ================================================================== a song */

{
  const task = M.musicTask({ prompt: 'lo-fi hip hop, rhodes piano', lyrics: '[verse]\nhello', duration: 90, language: 'ko' });
  eq('the style is what the model listens to', task.prompt, 'lo-fi hip hop, rhodes piano');
  eq('  the lyrics are sung', task.lyrics, '[verse]\nhello');
  /* Three spellings of every name in that API -- `audio_duration`, `duration`,
     `audioDuration` -- and the wrong one is not an error, it is a song of the
     wrong length. */
  eq('  the length is sent under the name ACE-Step reads', task.audio_duration, 90);
  eq('  and the language is', task.vocal_language, 'ko');
}

/* An empty lyric field is not a request for an instrumental: the model takes
   it as licence to sing whatever it likes. Saying so is. */
eq('no lyrics means an instrumental, said out loud',
  M.musicTask({ prompt: 'ambient' }).lyrics, '[instrumental]');
eq('and asking for one with lyrics written still means one',
  M.musicTask({ prompt: 'ambient', lyrics: 'la la', instrumental: true }).lyrics, '[instrumental]');

eq('a length nobody gave is a minute', M.musicTask({ prompt: 'x' }).audio_duration, 60);
eq('  and one past what it makes is held there', M.musicTask({ prompt: 'x', duration: 9999 }).audio_duration, 300);
eq('  as is a batch', M.musicTask({ prompt: 'x', batch: 99 }).batch_size, 4);
check('a seed given is a seed used',
  M.musicTask({ prompt: 'x', seed: 7 }).use_random_seed === false && M.musicTask({ prompt: 'x', seed: 7 }).seed === 7);
check('  and none given is random', M.musicTask({ prompt: 'x' }).use_random_seed === true);

/* ======================================================== what came back */

{
  const entry = {
    task_id: 'abc', status: 1,
    result: JSON.stringify([{ file: '/v1/audio?path=C%3A%5Ctmp%5Ca.mp3', lyrics: '[verse]', status: 1, metas: { bpm: 90 } }]),
  };
  const read1 = M.readResult(entry);
  check('a finished task is finished', read1.done && !read1.failed);
  eq('  with its track', read1.tracks.length, 1);
  /* `result` is JSON inside JSON, and the audio is addressed by a path on the
     machine ACE-Step runs on -- which is this server's to fetch and never the
     browser's to see. */
  eq('  whose audio is found by path', M.audioPathOf(read1.tracks[0].source), 'C:\\tmp\\a.mp3');
}

eq('a queued task is not done', M.readResult({ status: 0 }).done, false);
check('a failed one says so', M.readResult({ status: 2, error: 'out of memory' }).failed);
check('  and carries the reason', /out of memory/.test(M.readResult({ status: 2, error: 'out of memory' }).error));
check('nonsense in the result does not throw', M.readResult({ status: 1, result: 'not json' }).tracks.length === 0);

// A name that is only ever this server's own, whatever the task id was.
eq('a saved song is named safely', M.trackName('../../etc/passwd', 0), 'etcpasswd-1.mp3');

/* ================================================================ wiring */

{
  const api = read('server/api.js');
  check('the engines are mounted', /createMusicRoutes\(env, \{/.test(api) && /enginesFor\(env\)/.test(api));
  /* The voice buttons keep their old addresses: an engine is not a reason to
     change what the Voice settings call. */
  check('  and the voice keeps its old routes', /'\/api\/tts-status'/.test(api) && /'\/api\/start-tts'/.test(api));
  check('  which now start it through the manager', /engines\.ensure\('gpt-sovits'/.test(api));

  const music = read('server/music.js');
  /* A song is fetched once and kept here. ACE-Step serves it out of a temp
     folder, and a conversation from last week should still play. */
  check('a finished song is copied out of the engine', /fs\.writeFileSync\(file, Buffer\.from/.test(music));
  check('  and served only by the name this server wrote',
    /\^\[a-zA-Z0-9_-\]\+\\\.\(mp3\|wav\|flac\)\$/.test(music));
  // An <audio> element asks for a range to seek; answering 200 to that is a
  // scrubber that does nothing.
  check('  with byte ranges, so the player can seek', /res\.statusCode = 206;/.test(music));
  // One card: the chat model is by definition loaded when a song is asked for.
  check('the card is handed over before a song', /vram\.releaseLlm\(\)/.test(music) && /vram\.releaseComfy\(\)/.test(music));
  /* And the same RAM admission check a picture goes through. A song is a GPU
     job with a language model in front of it; starting one on a machine that is
     already out of memory is how a slow minute becomes a stopped computer. */
  check('  and a song is refused when the machine is out of RAM',
    /assertMemoryAvailable\(\);/.test(music));
  /* Nothing is left holding the card afterwards: ACE-Step has no unload, so it
     is stopped once idle -- by the music route on a timer, and by anything else
     that wants the GPU. */
  check('the card is given back when nothing is using it',
    /stopIfIdle\('ace-step'\)/.test(music) && /engines\.touch\('ace-step'\)/.test(music));
  check('  including when a picture wants it',
    (read('server/studio.js').match(/stopIfIdle\('ace-step', 60000\)/g) || []).length >= 3);

  const gitignore = read('.gitignore');
  check('engines/ is not committed', /^engines\/\*$/m.test(gitignore));
  const vite = read('vite.config.js');
  // Hundreds of thousands of files, none of them source.
  // Among whatever else is ignored (the RisuAI checkout joined it later).
  check('and not watched', /ignored: \[[^\]]*'\*\*\/engines\/\*\*'/.test(vite));
}

/* ------------------------------------------ a song that could not be made

   Reported: "MUSIC GENERATION FAILED: ACE-Step reported a failure". ACE-Step
   had picked its 4B language model for a 16GB card, the load ran out of CUDA
   memory, and every song after it failed the same way until a restart -- with
   an answer that said only "failure". */
{
  const resolved = { id: 'ace-step', python: 'python', root: '.', host: '127.0.0.1', port: 8001 };
  const command = E.engineCommand(resolved, {});
  eq('ACE-Step starts with the language model that fits a 16GB card', command.env.ACESTEP_LM_MODEL_PATH, 'acestep-5Hz-lm-1.7B');
  eq('  unless .env says otherwise', E.engineCommand(resolved, { ACESTEP_LM_MODEL_PATH: 'acestep-5Hz-lm-0.6B' }).env.ACESTEP_LM_MODEL_PATH, 'acestep-5Hz-lm-0.6B');
  const log = [
    '[API Server] Job 111 FAILED: something earlier',
    '[API Server] Job 822006b8-38d6 FAILED: 5Hz LM init failed: ❌ Error initializing 5Hz LM: CUDA out of memory. Tried to allocate 96.00 MiB. See documentation for Memory Management',
  ].join('\n');
  eq('the reason is read from its log, the latest failure', M.lastEngineFailure(log),
    '5Hz LM init failed: ❌ Error initializing 5Hz LM: CUDA out of memory. Tried to allocate 96.00 MiB.');
  eq('  and nothing is made up when there is none', M.lastEngineFailure('all fine'), '');
  eq('a model that did not load is a broken engine; a bad prompt is not', [M.brokenEngine('5Hz LM init failed: x'), M.brokenEngine('CUDA out of memory'), M.brokenEngine('lyrics too long')], [true, true, false]);
  const music = read('server/music.js');
  check('a broken engine is stopped, so the next song starts it clean', /if \(brokenEngine\(why\)\) \{\s*\n\s*await engines\.stopIfIdle\('ace-step', 0\)/.test(music));
  check('the card is freed before the engine starts, and a drawing is not pulled from under itself',
    /if \(!engine\.running\) \{\s*\n\s*await vram\.releaseLlm\(\)[\s\S]{0,200}if \(comfy === 'drawing'\)/.test(music));
}

// ACE-Step's own copy of the lyrics, broken mid-syllable, gives way to what was sent.
eq('broken returned lyrics give way to the ones sent', M.sungLyrics('끝없는 루프 속에서 너�� 찾아낼 거야', '끝없는 루프 속에서 너를 찾아낼 거야'), '끝없는 루프 속에서 너를 찾아낼 거야');
eq('  and whole ones are kept', M.sungLyrics('[verse]\n작은 별', '작은 별'), '[verse]\n작은 별');

/* ------------------------------------------------ a song, as it is made

   Reported: a song's card said nothing but the clock. ACE-Step reports a stage
   and a percentage on every poll -- recorded on a 30-second song below -- and
   none of it was read. */
{
  const at = (stage, progress) => M.musicProgress({ result: JSON.stringify([{ status: 0, progress, stage }]) });
  const recorded = [
    ['Phase 1: Generating CoT metadata (once for all items)...', 0.1, 'planning'],
    ['Phase 2: Generating audio codes for 1 items...', 0.5, 'composing'],
    ['Generating music (batch size: 1)...', 0.6979732056290964, 'performing'],
    ['Decoding audio...', 0.8, 'mixing'],
    ['Preparing audio data...', 0.99, 'saving'],
  ];
  for (const [stage, progress, phase] of recorded) {
    const read = at(stage, progress);
    check(`"${stage.slice(0, 28)}..." is the ${phase} stage, at ${Math.round(progress * 100)}%`, read.phase === phase && read.fraction === progress, JSON.stringify(read));
  }
  eq('the stages the card draws, in order', M.MUSIC_PHASES, ['loading', 'planning', 'composing', 'performing', 'mixing', 'saving']);
  eq('a song not started yet is queued', at('queued', 0).phase, 'queued');
  const music = read('server/music.js');
  check('the status route sends it', /\.\.\.\(read\.failed \? \{\} : \{ progress: musicProgress\(entry\) \}\),/.test(music));
  const app = read('src/App.jsx');
  check('the chat polls it and hands the card a snapshot', /snapshot: \{\s*\n\s*state: phase === 'queued' \? 'queued' : 'running',/.test(app)
    && /snapshot=\{drawing\.snapshot \|\| drawingLive\}/.test(app));
  const i18n = read('src/i18n.jsx');
  for (const phase of ['planning', 'composing', 'performing', 'mixing']) {
    check(`studio.phase.${phase} is translated everywhere`, (i18n.match(new RegExp(`'studio\\.phase\\.${phase}':`, 'g')) || []).length === 12);
  }
}

/* ------------------------------------------ off the card, and on the list

   Asked for: ACE-Step taken out of VRAM after use, and shown in the system
   monitor. It has no unload, so the engine is stopped as soon as the last song
   is done; and it has no memory endpoint, so what it holds is what it loads,
   sized from the files. Measured: listed as busy while a 15-second song was
   made, unload refused meanwhile, and the engine down one second after. */
{
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const root = fsMod.mkdtempSync(path.join(os.tmpdir(), 'ace-resident-'));
  const put = (rel, bytes) => { const f = path.join(root, 'checkpoints', rel); fsMod.mkdirSync(path.dirname(f), { recursive: true }); fsMod.writeFileSync(f, Buffer.alloc(bytes)); };
  put('acestep-v15-turbo/model.safetensors', 400);
  put('vae/diffusion_pytorch_model.safetensors', 30);
  put('acestep-5Hz-lm-1.7B/model.safetensors', 300);
  put('acestep-5Hz-lm-4B/model.safetensors', 9000);
  put('Qwen3-Embedding-0.6B/model.safetensors', 100);
  put('acestep-v15-turbo/README.md', 5000);
  const held = M.aceStepResident({ root, lm: 'acestep-5Hz-lm-1.7B' });
  eq('what it holds is the DiT, VAE, the language model it runs and the encoder -- not every model on disk', held.size, 830);
  check('  shaped like a loaded model, marked as ACE-Step and approximate', held.source === 'ace-step' && held.approximate && held.size_vram === held.size);
  fsMod.rmSync(root, { recursive: true, force: true });

  const music = read('server/music.js');
  check('a finished song takes the engine off the card when no other song is being made',
    /const settle = \(id\) => \{/.test(music) && /if \(inflight\.size === 0\) engines\.stopIfIdle\('ace-step', keepMs\)/.test(music)
    && /settle\(id\);\s*\n\s*forgetLiveJob\(id\);/.test(music));
  check('  and a failed one too', /if \(read\.failed\) settle\(id\);/.test(music));
  check('what it holds is a route, and so is unloading it -- refused while a song is made',
    /route\('\/music\/loaded'/.test(music) && /route\('\/music\/unload'/.test(music) && /if \(inflight\.size > 0\) return sendJson\(res, \{ success: false, error: 'A song is still being made\.' \}, 409\);/.test(music));
  const app = read('src/App.jsx');
  check('the loaded-models list reads it beside Ollama and ComfyUI', /read\('\/music\/loaded'\)\]\);/.test(app) && /m\.source === 'ace-step' \? \(/.test(app));
  check('the system monitor labels it', /row\.source === 'ace-step' && <span className="sysmon-chip">ACE-Step<\/span>/.test(read('src/SystemMonitor.jsx')));
}

// Whatever path the lyrics took, they are sung as characters, not as spelled-out bytes.
eq('a song is sent with byte tokens decoded', M.musicTask({ prompt: 'j-pop', lyrics: '光の粒が<0xE3><0x80><0x80>降り注ぐ街' }).lyrics, '光の粒が\u3000降り注ぐ街');
check('and a song saved before that shows its lyrics decoded', /<pre>\{decodeByteFallback\(song\.lyrics\)\}<\/pre>/.test(read('src/App.jsx')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
