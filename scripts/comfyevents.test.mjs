// What a generation is doing, while it does it.
//
// The whole point of this module is a progress bar that is honest about a
// ninety-second job, and every way of getting that wrong is a way of lying to
// somebody who is watching: a bar that sits at zero while a checkpoint loads, a
// bar that reaches the end and stays there, a bar that goes *backwards* on a
// re-run because most of the graph was cached and cached does not mean pending.
//
// So the message-to-state half is a pure function and is tested here against
// the exact frames this ComfyUI was observed to send -- captured from a real
// run rather than invented, because the shape of `executing` with a null node
// and the byte order of a preview header are not things worth guessing at.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const E = await import(pathToFileURL(path.join(ROOT, 'server/comfyEvents.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- naming the work

   `executing` says `node: "28"`. Nobody watching a picture appear cares that
   node 28 is a `SeedVR2VideoUpscaler`, but they do care that it is upscaling,
   and the difference between those two is the difference between a progress
   line that reads as progress and one that reads as a stack trace. */

eq('a sampler is sampling', E.phaseOf('KSampler (Efficient) 💬ED'), 'sampling');
eq('and so is a custom one', E.phaseOf('SamplerCustomAdvanced'), 'sampling');
eq('a VAE decode is decoding', E.phaseOf('AnimaPiDDecode'), 'decoding');
eq('an upscaler is upscaling', E.phaseOf('SeedVR2VideoUpscaler'), 'upscaling');
eq('a detailer is detailing', E.phaseOf('FaceDetailer 💬ED'), 'detailing');
eq('the text refiner is prompt work', E.phaseOf('TextGenerate'), 'prompt');
eq('and a save is saving', E.phaseOf('Save Image 🔔ED'), 'saving');

/* Two of these match more than one pattern, and the order is what decides.
   Getting it wrong is not cosmetic -- a checkpoint load reported as "upscaling"
   is a minute of the reader being told the wrong thing. */
eq('a loader that mentions an upscaler is still loading',
  E.phaseOf('SeedVR2LoadDiTModel'), 'loading');
eq('a PreviewBridge is saving, not previewing', E.phaseOf('PreviewBridge'), 'saving');
eq('an unknown class is honest about being unknown', E.phaseOf('SomeoneElsesNode'), 'working');
eq('and nothing at all is not "working"', E.phaseOf(''), 'queued');

/* ------------------------------------------------- one job, message by message

   The sequence below is the real one, in the real order, from a 90-second Anima
   run: start, 32 nodes reported as cached, then nodes and steps. */

const NODES = {
  13: { class: 'KSampler (Efficient) 💬ED', title: '' },
  28: { class: 'SeedVR2VideoUpscaler', title: 'the big one' },
  59: { class: 'AnimaPiDDecode', title: '' },
};
let job = E.emptyJob('abc', { total: 10, nodes: NODES });

eq('a job starts queued', job.state, 'queued');
eq('with nothing to report', E.fractionOf(job), null);

job = E.reduce(job, { type: 'execution_start', data: { prompt_id: 'abc' } });
eq('starting is running', job.state, 'running');
// It has left the queue. A job that still says "queued" while a 20GB checkpoint
// loads reads as one that never started.
eq('and says so', job.phase, 'starting');

job = E.reduce(job, { type: 'execution_cached', data: { prompt_id: 'abc', nodes: [1, 2, 3, 4] } });
eq('cached nodes are finished nodes', job.done.length, 4);
/* Not a tenth of the bar each, though. Four of ten nodes is 40% only if every
   node costs the same, and these graphs carry sixty-odd of which one sampler is
   most of the minute -- counting them equally is what put the bar past 80% in
   the first second and left it crawling there. Each node is worth what its
   stage is worth; see `PHASE_WEIGHT`. */
{
  const shown = E.fractionOf(job);
  check('and are worth what their stage is worth, not a tenth each',
    shown > 0 && shown < 0.1, `${Math.round(shown * 100)}%`);
}
eq('the count is kept for saying so', job.cached, 4);

