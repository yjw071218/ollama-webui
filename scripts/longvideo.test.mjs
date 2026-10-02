// A long clip rendered a segment at a time, and joined on disk.
//
// The single-graph chain held every segment's frames in RAM until the join, so
// length cost resolution: two minutes came out at 340x340. Now each segment is
// its own ComfyUI prompt and ffmpeg joins the files. What can go wrong without
// throwing is all here: a segment that does not open on the last frame of the
// one before, a repeated frame left in at every seam, sound drifting from the
// picture a frame per join, and a file served whole to a <video> that seeks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const M = await load('server/h3Motion.js');
const W = await load('server/workflows.js');
const L = await load('server/longVideo.js');

const info = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'object-info-minimax.json'), 'utf8'));
const build = () => W.buildPrompt(W.WORKFLOWS['minimax-h3'], info).prompt;
const available = new Set([...Object.keys(info), M.HYBRID_NODE]);

/* ------------------------------------------------------------ one segment */

{
  const graph = build();
  const { cond } = M.findH3Nodes(graph);
  const first = M.applyH3Segment(graph, { segment: 0, count: 3, prompt: '[0s-10s] opening', available });
  // Pinned to nothing, so the stock node draws it: the node pack is only for a pin.
  eq('the first segment keeps the stock node, with no pins', [first.applied, graph[cond].class_type, 'first_frame' in graph[cond].inputs, 'last_frame' in graph[cond].inputs], [true, 'MiniMaxH3ReferenceToVideo', false, false]);
  eq('  and its own part of the timeline', graph[cond].inputs.prompt, '[0s-10s] opening');
  const pinnedGraph = build();
  M.applyH3Segment(pinnedGraph, { segment: 1, count: 3, firstFrame: 'f.png', available });
  check('a pinned one carries the input the API requires but the editor hides', pinnedGraph[M.findH3Nodes(pinnedGraph).cond].inputs.also_ref_first_frame === false);
}
{
  const graph = build();
  const { cond, noise } = M.findH3Nodes(graph);
  const seedBefore = JSON.stringify(graph[noise].inputs.noise_seed);
  M.applyH3Segment(graph, { segment: 2, count: 3, prompt: 'x', firstFrame: 'webui-long/long-abc-1.png', available });
  const pin = graph[cond].inputs.first_frame;
  const scale = graph[pin[0]];
  const loader = graph[scale.inputs.image[0]];
  eq('a later segment opens on the frame it was handed, loaded by name', [loader.class_type, loader.inputs.image], ['LoadImage', 'webui-long/long-abc-1.png']);
  // The saved file may have been upscaled or cropped; the node stretches a mismatch.
  eq('  scaled to the clip\'s exact size first', [scale.class_type, scale.inputs.width, scale.inputs.height, scale.inputs.crop], ['ImageScale', graph[cond].inputs.width, graph[cond].inputs.height, 'center']);
  check('  with noise of its own', JSON.stringify(graph[noise].inputs.noise_seed) !== seedBefore);
}
{
  const count = 3;
  const graphs = [0, 1, 2].map(segment => {
    const graph = build();
    M.applyH3Segment(graph, { segment, count, loop: true, firstFrame: segment ? 'f.png' : '', available });
    return graph;
  });
  const pins = graphs.map(graph => graph[M.findH3Nodes(graph).cond].inputs);
  const source = (graph, link) => graph[graph[link[0]].inputs.image[0]]?.class_type;
  eq('a long loop opens on the reference picture and closes on it',
    [source(graphs[0], pins[0].first_frame), 'last_frame' in pins[0], 'last_frame' in pins[1], source(graphs[2], pins[2].last_frame)],
    ['LoadImage', false, false, 'LoadImage']);
}
{
  const graph = build();
  const { cond } = M.findH3Nodes(graph);
  delete graph[cond].inputs['ref_images.ref_image_0'];
  eq('a loop with no picture to pin to says so', M.applyH3Segment(graph, { loop: true, count: 2, available }).reason, 'noReference');
  eq('and a pinned segment without the node pack is not built', M.applyH3Segment(build(), { firstFrame: 'f.png', available: new Set() }).reason, 'missing');
}

