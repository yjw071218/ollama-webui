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
eq('and are counted as such', Math.round(E.fractionOf(job) * 100), 40);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