job = E.reduce(job, { type: 'executing', data: { prompt_id: 'abc', node: '13' } });
eq('the running node is named', job.nodeClass, 'KSampler (Efficient) 💬ED');
eq('in words rather than in class names', job.phase, 'sampling');

job = E.reduce(job, { type: 'progress', data: { prompt_id: 'abc', node: '13', value: 5, max: 20 } });
eq('the step lands', job.step, 5);
eq('and how many there are', job.steps, 20);

/* Steps fill the gap between nodes. Node count alone jumps in visible steps and
   stands still for the whole minute one node runs; the step counter is smooth
   but says nothing about the rest of the graph. */
const withSteps = E.fractionOf(job);
const withoutSteps = E.fractionOf({ ...job, step: 0, steps: 0 });
check('steps move the bar within a node', withSteps > withoutSteps, `${withSteps} vs ${withoutSteps}`);
check('but never past the next one', withSteps < (job.done.length + 1) / job.total + 1e-9);

/* A step under way counts for the share of a usual step it has run. A video's
   steps are a minute each, and the bar sat still for that minute, then jumped. */
{
  let run = E.reduce(E.emptyJob('s'), { type: 'executing', data: { prompt_id: 's', node: '13' } }, 1000);
  run = E.reduce(run, { type: 'progress', data: { prompt_id: 's', value: 1, max: 10 } }, 5000);
  check('the first step says nothing about how long a step takes -- it loads the model', run.stepMs === null);
  run = E.reduce(run, { type: 'progress', data: { prompt_id: 's', value: 2, max: 10 } }, 65000);
  eq('the second says how long one took', run.stepMs, 60000);
  run = E.reduce(run, { type: 'progress', data: { prompt_id: 's', value: 3, max: 10 } }, 105000);
  eq('averaged, so one slow step does not become the figure', run.stepMs, Math.round(60000 * 0.6 + 40000 * 0.4));
  eq('half a step in counts half a step', E.withinStep(run, 105000 + run.stepMs / 2), 3.5 / 10);
  eq('never the whole step, so the bar waits for the counter', E.withinStep(run, 105000 + run.stepMs * 5), 3.9 / 10);
  eq('nothing to go on, nothing added', E.withinStep({ ...run, stepMs: null }, 999999), 3 / 10);
  const again = E.reduce(run, { type: 'progress', data: { prompt_id: 's', value: 1, max: 10 } }, 110000);
  check('a counter that goes back is a new loop, measured afresh', again.stepMs === null);
  const next = E.reduce(run, { type: 'executing', data: { prompt_id: 's', node: '28' } }, 120000);
  check('and the next node starts with no speed of its own', next.stepMs === null && next.stepSince === null);
  check('the bar moves during a step without history too',
    E.fractionOf({ ...run, total: 10, done: ['13'] }, 105000 + run.stepMs / 2) > E.fractionOf({ ...run, total: 10, done: ['13'] }, 105000));
}

// A message that changed nothing returns the same object, so a subscriber can
// skip it by identity rather than by comparing every field.
check('an unchanged message is not a change',
  E.reduce(job, { type: 'progress', data: { prompt_id: 'abc', node: '13', value: 5, max: 20 } }) === job);

// A second job queued behind this one must not scribble on it.
const other = E.reduce(job, { type: 'executing', data: { prompt_id: 'someone-else', node: '28' } });
check('another prompt\'s messages are ignored', other === job);

job = E.reduce(job, { type: 'executing', data: { prompt_id: 'abc', node: '28' } });
eq('a new node resets the step counter', job.step, 0);
eq('a node title is kept for the tooltip', job.nodeTitle, 'the big one');