/* ------------------------------------------------------------- the join */

{
  const args = L.joinArgs({ inputs: ['a.mp4', 'b.mp4', 'c.mp4'], output: 'out.mp4', fps: 24 });
  const filter = args[args.indexOf('-filter_complex') + 1];
  check('the first segment keeps its opening frame', /\[0:v\]trim=start=0\.000000/.test(filter), filter);
  // Half a frame, not one: the next frame's stored timestamp is rounded down about half the time.
  check('  each later one drops the repeated frame, by half a frame\'s time', /\[1:v\]trim=start=0\.020833/.test(filter) && /\[2:v\]trim=start=0\.020833/.test(filter), filter);
  check('  and exactly one frame of sound, as the graph did', /\[1:a\]atrim=start=0\.041667/.test(filter) && /\[0:a\]atrim=start=0\.000000/.test(filter), filter);
  check('  joined in order with sound', /\[v0\]\[a0\]\[v1\]\[a1\]\[v2\]\[a2\]concat=n=3:v=1:a=1\[v\]\[a\]/.test(filter), filter);
  check('  as a file a browser can start before it has all of it', args.includes('+faststart') && args.at(-1) === 'out.mp4');
  const loop = L.joinArgs({ inputs: ['a.mp4', 'b.mp4'], output: 'o.mp4', loop: true });
  check('a loop drops its first opening frame too', /\[0:v\]trim=start=0\.020833/.test(loop[loop.indexOf('-filter_complex') + 1]));
  const silent = L.joinArgs({ inputs: ['a.mp4', 'b.mp4'], output: 'o.mp4', hasAudio: false });
  check('a clip without sound is joined without asking for it', !silent.join(' ').includes(':a]') && !silent.includes('aac'));
  eq('the last frame is read from the end of the file', L.lastFrameArgs('in.mp4', 'last.png').slice(-6), ['-i', 'in.mp4', '-an', '-update', '1', 'last.png']);
}

/* And for real, where ffmpeg is installed: three generated two-second clips at
   24fps, 48 frames each, joined. Two repeated frames come out -- 142 frames. */
const ffmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
if (ffmpeg) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-long-'));
  try {
    const inputs = [0, 1, 2].map(i => {
      const file = path.join(work, `s${i}.mp4`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=24:duration=2`,
        '-f', 'lavfi', '-i', `sine=frequency=${440 + i * 100}:duration=2`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { windowsHide: true });
      return file;
    });
    const output = path.join(work, 'joined.mp4');
    execFileSync('ffmpeg', L.joinArgs({ inputs, output, fps: 24, crf: 30 }), { windowsHide: true });
    const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', output], { windowsHide: true }).toString().trim());
    eq('ffmpeg joins three 48-frame clips into 142 frames: the two repeats are gone', frames, 142);
    const audio = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', output], { windowsHide: true }).toString().trim();
    eq('  with its sound', audio, 'aac');
    const still = path.join(work, 'last.png');
    execFileSync('ffmpeg', L.lastFrameArgs(inputs[0], still), { windowsHide: true });
    check('and a clip\'s last frame comes out as a picture', fs.existsSync(still) && fs.statSync(still).size > 0);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
} else {
  console.log('SKIP  ffmpeg is not installed; the join was checked by its arguments only');
}

/* ----------------------------------------------------------- serving it */

{
  const S = await load('server/studio.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-serve-'));
  const file = path.join(dir, 'v.mp4');
  fs.writeFileSync(file, Buffer.from('0123456789'));
  const serve = (range) => new Promise((resolve) => {
    const headers = {};
    const chunks = [];
    const res = new PassThrough();
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; };
    res.statusCode = 0;
    res.on('data', c => chunks.push(c));
    res.on('finish', () => resolve({ status: res.statusCode, headers, body: Buffer.concat(chunks).toString() }));
    const req = { headers: range ? { range } : {}, method: 'GET', on() {} };
    S.serveFile(req, res, file, 'video/mp4');
  });
  const whole = await serve('');
  eq('a whole file, saying it can be ranged', [whole.status, whole.body, whole.headers['accept-ranges']], [200, '0123456789', 'bytes']);
  const part = await serve('bytes=2-5');
  eq('a range, as a <video> seeking asks', [part.status, part.body, part.headers['content-range']], [206, '2345', 'bytes 2-5/10']);
  const tail = await serve('bytes=-3');
  eq('  and the end of it, as a poster frame asks', [tail.status, tail.body], [206, '789']);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------- the runner's order */

const fakeWorld = ({ historyFor = null } = {}) => {
  const calls = [];
  let prompt = 0;
  const withTimeout = async (url) => {
    const id = decodeURIComponent(url.split('/history/')[1] || '');
    if (id) {
      if (historyFor) return historyFor(id);
      return { [id]: { status: { completed: true }, outputs: { 6: { images: [{ filename: `${id}.mp4`, subfolder: 'webui', type: 'output' }] } } } };
    }
    return { queue_running: [], queue_pending: [] };
  };
  const fetchImpl = async (url, init) => {
    calls.push(url.includes('/upload/image') ? 'upload' : 'download');
    if (url.includes('/upload/image')) return { ok: true, status: 200, json: async () => ({ name: init.body.get('image').name, subfolder: 'webui-long' }) };
    return { ok: true, status: 200, body: new Response('video bytes').body };
  };
  // ffmpeg and ffprobe, pretended: write what they would have written.
  const run = (command, args, options, done) => {
    const name = path.basename(command);
    if (name === 'ffprobe') return done(null, args.includes('format=duration') ? '10\n' : args.includes('stream=width,height') ? '768,768\n' : '1\n', '');
    calls.push(args.includes('-update') ? 'last-frame' : args.includes('-filter_complex') ? 'join' : 'finish');
    fs.writeFileSync(path.resolve(options?.cwd || '.', args.at(-1)), 'x');
    done(null, '', '');
  };
  return { calls, withTimeout, fetchImpl, run, nextPrompt: () => `p${++prompt}` };
};
const outputsOf = (entry) => Object.values(entry.outputs).flatMap(o => o.images).map(item => ({ ...item, media: 'video' }));

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-long-run-'));
  const world = fakeWorld();
  const built = [];
  let finished = null;
  let held = 0;
  let released = 0;
  const runner = L.createLongVideos({ base: 'http://comfy', dir, ...world, pollMs: 1, log: { warn() {}, log() {} } });
  const job = runner.start({ count: 3, fps: 24, total: 30, segmentSeconds: 10, prompts: ['a', 'b', 'c'] }, { owner: 'u' });
  check('nothing is queued until the routes have said how', world.calls.length === 0);
  runner.bind({
    build: (spec, i, firstFrame) => { built.push([i, firstFrame, spec.prompts[i]]); return { i }; },
    submit: async () => world.nextPrompt(),
    outputsOf,
    hold: () => { held += 1; return () => { released += 1; }; },
    onDone: (j) => { finished = j.id; },
  });
  check('a long job has an id of this app\'s, not ComfyUI\'s', L.isLongId(job.id), job.id);
  await job.done;
  eq('each segment is built from the one before\'s last frame, with its own prompt', built,
    [[0, '', 'a'], [1, `webui-long/${job.id}-0.png`, 'b'], [2, `webui-long/${job.id}-1.png`, 'c']]);
  eq('  download, take its last frame, hand it over -- then join once, at the end', world.calls,
    ['download', 'last-frame', 'upload', 'download', 'last-frame', 'upload', 'download', 'join']);
  eq('it finishes as one file this app serves', [runner.status(job.id).state, runner.status(job.id).output], ['done', { filename: `${job.id}.mp4`, subfolder: '', type: 'webui', media: 'video' }]);
  check('  says so once, and holds the card for the whole clip, released once', finished === job.id && held === 1 && released === 1);
  eq('the segments ComfyUI kept are remembered for the safeguard\'s tagger', runner.segmentsOf(`${job.id}.mp4`).map(f => f.filename), ['p1.mp4', 'p2.mp4', 'p3.mp4']);
  check('  and the segment files are kept, so one can be drawn again', fs.existsSync(path.join(dir, `${job.id}.parts`, 'segment-001.mp4')));
  check('only names it wrote are served', runner.fileFor(`${job.id}.mp4`) && !runner.fileFor('../webui.db') && !runner.fileFor('long-x.mp4'));
  eq('the storyboard says what every segment was asked for, and that all are done', [runner.info(job.id).prompts, runner.info(job.id).segments], [['a', 'b', 'c'], ['done', 'done', 'done']]);
  eq('the owner is remembered, so only they see the storyboard', runner.ownerOf(job.id), 'u');

  /* ---- one segment again */
  built.length = 0;
  world.calls.length = 0;
  const redo = runner.redo(job.id, 1, { prompt: 'b, but at night' });
  eq('a finished segment can be drawn again', redo, { ok: true, from: 1, to: 1 });
  const again = runner.redo(job.id, 2);
  eq('  but not while it is being drawn', again.ok, false);
  // The job object is the runner's; wait for it through status.
  for (let n = 0; n < 200 && runner.status(job.id).state === 'running'; n += 1) await new Promise(r => setTimeout(r, 5));
  eq('  opening on the last frame of the segment before, with the new prompt', built, [[1, `webui-long/${job.id}-0.png`, 'b, but at night']]);
  eq('  and the clip is joined again as a new version', runner.status(job.id).output.filename, `${job.id}-v2.mp4`);
  check('  the version is a name it serves', !!runner.fileFor(`${job.id}-v2.mp4`));

  built.length = 0;
  runner.redo(job.id, 0, { following: true });
  for (let n = 0; n < 200 && runner.status(job.id).state === 'running'; n += 1) await new Promise(r => setTimeout(r, 5));
  eq('with the ones after it, the whole take is drawn again -- no jump at the next seam', built.map(b => b[0]), [0, 1, 2]);

  /* ---- a restart */
  const interrupted = L.createLongVideos({ base: 'http://comfy', dir, ...fakeWorld(), pollMs: 1, log: { warn() {}, log() {} } });
  const state = JSON.parse(fs.readFileSync(path.join(dir, `${job.id}.state.json`), 'utf8'));
  // As if the server had died while drawing segment 3.
  fs.writeFileSync(path.join(dir, `${job.id}.state.json`), JSON.stringify({ ...state, state: 'running', segment: 2, segmentStates: ['done', 'done', 'pending'], current: null, redo: null }));
  const resumedBuilds = [];
  interrupted.bind({ build: (spec, i, f) => { resumedBuilds.push(i); return {}; }, submit: async () => 'r1', outputsOf });
  eq('a restart resumes a clip it interrupted', interrupted.resume(), [job.id]);
  for (let n = 0; n < 200 && interrupted.status(job.id).state === 'running'; n += 1) await new Promise(r => setTimeout(r, 5));
  eq('  at the segment it was on, not from the start', resumedBuilds, [2]);
  eq('  and finishes it', interrupted.status(job.id).state, 'done');

  /* ---- a cut */
  const cutWorld = fakeWorld();
  const cutBuilds = [];
  const cutter = L.createLongVideos({ base: 'http://comfy', dir, ...cutWorld, pollMs: 1, log: { warn() {}, log() {} } });
  cutter.bind({ build: (spec, i, f) => { cutBuilds.push(f); return {}; }, submit: async () => cutWorld.nextPrompt(), outputsOf });
  const shots = cutter.start({ count: 3, fps: 24, cut: true, transition: 'fade', prompts: ['x', 'y', 'z'], soundtrack: path.join(dir, 'song.mp3'), captions: [{ start: 1, end: 2, text: 'hi' }] });
  fs.writeFileSync(path.join(dir, 'song.mp3'), 'x');
  await shots.done;
  eq('shots are pinned to nothing, so no frame is carried or uploaded', [cutBuilds, cutWorld.calls.filter(c => c === 'last-frame' || c === 'upload').length], [['', '', ''], 0]);
  eq('  joined, then finished with the song and the captions', cutWorld.calls.filter(c => c === 'join' || c === 'finish'), ['join', 'finish']);

  /* ---- the storyboard, while it draws */
  const slowWorld = fakeWorld({ historyFor: () => ({}) });
  const slow = L.createLongVideos({ base: 'http://comfy', dir, ...slowWorld, pollMs: 5, log: { warn() {}, log() {} } });
  let submitted = 0;
  slow.bind({ build: () => ({}), submit: async () => { submitted += 1; return 'p'; }, outputsOf });
  const drawing = slow.start({ count: 3, prompts: ['one', 'two', 'three'] });
  await new Promise(resolve => setTimeout(resolve, 30));
  eq('a segment not yet started can be rewritten while earlier ones draw', slow.setPrompt(drawing.id, 2, 'three, rewritten'), true);
  eq('  but not the one being drawn', slow.setPrompt(drawing.id, 0, 'too late'), false);
  eq('  and the rewrite is what it will be built from', slow.info(drawing.id).prompts, ['one', 'two', 'three, rewritten']);
  eq('stopping returns the prompt that is drawing, for ComfyUI to interrupt', slow.cancel(drawing.id), 'p');
  await drawing.done;
  eq('  and nothing after it is queued', [submitted, slow.status(drawing.id).state], [1, 'failed']);

  /* ---- a failure, with ComfyUI's words */
  const broken = L.createLongVideos({
    base: 'http://comfy', dir, ...fakeWorld({ historyFor: (id) => ({ [id]: { status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } }) }),
    pollMs: 1, log: { warn() {}, log() {} },
  });
  broken.bind({ build: () => ({}), submit: async () => 'bad', outputsOf });
  const failing = broken.start({ count: 2, prompts: ['a', 'b'] });
  await failing.done;
  eq('a failed segment fails the clip, saying why', broken.status(failing.id), { state: 'failed', error: 'CUDA out of memory' });

  /* ---- ComfyUI gone, not answering: it dies outright when a VRAM allocation fails
     mid-sample, so there is no error to read back -- the queue and the history both
     stop answering at once, and the clip used to sit in 'running' for ever. */
  const dead = L.createLongVideos({
    base: 'http://comfy', dir, ...fakeWorld(),
    withTimeout: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8188'); },
    pollMs: 1, silentMs: 20, log: { warn() {}, log() {} },
  });
  dead.bind({ build: () => ({}), submit: async () => 'gone', outputsOf });
  const orphaned = dead.start({ count: 2, prompts: ['a', 'b'] });
  await orphaned.done;
  eq('a ComfyUI that died mid-segment fails the clip rather than leaving it running for ever',
    dead.status(orphaned.id), { state: 'failed', error: 'ComfyUI stopped answering while segment 1 was being made' });
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------ the parts of a music video */

eq('segments land on whole bars of the song', [L.segmentSecondsForTempo(120), L.segmentSecondsForTempo(128), L.segmentSecondsForTempo(90)], [10, 9.375, 10.667]);
eq('  and there is no beat to land on without a tempo', L.segmentSecondsForTempo(0), null);
{
  const caps = L.lyricsToCaptions('[verse]\nfirst line\nsecond line\n\n[chorus]\nthird line', 100);
  eq('lyrics become captions, sections left out', caps.map(c => c.text), ['first line', 'second line', 'third line']);
  check('  spread over the part of the song that is sung', caps[0].start >= 5 && caps.at(-1).end <= 95 && caps.every((c, i) => i === 0 || c.start >= caps[i - 1].end), JSON.stringify(caps));
  const ass = L.captionsAss([{ start: 1.5, end: 3, text: '첫 줄 {x}' }], { width: 768, height: 768 });
  check('captions are an ASS file sized to the picture, in a font with Hangul', /PlayResX: 768/.test(ass) && /Style: Lyric,Malgun Gothic,45,/.test(ass), ass.slice(0, 400));
  check('  timed, faded in with a pop, and with override braces stripped from the words', /Dialogue: 0,0:00:01\.50,0:00:03\.00,Lyric,,0,0,0,,\{\\fad\(180,220\)/.test(ass) && /첫 줄 x$/m.test(ass));
}
{
  const V = await load('src/videoPrompt.js');
  eq('captions written under the timeline are taken out of it', V.splitCaptions('[0s-10s] a girl sings\nCAPTIONS:\n[1s-3s] 안녕\n[3s-5s] hello'),
    { timeline: '[0s-10s] a girl sings', captions: [{ start: 1, end: 3, text: '안녕' }, { start: 3, end: 5, text: 'hello' }] });
  eq('  and a prompt with none is left as it is', V.splitCaptions('[0s-5s] x').captions, []);
}
{
  const fade = L.joinArgs({ inputs: ['a.mp4', 'b.mp4', 'c.mp4'], output: 'o.mp4', cut: true, transition: 'fade', durations: [10, 10, 10] });
  const filter = fade[fade.indexOf('-filter_complex') + 1];
  check('shots cross-fade, each fade starting where the one before ends less the fade', /xfade=transition=fade:duration=0\.5:offset=9\.500\[vx1\]/.test(filter) && /xfade=transition=fade:duration=0\.5:offset=19\.000\[v\]/.test(filter), filter);
  check('  the sound with them', /acrossfade=d=0\.5\[ax1\]/.test(filter) && /acrossfade=d=0\.5\[a\]/.test(filter));
  const hard = L.joinArgs({ inputs: ['a.mp4', 'b.mp4'], output: 'o.mp4', cut: true, transition: 'none' });
  check('a hard cut trims nothing, since no frame repeats', /\[1:v\]trim=start=0\.000000/.test(hard[hard.indexOf('-filter_complex') + 1]));
  const finish = L.finishArgs({ input: 'j.mp4', output: 'o.mp4', soundtrack: 's.mp3', captionsFile: 'captions.ass', duration: 30 });
  eq('the song replaces the clip\'s sound, padded to the picture and cut at its end', [finish.includes('1:a'), finish.includes('apad'), finish[finish.indexOf('-t') + 1]], [true, true, '30.000']);
  check('  and captions are burnt in by a relative name', finish.includes('subtitles=captions.ass'));
  const copyOnly = L.finishArgs({ input: 'j.mp4', output: 'o.mp4', soundtrack: 's.mp3' });
  check('  without captions the picture is copied, not encoded again', copyOnly.join(' ').includes('-c:v copy'));
}

if (ffmpeg) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-mv-'));
  try {
    const clip = (i) => {
      const file = path.join(work, `c${i}.mp4`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=24:duration=2',
        '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 100}:duration=2`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { windowsHide: true });
      return file;
    };
    const inputs = [0, 1, 2].map(clip);
    const joined = path.join(work, 'joined.mp4');
    execFileSync('ffmpeg', L.joinArgs({ inputs, output: joined, cut: true, transition: 'fade', durations: [2, 2, 2], crf: 30 }), { windowsHide: true });
    const length = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', joined], { windowsHide: true }).toString());
    check('ffmpeg cross-fades three 2s shots into 5s: two half-second overlaps', Math.abs(length - 5) < 0.15, String(length));
    const song = path.join(work, 'song.mp3');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', song], { windowsHide: true });
    fs.writeFileSync(path.join(work, 'captions.ass'), L.captionsAss([{ start: 0.5, end: 2, text: '가사 테스트' }], { width: 160, height: 120 }));
    const out = path.join(work, 'mv.mp4');
    execFileSync('ffmpeg', L.finishArgs({ input: joined, output: out, soundtrack: song, captionsFile: 'captions.ass', duration: length, crf: 30 }), { windowsHide: true, cwd: work });
    const finalLength = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { windowsHide: true }).toString());
    check('  set to a 3s song, the finished clip is still as long as its picture', Math.abs(finalLength - length) < 0.15, `${finalLength} vs ${length}`);
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { windowsHide: true }).toString().trim().split(/\s+/);
    eq('  with a picture and a sound, and the captions burnt in without an error', streams.sort(), ['audio', 'video']);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/* ------------------------------------------- the graph: upscaling, unloading */