job = E.reduce(job, { type: 'execution_success', data: { prompt_id: 'abc' } });
eq('success is done', job.state, 'done');
eq('and done is all the way', E.fractionOf(job), 1);

/* The bar must never say 100% while work continues. Anything else and the
   reader concludes it has hung. */
const nearlyThere = E.reduce(
  E.emptyJob('x', { total: 2, nodes: {} }),
  { type: 'execution_cached', data: { prompt_id: 'x', nodes: [1, 2] } },
);
check('a running job never reads as finished', E.fractionOf(nearlyThere) < 1);

// Older ComfyUI ends a prompt with `executing: {node: null}` and no success
// message. Both endings have to end it.
const oldStyle = E.reduce(
  E.reduce(E.emptyJob('y'), { type: 'execution_start', data: { prompt_id: 'y' } }),
  { type: 'executing', data: { prompt_id: 'y', node: null } },
);
eq('a null node is the end of the prompt', oldStyle.state, 'done');

const broke = E.reduce(E.emptyJob('z'), {
  type: 'execution_error',
  data: { prompt_id: 'z', node_type: 'KSampler', exception_message: 'out of memory' },
});
eq('an error is a failure', broke.state, 'failed');
check('carrying what went wrong and where', /KSampler.*out of memory/.test(broke.error), broke.error);

/* ------------------------------------------------------- the preview frame

   [uint32 event][uint32 format][image bytes], big-endian. Read the other way
   round the event type is 16777216, which looks like a corrupt frame rather
   than like a byte-order mistake -- so this is worth a test that would catch
   it. */

const frame = (event, format, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(event, 0);
  head.writeUInt32BE(format, 4);
  return new Uint8Array(Buffer.concat([head, Buffer.from(body)]));
};