{
  const graph = build();
  const up = M.applyH3Upscale(graph, { available });
  eq('the workflow\'s own upscaler is switched on', [up.applied, graph[up.node].inputs.choice], [true, 'RTX VSR']);
  eq('  and left alone where its node is not installed', M.applyH3Upscale(build(), { available: new Set() }).reason, 'missing');
  const g = build();
  const removed = M.bypassUnloads(g);
  check('the unload nodes are taken out', removed.length === 4 && !Object.values(g).some(n => /Unload/.test(n.class_type)), removed.join(','));
  const dangling = Object.entries(g).flatMap(([id, n]) => Object.values(n.inputs || {}).filter(v => Array.isArray(v) && !g[v[0]]).map(v => `${id}->${v[0]}`));
  eq('  and everything that read through them reads what they passed on', dangling, []);
  const cutGraph = build();
  const unpinned = M.applyH3Segment(cutGraph, { segment: 1, count: 3, prompt: 'x', available: new Set() });
  check('a shot of a cut needs no node pack, being pinned to nothing', unpinned.applied && cutGraph[M.findH3Nodes(cutGraph).cond].class_type !== M.HYBRID_NODE);
}

/* ------------------------------------------------------- virtual memory, seen */

{
  const R = await load('server/resourceSafety.js');
  R.forgetCommit();
  const stats = await R.commitStats({ platform: 'win32', now: 5, run: (cmd, args, opts, done) => done(null, '81000000 20000000') });
  eq('commit is read as total, free and used', [stats.total, stats.free, stats.used], [81000000 * 1024, 20000000 * 1024, 61000000 * 1024]);
  R.forgetCommit();
  const Mon = await load('src/monitor.js');
  const alerts = Mon.alerts({ stats: { gpus: [], commit: { total: 100, used: 95, free: 5 } } });
  eq('and nearly gone, it is said', alerts.map(a => a.kind), ['commit']);
  eq('  not before', Mon.alerts({ stats: { gpus: [], commit: { total: 100, used: 50, free: 50 } } }).length, 0);
}