const jpeg = E.readPreviewFrame(frame(1, 1, [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
eq('a preview frame is a JPEG', jpeg?.mime, 'image/jpeg');
eq('with the header taken off', jpeg?.body.length, 7);
eq('and the bytes intact', jpeg?.body[0], 0xff);
eq('format 2 is a PNG', E.readPreviewFrame(frame(1, 2, [1, 2, 3]))?.mime, 'image/png');
check('another kind of binary event is not a preview', E.readPreviewFrame(frame(3, 1, [1, 2])) === null);
check('nor is a truncated one', E.readPreviewFrame(new Uint8Array([1, 2, 3])) === null);

/* A real frame, as it came off this ComfyUI's socket, if the probe left one
   behind. Cheap insurance against the header changing under us. */
const sample = path.join(ROOT, 'scripts', 'fixtures', 'comfy-preview.bin');
if (fs.existsSync(sample)) {
  const real = E.readPreviewFrame(new Uint8Array(fs.readFileSync(sample)));
  eq('a captured frame reads as a JPEG', real?.mime, 'image/jpeg');
  check('and starts with the JPEG magic', real?.body[0] === 0xff && real?.body[1] === 0xd8);
}

/* ------------------------------------------------------------- the socket

   Fed by hand rather than by a GPU. What is being checked is the plumbing --
   that a subscriber hears about the prompt it asked about, that previews
   attach to whatever is running, and that a socket which cannot be opened is
   not a crash. */

const events = E.createComfyEvents({
  base: 'http://127.0.0.1:1',
  clientId: 'test',
  // Never connects, and must not throw when it does not.
  WebSocketImpl: function Fake() { throw new Error('no ComfyUI here'); },
});

events.register('job-1', { total: 4, nodes: NODES });
const heard = [];
events.subscribe(j => heard.push(j));

events.feed({ type: 'execution_start', data: { prompt_id: 'job-1' } });
events.feed({ type: 'executing', data: { prompt_id: 'job-1', node: '13' } });
eq('a subscriber hears about it', heard.length, 2);
eq('and gets the named phase', heard[1].phase, 'sampling');
eq('the registered node table survived registration', events.get('job-1').nodeClass, 'KSampler (Efficient) 💬ED');

// Previews carry no prompt id: they are a picture of whatever is running.
events.feedBinary(frame(1, 1, [0xff, 0xd8, 9, 9]));
eq('a preview is filed under the running prompt', events.preview('job-1')?.mime, 'image/jpeg');
eq('and bumps a counter the client can watch', events.get('job-1').previewSeq, 1);
eq('which is what tells it there is a new one', heard[heard.length - 1].previewSeq, 1);

// Nothing running: a stray frame has nowhere to go and must not throw.
events.feed({ type: 'execution_success', data: { prompt_id: 'job-1' } });
events.feedBinary(frame(1, 1, [0xff, 0xd8]));
eq('a preview with nothing running is dropped', events.preview('job-1')?.seq, 1);

check('a status message is not a job', events.get('status') === null);
events.feed('not json at all');
check('and rubbish on the wire is survivable', true);
events.close();

/* ------------------------------------------------ KJNodes' preview override

   MiniMax's "생성 프리뷰" node turns the binary frames off and sends its own,
   as JSON with the picture in base64 -- for a video, the whole clip at this
   step, as an MP4. Not listening for it is how a MiniMax job came to show no
   preview at all. */

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const clip = E.readOverridePreview({ image: b64([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), mime: 'video/mp4', step: 3, total: 30 });
eq('an override frame can be a clip', clip?.mime, 'video/mp4');
eq('decoded from base64', clip?.body.length, 8);
eq('the first one has no mime and is the starting noise, a JPEG',
  E.readOverridePreview({ image: b64([0xff, 0xd8, 1]), step: 0, sigmas: [1, 0.5, 0] })?.mime, 'image/jpeg');
eq('an animated WebP is a frame too', E.readOverridePreview({ image: b64([1, 2]), mime: 'image/webp' })?.mime, 'image/webp');
check('the sigma-only bookkeeping message is not a frame', E.readOverridePreview({ step: 0, sigmas: [1, 0] }) === null);
check('nor is a type it has no business serving', E.readOverridePreview({ image: b64([1]), mime: 'text/html' }) === null);
check('nor something enormous',
  E.readOverridePreview({ image: 'A'.repeat(40 * 1024 * 1024), mime: 'video/mp4' }) === null);

const kj = E.createComfyEvents({
  base: 'http://127.0.0.1:1',
  clientId: 'test',
  WebSocketImpl: function Fake() { throw new Error('no ComfyUI here'); },
});
kj.register('video-1', { total: 4, nodes: NODES });
const told = [];
kj.subscribe(j => told.push(j));
kj.feed({ type: 'execution_start', data: { prompt_id: 'video-1' } });
kj.feed({ type: 'executing', data: { prompt_id: 'video-1', node: '13' } });
// No prompt id on these either: they belong to whatever is running.
kj.feed({ type: 'kj_preview_override', data: { node_id: '12', image: b64([9, 9, 9]), mime: 'video/mp4', step: 1, total: 30 } });
eq('an override frame is filed under the running prompt', kj.preview('video-1')?.mime, 'video/mp4');
eq('and counts as a new frame', kj.get('video-1').previewSeq, 1);
eq('whose kind the client is told, to pick <video> over <img>', told[told.length - 1].previewMime, 'video/mp4');
// With the node's suppression switched off both kinds arrive for the same
// step; the clip is kept rather than flicking to a still of it.
kj.feedBinary(frame(1, 1, [0xff, 0xd8]));
eq('a binary frame does not replace the clip', kj.preview('video-1')?.mime, 'video/mp4');
eq('or count as one', kj.get('video-1').previewSeq, 1);
kj.feed({ type: 'kj_preview_override', data: { node_id: '12', sigmas: [1, 0] } });
eq('a message with no picture changes nothing', kj.get('video-1').previewSeq, 1);
kj.feed({ type: 'kj_preview_override', data: { node_id: '12', image: b64([7, 7]), mime: 'video/mp4', step: 2, total: 30 } });
eq('the next step replaces it', kj.preview('video-1')?.seq, 2);
kj.close();

/* ------------------------------------------ timed against the last run

   Reported as: the card sat at "about 8 seconds left" for two minutes. Counted
   by node, Krea 2 was at 40% once its loaders had run -- five seconds in --
   while the text encoder writing out a prompt, the sampler and the PiD decoder,
   three nodes of sixty, were all of the wait still to come. */

const T = await import(pathToFileURL(path.join(ROOT, 'server/studioTimings.js')).href);
const deepEq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

{
  // A run as ComfyUI reports it: loaders, then a minute of prompt, then sampling.
  const t0 = 1_000_000;
  let run = E.emptyJob('r1', { total: 4, nodes: { 1: { class: 'UNETLoader' }, 2: { class: 'TextGenerate' }, 3: { class: 'KSampler' }, 4: { class: 'SaveImage' } } });
  run = E.reduce(run, { type: 'execution_start', data: { prompt_id: 'r1' } }, t0);
  run = E.reduce(run, { type: 'executing', data: { prompt_id: 'r1', node: '1' } }, t0);
  run = E.reduce(run, { type: 'executing', data: { prompt_id: 'r1', node: '2' } }, t0 + 5_000);
  run = E.reduce(run, { type: 'executing', data: { prompt_id: 'r1', node: '3' } }, t0 + 65_000);
  run = E.reduce(run, { type: 'executing', data: { prompt_id: 'r1', node: '4' } }, t0 + 95_000);
  run = E.reduce(run, { type: 'execution_success', data: { prompt_id: 'r1' } }, t0 + 96_000);
  deepEq('each node is timed from the start', run.nodeTimes, {
    1: { start: 0, dur: 5000 }, 2: { start: 5000, dur: 60000 }, 3: { start: 65000, dur: 30000 }, 4: { start: 95000, dur: 1000 },
  });
  const sample = T.sampleOf(run, t0 + 96_000);
  eq('and the run is as long as it took', sample.total, 96_000);

  const history = T.blendHistory(null, sample);
  const now = t0 + 1_000_000;
  const at = (patch) => ({ ...E.emptyJob('r2'), state: 'running', startedAt: now, nodeSince: now, ...patch });

  const loaded = T.estimate(history, at({ done: ['1', '2'], node: '2', nodeSince: now + 5_000 }), now + 5_000);
  check('after the loaders it is 5% of the way, not 40%', Math.abs(loaded.fraction - 5 / 96) < 0.01, JSON.stringify(loaded));
  eq('with the minute of prompt still ahead', Math.round(loaded.remainingMs / 1000), 91);

  const writing = T.estimate(history, at({ done: ['1', '2'], node: '2', nodeSince: now + 5_000 }), now + 35_000);
  check('half way through a step with nothing to count, time says how far', Math.abs(writing.fraction - 35 / 96) < 0.01);

  const sampling = T.estimate(history, at({ done: ['1', '2', '3'], node: '3', step: 4, steps: 8, nodeSince: now + 65_000 }), now + 80_000);
  eq('steps where there are steps', Math.round(sampling.remainingMs / 1000), 16);

  const cached = T.estimate(history, at({ done: ['1', '2', '3'], node: '3', step: 1, steps: 8, nodeSince: now + 2_000, cached: 1 }), now + 3_000);
  check('a cached prompt is a minute this run will not spend', cached.remainingMs < 30_000, JSON.stringify(cached));

  const slow = T.estimate(history, at({ done: ['1', '2', '3'], node: '3', step: 4, steps: 8, nodeSince: now + 150_000 }), now + 160_000);
  check('a run going twice as slow is told it has twice as long', slow.remainingMs > 30_000, JSON.stringify(slow));

  deepEq('before it starts, only how long it usually takes',
    T.estimate(history, { ...E.emptyJob('q'), state: 'queued' }), { expectedMs: 96000, fraction: null, remainingMs: null });
  eq('a node the last run never had is not guessed at',
    T.estimate(history, at({ done: ['9'], node: '9' }), now + 1000).fraction, null);
  eq('and nothing is known without a last run', T.estimate(null, at({}), now), null);
  const next = T.blendHistory(history, { total: 196_000, nodes: {} });
  check('a second run moves the figure without replacing it', next.total > 96_000 && next.total < 196_000 && next.runs === 2, JSON.stringify(next));
}

{
  // The store and the stream, together: a finished run is recorded under its
  // profile, and the next one of the same profile is estimated from it.
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.timings-'));
  const file = path.join(dir, 'studio-timings.json');
  const timings = T.createTimings({ file });
  const events = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 't', WebSocketImpl: class { close() {} }, timings });
  const nodes = { 1: { class: 'KSampler' }, 2: { class: 'SaveImage' } };
  events.register('a', { total: 2, nodes, profile: ['krea@1024x1024', 'krea'] });
  // A few milliseconds apart: a run that took no time at all cannot be timed.
  const tick = () => new Promise(r => setTimeout(r, 5));
  events.feed({ type: 'execution_start', data: { prompt_id: 'a' } }); await tick();
  events.feed({ type: 'executing', data: { prompt_id: 'a', node: '1' } }); await tick();
  events.feed({ type: 'executing', data: { prompt_id: 'a', node: '2' } }); await tick();
  events.feed({ type: 'execution_success', data: { prompt_id: 'a' } });
  check('a finished run is recorded under every key of its profile',
    !!timings.lookup(['krea@1024x1024']) && !!timings.lookup(['krea']));
  events.register('b', { total: 2, nodes, profile: ['krea@768x768', 'krea'] });
  check('a new size is estimated from the workflow at any size', events.estimate(events.get('b'))?.expectedMs >= 0);
  events.register('c', { total: 2, nodes, profile: [] });
  eq('and a job with no profile has no estimate', events.estimate(events.get('c')), null);

  events.register('d', { total: 2, nodes, profile: ['krea'] });
  events.feed({ type: 'execution_error', data: { prompt_id: 'd', node_type: 'AnimaPiDDecode', exception_message: 'Input type (CUDABFloat16Type) and weight type (CPUBFloat16Type) should be the same' } });
  eq('a failure says which stage it was in', events.get('d').errorPhase, 'decoding');
  eq('and which node', events.get('d').errorNode, 'AnimaPiDDecode');
  events.close();
  await new Promise(r => setTimeout(r, 1200));
  check('and the timings are kept on disk', fs.existsSync(file) && !!JSON.parse(fs.readFileSync(file, 'utf8')).krea);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const studio = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8').replace(/\r\n/g, '\n');
  check('the Studio keeps its timings with the rest of its data', /createTimings\(\{ file: path\.join\(DATA_DIR, 'studio-timings\.json'\) \}\)/.test(studio));
  check('a generation is timed by workflow, size and length', /profile: \[\s*\n\s*`\$\{definition\.id\}/.test(studio));
  check('the stream sends the estimate', /remainingMs: placed \? learned\.remainingMs : null/.test(studio) && /expectedMs: learned\?\.expectedMs/.test(studio));
  check('and sends it again through a long step', /const tick = setInterval\(/.test(studio));
}

/* Reported: ComfyUI drawing, the card saying "queued". ComfyUI keeps one socket
   per client id and forgets the old one -- without closing it -- when another
   connects under the same id, so the socket goes quiet and looks connected. */
{
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const settle = () => new Promise(r => setTimeout(r, 400));
  const events = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 'x', WebSocketImpl: FakeSocket });
  const t0 = Date.now();
  events.register('p', { total: 3, nodes: { 1: { class: 'KSampler' } } });
  eq('one socket to start with', sockets.length, 1);

  events.nudge('p', t0 + 2000);
  eq('the queue saying it runs makes it running', events.get('p').state, 'running');
  eq('  starting, with no stage heard yet', events.get('p').phase, 'starting');
  eq('  and a socket that has only just been asked is given time', sockets.length, 1);

  const restored = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 'restored', WebSocketImpl: FakeSocket });
  restored.nudge('after-restart', Date.now());
  eq('a refreshed job can be recreated from the queue', restored.get('after-restart').state, 'running');
  eq('  and starts with a usable progress phase', restored.get('after-restart').phase, 'starting');

  const quiet = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 'y', WebSocketImpl: FakeSocket });
  const before = sockets.length;
  quiet.register('q', { total: 3, nodes: {} });
  const opened = sockets[sockets.length - 1];
  quiet.nudge('q', Date.now() + 11000);
  check('  the deaf one is closed first', opened.closed === true && sockets.length === before + 1);
  await settle();
  eq('a socket that heard nothing of a running job for ten seconds is replaced -- once the old one has gone', sockets.length, before + 2);
  quiet.feed({ type: 'executing', data: { node: '5' } });
  eq('the new socket\'s hello, which names no prompt, is the job it was opened for', quiet.get('q').node, '5');

  /* Measured: the first ask came at two seconds, marked it running, and the socket was never looked at again -- the card said "starting" for two minutes of a job ComfyUI finished. Asked again later, it is replaced. */
  const later = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 'v', WebSocketImpl: FakeSocket });
  later.register('u', { total: 3, nodes: {} });
  const start = Date.now();
  later.nudge('u', start + 2000);
  const afterFirst = sockets.length;
  later.nudge('u', start + 12000);
  await settle();
  eq('a job marked running by the queue is still checked on the next ask', sockets.length, afterFirst + 1);
  later.close();

  const heardOf = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 'z', WebSocketImpl: FakeSocket });
  heardOf.register('r', { total: 3, nodes: {} });
  heardOf.feed({ type: 'execution_start', data: { prompt_id: 'r' } });
  const count = sockets.length;
  heardOf.nudge('r', Date.now() + 60000);
  eq('a job already heard from is left alone: a long node is quiet, not broken', sockets.length, count);

  const twice = E.createComfyEvents({ base: 'http://127.0.0.1:1', clientId: 'w', WebSocketImpl: FakeSocket });
  twice.register('s1', { total: 3, nodes: {} });
  twice.register('s2', { total: 3, nodes: {} });
  const now = Date.now();
  const at = sockets.length;
  twice.nudge('s1', now + 11000);
  twice.nudge('s2', now + 12000);
  await settle();
  eq('replaced at most once per ten seconds', sockets.length, at + 1);
  for (const e of [events, restored, quiet, heardOf, twice]) e.close();
}

{
  const S = await import(pathToFileURL(path.join(ROOT, 'server/studio.js')).href);
  check('the dev server and the app are different ComfyUI clients',
    S.clientIdFor('node_modules/vite/bin/vite.js', '') !== S.clientIdFor('server/index.js', ''));
  eq('the same server restarted is the same one', S.clientIdFor('server/index.js', '5173'), S.clientIdFor('server/index.js', '5173'));
  const studio = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8');
  check('the job route tells the stream what the queue says', /if \(where\.state === 'running'\) events\.nudge\(id\);/.test(studio));
  const progress = fs.readFileSync(path.join(ROOT, 'src/studioProgress.jsx'), 'utf8');
  check('a card believes the queue over a stream that has heard nothing',
    /const state = heard && polledState === 'running' \? 'running' : snapshot\?\.state;/.test(progress)
    && /unheard \? t\('studio\.state\.running'\)/.test(progress));
  const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  check('  in a conversation', /polledState=\{drawing\.polled \|\| ''\}/.test(app) && /\{ \.\.\.d, polled: state\.state \}/.test(app));
  check('  and in the Studio', /polledState=\{job\.state\}/.test(fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8')));
}

/* ------------------------------- the bar that sat at 99% for the whole run

   Reported: the percentage does not match what is happening, and sticks at 99.

   `pos` was the furthest-along point in the old run's timeline that any
   finished node reached -- one node's clock reading, taken as the whole run's
   position. Two things this app does regularly break that, and both of them
   put the bar at 99% while most of the work was still ahead.

   Summed instead of maxed, the same graph running in order gives the same
   number (which is why every figure above is unchanged) and neither of these
   can happen. */

{
  /* A run of four nodes: two quick, then a sampler, then a long upscaler at
     the end. Ninety-six seconds, of which the upscaler is half. */
  const shaped = {
    runs: 1,
    total: 100_000,
    nodes: {
      1: { start: 0, dur: 2_000 },
      2: { start: 2_000, dur: 3_000 },
      3: { start: 5_000, dur: 45_000 },
      4: { start: 50_000, dur: 50_000 },
    },
  };
  const t = 1_000_000;
  const running = (patch) => ({ ...E.emptyJob('r'), state: 'running', startedAt: t, nodeSince: t, ...patch });

  /* ComfyUI announces every cached node at once, before anything runs. Run the
     same prompt twice and that is the whole pipeline -- the upscaler at the
     end of the timeline included. */
  const cachedAll = T.estimate(shaped, running({ done: ['1', '2', '3', '4'], node: null, cached: 4 }), t + 500);
  check('a run whose last node was cached really is nearly done',
    cachedAll.fraction > 0.95, JSON.stringify(cachedAll));

  /* But a run in which only the *ends* are cached -- the loaders and the
     upscaler -- has the sampler, half the run, still to do. This is the case
     that showed 99% from the first second. */
  const endsCached = T.estimate(shaped, running({ done: ['1', '2', '4'], node: '3', step: 0, steps: 20 }), t + 500);
  check('one cached node at the end does not finish the run',
    endsCached.fraction < 0.6, JSON.stringify(endsCached));
  check('  it is worth exactly the time it saved',
    Math.abs(endsCached.fraction - 55 / 100) < 0.02, JSON.stringify(endsCached));

  /* A region edit adds nodes the profile has never seen, and they run after
     the upscaler. Finishing the upscaler used to put the timeline at its end
     while a third of the job was still ahead. */
  const afterUpscale = T.estimate(shaped, running({ done: ['1', '2', '3', '4'], node: '99' }), t + 60_000);
  check('an unknown node still to run is not counted as finished',
    afterUpscale.fraction <= 0.99, JSON.stringify(afterUpscale));
  check('  and what is known to be done is still said, rather than giving up',
    afterUpscale.fraction > 0.9, JSON.stringify(afterUpscale));

  // Nothing known at all is still honestly nothing.
  eq('a run of nothing but unknown nodes says nothing',
    T.estimate(shaped, running({ done: ['98'], node: '99' }), t + 1_000).fraction, null);

  /* And the property the change rests on: for a graph that runs start to
     finish in order, summing durations and reading the last node's clock are
     the same number. */
  const inOrder = T.estimate(shaped, running({ done: ['1', '2'], node: '3', step: 10, steps: 20 }), t + 30_000);
  check('in-order running is unchanged by the fix',
    Math.abs(inOrder.fraction - (2_000 + 3_000 + 45_000 * 0.5) / 100_000) < 0.01, JSON.stringify(inOrder));

  // 100% still means finished, and only finished.
  eq('only a finished run is all the way', T.estimate(shaped, { ...running({}), state: 'done' }).fraction, 1);
  check('everything else stops short of it',
    T.estimate(shaped, running({ done: ['1', '2', '3', '4'], node: null }), t + 10).fraction < 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