/* ------------------------------------------------------------ the wiring */

const studio = read('server/studio.js');
check('a clip past one pass is rendered as separate prompts, not chained in one graph',
  /if \(plan && \(canChain \|\| cut\) && plan\.count > 1\) \{/.test(studio) && /const long = longVideos\.start\(\{/.test(studio));
check('  built and queued by handlers bound once, so a resumed clip is built the same way', /longVideos\.bind\(\{/.test(studio) && /hold: \(\) => vram\.beginComfySubmission\(\),/.test(studio));
check('  resumed by the servers at startup, not by the routes tests create',
  /resumeLongVideos\(env\);/.test(read('server/index.js')) && /resumeLongVideos\(env\);/.test(read('vite.config.js')));
check('the job, the progress, the preview and the stop all follow the current segment',
  /if \(isLongId\(id\)\) \{\s*\n\s*const long = longVideos\.status\(id\);/.test(studio)
  && /const target = \(\) => \(isLongId\(id\) \? longVideos\.currentOf\(id\) : id\);/.test(studio)
  && /events\.preview\(isLongId\(asked\) \? longVideos\.currentOf\(asked\) : asked\)/.test(studio)
  && /id = longVideos\.cancel\(id\) \|\| id;/.test(studio));
check('the joined file is served from here, with ranges', /if \(url\.searchParams\.get\('type'\) === 'webui'\) \{/.test(studio) && /return serveFile\(req, res, file, 'video\/mp4'\);/.test(studio));
check('and the safeguard reads its frames from the segments ComfyUI kept', /const segments = longVideos\.segmentsOf\(body\.filename\);/.test(studio));
check('the storyboard, a rewrite and a redo are routes, for the account that made the clip',
  ['/studio/long-info', '/studio/long-prompt', '/studio/long-redo'].every(r => studio.includes(`route('${r}'`)) && /owner === identify\(req\)/.test(studio));
check('a song is taken by name from the music folder, never by path', /\/\^\[a-zA-Z0-9_-\]\+\\\.\(mp3\|wav\|flac\)\$\/\.test\(trackName\)/.test(studio));
check('models are kept loaded only with room to spare', /keepModels = Number\.isFinite\(left\) && left >= \(definition\.loadGB \+ 24\) \* 1024 \*\* 3;/.test(studio));

const app = read('src/App.jsx');
check('the browser budgets memory for one segment, so length no longer shrinks the picture', /frameBudgetArea\(plan\.seconds\),/.test(app));
check('  and the card says which segment is drawing', /const batch = state\.segments > 1 \? \{ n: state\.segment, of: state\.segments \} : null;/.test(app));
check('  and that it is running, when the queue says so', /\{ \.\.\.current, polled: state\.state, \.\.\.\(batch \? \{ batch \} : \{\}\) \}/.test(app));
check('the chat sets a video to the newest song and passes the MV options', /soundtrack: \{\s*\n\s*name: lastSong\.name,/.test(app) && /cut: String\(attrs\.cut \|\| ''\)\.toLowerCase\(\) === 'true',/.test(app));
check('  and a long clip shows its storyboard, in the answer and while drawing', (app.match(/<LongStoryboard/g) || []).length === 2);
check('  and a redone clip replaces the one in the conversation', /onNewVersion=\{\(output\) => replaceLongVideo\(currentSession\.id, i, n, output\)\}/.test(app));
const T = await load('src/tools.js');
eq('a native call carries the MV options into the tag, captions under the timeline',
  T.nativeCallToTag('generate_video', { prompt: '[0s-10s] x', soundtrack: 'last_song', cut: true, captions: '[1s-2s] hi', upscale: true }),
  '<TOOL_GENERATE_VIDEO from="none" soundtrack="last_song" cut="true" upscale="true">[0s-10s] x\nCAPTIONS:\n[1s-2s] hi</TOOL_GENERATE_VIDEO>');
const V2 = await load('src/videoPrompt.js');
check('the model is told how a music video is made: the song, then the video set to it', /generate_music[\s\S]{0,120}soundtrack="last_song" cut="true" captions="lyrics"/.test(V2.H3_GUIDE));
const panel = read('src/StudioPanel.jsx');
check('the Studio offers shots, a transition and the upscaler', /\{ cut: true, transition: form\.transition === 'none' \? 'none' : 'fade' \}/.test(panel) && /has\.upscale && form\.upscale \? \{ upscale: true \}/.test(panel));
check('the system monitor shows virtual memory', /label=\{t\('sysmon\.commit'\)\}/.test(read('src/SystemMonitor.jsx')) && /commit: await commitStats\(\)/.test(read('server/api.js')));
const i18n = read('src/i18n.jsx');
for (const key of ['storyboard.title', 'storyboard.redo', 'studio.cut', 'studio.upscale', 'sysmon.commit', 'sysmon.alertCommit']) {
  check(`${key} is translated everywhere`, (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length === 12);
}

/* ------------------------------------------------- the card, for a long clip

   Reported: the card sat at "queued" for the whole clip. It listens for its own
   id and stops at `done`; a segment reported under its ComfyUI id was dropped,
   and a segment finishing closed the stream minutes before the clip was done. */
{
  const S = await load('server/studio.js');
  const status = { state: 'running', segment: 3, segments: 12, phase: 'segments', current: 'p3' };
  const mid = S.asLong('long-abcdef', { id: 'p3', state: 'running', phase: 'sampling', fraction: 0.5, remainingMs: 60000, expectedMs: 120000 }, status);
  eq('a segment is reported under the clip\'s id, still running', [mid.id, mid.state, mid.phase], ['long-abcdef', 'running', 'sampling']);
  eq('  its progress spread over the whole clip', Math.round(mid.fraction * 1000) / 1000, Math.round((2.5 / 12) * 1000) / 1000);
  eq('  with the segments still to come in the time left', mid.remainingMs, 60000 + 9 * 120000);
  eq('  and which segment it is', [mid.segment, mid.segments], [3, 12]);
  eq('a segment finishing does not finish the clip', S.asLong('long-abcdef', { id: 'p3', state: 'done' }, status).state, 'running');
  eq('  but a segment failing fails it', S.asLong('long-abcdef', { id: 'p3', state: 'failed', error: 'x' }, status).state, 'failed');
  eq('joining is shown as saving', S.longSnapshot('long-abcdef', { state: 'running', segment: 12, segments: 12, phase: 'joining' }).phase, 'saving');
  eq('and the finished clip ends the card', S.longSnapshot('long-abcdef', { state: 'done' }).state, 'done');
  check('the stream re-labels every segment message', /isLongId\(id\) \? asLong\(id, snapshot\(job\), null, longVideos\)/.test(studio));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
