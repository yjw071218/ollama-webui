/**
 * What a generation is doing, while it does it.
 *
 * ## Why polling was not enough
 *
 * `/studio/job` asks ComfyUI's history whether a prompt has finished. That is
 * the right question at the end and the wrong one for the ninety seconds
 * before it, where the honest answer is "still going" and the reader is
 * watching a spinner that would look identical if the GPU had died. A
 * generation here is a minute of sampling, then a minute of upscaling, then a
 * detailer pass, and none of that is visible from the history endpoint until
 * all of it is over.
 *
 * ComfyUI already broadcasts the whole thing. `ws://…/ws?clientId=…` carries,
 * for the client id a prompt was queued under:
 *
 *   * `execution_start`, `executing` — which node is running now
 *   * `progress` — `value` of `max` within that node, so the sampler's steps
 *   * `execution_cached` — which nodes it skipped, which is most of a re-run
 *   * `executed` — a node produced an output
 *   * `execution_success` / `execution_error` — the end, and why
 *   * binary frames — the partly-denoised latent, as a small JPEG
 *   * `kj_preview_override` — the same, from KJNodes' preview node, which for
 *     a video is the whole clip as it stands at this step
 *
 * Measured against this install: 48 progress messages, 25 `executing`, and 22
 * previews totalling 0.7MB across a 90-second job. Small enough to forward
 * whole.
 *
 * ## The shape of this file
 *
 * One socket per server, not one per viewer: ComfyUI broadcasts per client id,
 * and every viewer of this app is watching the same ComfyUI. So the socket is
 * a singleton that keeps a small amount of state per prompt, and subscribers
 * read that state.
 *
 * `reduce` is separated from the socket and exported, because a state machine
 * that can only be exercised by having a GPU, a model and a running ComfyUI is
 * one that never gets exercised. The socket is thirty lines of plumbing around
 * it.
 */

import { estimate, sampleOf, withinStep } from './studioTimings.js';

export { withinStep };

/* The binary preview frame.
 *
 *     [uint32 event type][uint32 image format][image bytes]
 *
 * Event type 1 is a preview image; format 1 is JPEG and 2 is PNG. Both numbers
 * are big-endian, and reading them little-endian gives 16777216 — a number
 * that looks like a corrupt frame rather than like a byte-order mistake, which
 * is worth knowing before debugging it as one. */
const PREVIEW_IMAGE = 1;

export const readPreviewFrame = (bytes) => {
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset || 0, bytes.byteLength);
  if (view.byteLength < 9) return null;
  if (view.getUint32(0) !== PREVIEW_IMAGE) return null;
  const format = view.getUint32(4);
  if (format !== 1 && format !== 2) return null;
  return {
    mime: format === 1 ? 'image/jpeg' : 'image/png',
    body: Buffer.from(bytes.buffer ?? bytes, (bytes.byteOffset || 0) + 8, view.byteLength - 8),
  };
};

/* The other way a preview arrives: as text.
 *
 * KJNodes' `ModelPreviewOverrideKJ` -- the "생성 프리뷰" node in the MiniMax
 * workflow -- turns the binary frames off (`suppress_default_preview`) and
 * sends its own instead, as a JSON message of type `kj_preview_override` with
 * the picture base64-encoded in it. For a video model that picture is the
 * whole clip at the current step: a fragmented MP4 when the GPU can encode
 * one, an animated WebP when it cannot. So a MiniMax job used to produce no
 * preview here at all -- the binary frames were suppressed and the frames it
 * sent instead were not listened for -- and a four-minute video was four
 * minutes of an empty card.
 *
 * The first message of a run carries only the sigma schedule and a JPEG of
 * the starting noise, with no `mime`; that one is a JPEG. Anything without an
 * image is bookkeeping for the node's own widget and is not a frame. */
const OVERRIDE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
// A 512px, 120-frame clip is a few hundred kilobytes. Anything wildly past
// that is not a preview this app should be holding in memory.
const OVERRIDE_MAX_BYTES = 24 * 1024 * 1024;

export const readOverridePreview = (data) => {
  const image = typeof data?.image === 'string' ? data.image : '';
  if (!image) return null;
  const mime = data.mime ? String(data.mime) : 'image/jpeg';
  if (!OVERRIDE_MIMES.has(mime)) return null;
  // Base64 is four characters for three bytes; checked before decoding so an
  // enormous message is refused without being copied first.
  if (image.length * 0.75 > OVERRIDE_MAX_BYTES) return null;
  const body = Buffer.from(image, 'base64');
  if (!body.length) return null;
  return { mime, body };
};

/* --------------------------------------------------------- what a node is

   A class name is not something to put in front of a reader --
   `SeedVR2VideoUpscaler` and `AnimaPiDDecode` mean nothing to the person who
   typed a prompt. But the *kind* of work does, and there are only a handful of
   kinds. Matched on the name because that is all the graph carries, and
   ordered because several match more than one pattern: a `PreviewBridge` is
   saving, not previewing, and `SeedVR2LoadDiTModel` is loading despite the
   name saying upscaler. */

const PHASES = [
  [/Loader|LoadImage|UNETLoader|CLIPLoader|LoadQwen|LoadDiTModel|LoadVAEModel/i, 'loading'],
  [/TextGenerate|PromptFormatter|BooruTag|TIPO|Wildcard|CLIPTextEncode|StringConcat|SimpleText/i, 'prompt'],
  [/Detailer/i, 'detailing'],
  [/Upscal|SeedVR2Video|RTXVideo|ResShiftUpscale|ImageResize|ImageScale/i, 'upscaling'],
  [/FrameInterpolat|CreateVideo|GetVideoComponents/i, 'video'],
  [/KSampler|SamplerCustom|Sampler/i, 'sampling'],
  [/VAEDecode|PiDDecode|DecodeAudio/i, 'decoding'],
  [/SaveImage|SaveVideo|PreviewImage|PreviewBridge|Save Image|Image Comparer/i, 'saving'],
];

export const phaseOf = (className) => {
  const name = String(className || '');
  for (const [pattern, phase] of PHASES) if (pattern.test(name)) return phase;
  return name ? 'working' : 'queued';
};

/* The order these happen in.
 *
 * Not the order `PHASES` is written in — that one is sorted by how specific
 * each pattern is, because several classes match more than one. This is the
 * pipeline: load the models, build the prompt, sample, decode the latent, then
 * whatever post-processing the workflow carries, then write the file. */
export const PHASE_ORDER = [
  'loading', 'prompt', 'sampling', 'decoding', 'detailing', 'upscaling', 'video', 'saving',
];

/**
 * Which stages this particular job will go through.
 *
 * Read off the graph rather than assumed, because the three workflows here do
 * genuinely different things: Krea 2 has no face detailer, MiniMax assembles a
 * video and Anima does neither. A track showing stages a workflow will never
 * reach is worse than no track — it leaves a step unlit for ever and reads as
 * something having failed.
 *
 * This is what makes a percentage mean something. 89% with `upscaling` still
 * ahead is a minute away; 89% with only `saving` left is seconds.
 */
export const phasesOf = (nodes = {}) => {
  const present = new Set(Object.values(nodes).map(n => phaseOf(n?.class)));
  return PHASE_ORDER.filter(phase => present.has(phase));
};

/* ------------------------------------------------------------ the state

   One prompt's progress, as a plain object the SSE route can serialise. The
   preview buffer is kept out of it deliberately -- it is bytes, it changes far
   more often than the rest, and the route decides whether a given subscriber
   has seen it. */

export const emptyJob = (id, { total = 0, nodes = {} } = {}) => ({
  id,
  phases: phasesOf(nodes),
  state: 'queued',
  node: null,
  nodeClass: '',
  nodeTitle: '',
  phase: 'queued',
  step: 0,
  steps: 0,
  done: [],
  cached: 0,
  total,
  nodes,
  error: null,
  // The node that failed, and which stage that was -- see `reduce`.
  errorNode: '',
  errorPhase: '',
  startedAt: null,
  updatedAt: Date.now(),
  previewSeq: 0,
  // What the latest frame is -- `video/mp4` needs a <video>, not an <img>.
  previewMime: '',
  /* When each node ran, in ms from the start, and when the one running now
     began. What the next run of the same workflow is placed against; see
     server/studioTimings.js. */
  nodeTimes: {},
  nodeSince: null,
  /* When the step counter last moved, and how long a step has been taking:
     what lets a step of a minute -- a video's -- move the bar while it runs,
     rather than only when it ends. See `withinStep`. */
  stepSince: null,
  stepMs: null,
  // Which timings this job learns from and adds to, most specific first.
  profile: [],
});

/* The node that was running, closed at `now`: its start and how long it took. */
const closeNode = (job, now) => {
  if (!job.node || !job.nodeSince || !job.startedAt) return job.nodeTimes;
  return {
    ...job.nodeTimes,
    [job.node]: { start: job.nodeSince - job.startedAt, dur: Math.max(0, now - job.nodeSince) },
  };
};

/**
 * One websocket message, folded into one prompt's state.
 *
 * Returns a *new* object when something changed and the same one when nothing
 * did, so a subscriber can skip a message without comparing fields. Messages
 * for other prompts return the state untouched, which is how a second job
 * queued behind this one does not scribble on it.
 */
export const reduce = (job, message, now = Date.now()) => {
  const { type, data } = message || {};
  if (!type || !job) return job;
  // Every message that concerns a prompt names it. The ones that do not --
  // `status`, and the previews -- are handled elsewhere.
  if (data?.prompt_id && data.prompt_id !== job.id) return job;

  const next = (patch) => ({ ...job, ...patch, updatedAt: now });

  switch (type) {
    case 'execution_start':
      // 'starting' rather than leaving it at 'queued': it has left the queue,
      // and a job that says "queued" while it loads a 20GB checkpoint reads as
      // one that is not running at all.
      return next({ state: 'running', phase: 'starting', startedAt: now });

    case 'execution_cached': {
      // Skipped nodes are finished nodes as far as "how far along is this" is
      // concerned, and on a second run with one changed setting they are most
      // of the graph. Counting them as pending makes a job that is nearly done
      // report 10%.
      const skipped = (data?.nodes || []).map(String);
      return next({
        state: 'running',
        phase: job.phase === 'queued' ? 'starting' : job.phase,
        cached: skipped.length,
        done: [...new Set([...job.done, ...skipped])],
      });
    }

    case 'executing': {
      const node = data?.node === null || data?.node === undefined ? null : String(data.node);
      // `node: null` is how older ComfyUI says the prompt is over. Newer ones
      // send `execution_success` as well; treating both as the end means
      // neither version leaves a job stuck at 99%.
      if (node === null) {
        return next({ state: 'done', node: null, phase: 'saving', step: 0, steps: 0, nodeTimes: closeNode(job, now), nodeSince: null });
      }
      const className = job.nodes?.[node]?.class || '';
      return next({
        state: 'running',
        node,
        nodeClass: className,
        nodeTitle: job.nodes?.[node]?.title || '',
        phase: phaseOf(className),
        step: 0,
        steps: 0,
        stepSince: null,
        stepMs: null,
        done: job.done.includes(node) ? job.done : [...job.done, node],
        nodeTimes: closeNode(job, now),
        nodeSince: now,
        // Heard before `execution_start`, which a reconnect can miss.
        startedAt: job.startedAt || now,
      });
    }

    case 'progress': {
      const max = Number(data?.max) || 0;
      const value = Number(data?.value) || 0;
      if (value === job.step && max === job.steps) return job;
      /* A step's length, from the gap since the counter last moved --
         averaged, so one slow step (the first, which loads the model onto the
         card) does not become the figure. A counter that went back is a new
         loop in the same node, and starts again. */
      const grew = value > job.step && max === job.steps && job.stepSince;
      const sample = grew ? (now - job.stepSince) / (value - job.step) : null;
      const stepMs = value < job.step || max !== job.steps
        ? null
        : sample === null ? job.stepMs
          : Math.round(job.stepMs ? job.stepMs * 0.6 + sample * 0.4 : sample);
      return next({ state: 'running', step: value, steps: max, stepSince: now, stepMs });
    }

    case 'executed':
      return next({ state: 'running' });

    case 'execution_error':
      return next({
        state: 'failed',
        error: data?.exception_message
          ? `${data.node_type || 'a node'}: ${data.exception_message}`
          : 'the workflow failed in ComfyUI',
        // Which stage it stopped in, so the track can mark that one.
        errorNode: data?.node_type || job.nodeClass || '',
        errorPhase: data?.node_type ? phaseOf(data.node_type) : job.phase,
      });

    case 'execution_interrupted':
      return next({ state: 'failed', error: 'stopped', errorPhase: job.phase });

    case 'execution_success':
      return next({ state: 'done', node: null, phase: 'saving', nodeTimes: closeNode(job, now), nodeSince: null });

    default:
      return job;
  }
};

/* What each stage is worth, before this workflow has ever been timed.
 *
 * A prior, not a measurement. The measurement is what replaces it: once a run
 * has finished, `server/studioTimings.js` knows what every node in that graph
 * actually took and the bar is driven by that instead. This is only for the
 * first run of a workflow at a size -- and for the region edits and odd shapes
 * that keep producing profiles nothing has seen before.
 *
 * The numbers are relative, and only their ratios matter. What they encode is
 * the one fact that counting nodes misses: a graph of sixty nodes spends
 * almost all of its time in one of them. Loaders, text nodes, string joins and
 * switches are thousandths of a second each; a forty-step sampler is most of
 * the minute; an upscaler and a face detailer are most of the rest.
 */
export const PHASE_WEIGHT = {
  loading: 2,
  prompt: 0.2,
  sampling: 60,
  decoding: 3,
  detailing: 18,
  upscaling: 12,
  video: 10,
  saving: 1,
  working: 1,
  queued: 0.2,
};

const weightOf = (job, id) => PHASE_WEIGHT[phaseOf(job?.nodes?.[id]?.class)] ?? 1;

/** How far through, as a fraction, or null when there is nothing to go on. */
export const fractionOf = (job, now = Date.now()) => {
  if (!job || job.state === 'queued') return null;
  if (job.state === 'done') return 1;
  if (!job.total) return null;

  /* Two numbers, and the finer one wins where it exists. Stage weight moves in
     jumps and says nothing while one node runs for a minute; the step counter
     is smooth but only covers the node it belongs to. So the finished nodes
     set the floor and the current node's steps fill its own share of the gap.

     Weighted rather than counted: see `PHASE_WEIGHT`. Counting nodes equally
     is what put the bar at 85% in the first second of a run and left it there. */
  const nodes = job.nodes && Object.keys(job.nodes).length ? job.nodes : null;
  let total = 0;
  let doneWeight = 0;
  if (nodes) {
    for (const id of Object.keys(nodes)) total += weightOf(job, id);
    for (const id of job.done || []) {
      if (id === job.node) continue;
      doneWeight += weightOf(job, id);
    }
  } else {
    // No graph to weigh -- the shape this had before, and still correct when
    // the classes are not known.
    total = job.total;
    doneWeight = Math.min(job.done.length, job.total);
  }
  if (!(total > 0)) return null;

  const base = doneWeight / total;
  /* A node with no step counter is credited nothing while it runs.
   *
   * Crediting it a share of itself sounds kinder and makes the bar go
   * backwards: half of a node is more than the quarter its fifth step is
   * worth, so the first `progress` message would pull the bar down. A bar that
   * retreats is worse than one that pauses, and the pause is what this did
   * before -- the weighting above is the fix, not this. */
  if (!job.steps) return Math.min(base, 0.99);
  const mine = nodes && job.node ? weightOf(job, job.node) : 1;
  return Math.min(base + (mine / total) * withinStep(job, now), 0.99);
};

/* ------------------------------------------------------------- the socket */

const RETRY_MS = 3000;
const KEEP_JOBS = 8;
// How long a running job can go unheard of before the socket is assumed deaf.
const SILENT_MS = 10000;

/**
 * One connection to ComfyUI, shared by everything that wants to watch.
 *
 * Opens lazily -- an app whose owner never uses the Studio should not hold a
 * socket open to a ComfyUI that may not be running -- and reconnects on its
 * own, because ComfyUI restarts are a normal part of installing a node and a
 * dead socket that stays dead means the progress bar never works again until
 * this app is restarted too.
 */
export const createComfyEvents = ({ base, clientId, WebSocketImpl = globalThis.WebSocket, log = () => {}, timings = null }) => {
  const jobs = new Map();
  const listeners = new Set();
  const previews = new Map();          // prompt id -> { mime, body, seq }
  const overridden = new Set();        // prompt ids that have sent a KJ frame
  let socket = null;
  let retry = null;
  let closed = false;
  let current = null;                  // which prompt the binary frames belong to
  let reconnectedAt = 0;               // when a silent socket was last replaced -- see `nudge`

  const announce = (id) => {
    const job = jobs.get(id);
    if (!job) return;
    for (const listener of listeners) {
      try { listener(job); } catch (e) { /* a broken subscriber is not our problem */ }
    }
  };

  const forget = () => {
    while (jobs.size > KEEP_JOBS) {
      const oldest = [...jobs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      jobs.delete(oldest[0]);
      previews.delete(oldest[0]);
      overridden.delete(oldest[0]);
    }
  };

  /* One frame, filed under whichever prompt is running. Previews carry no
     prompt id -- they are a picture of whatever is being denoised right now --
     so they go to the prompt the last text message named, which is right
     because ComfyUI runs one prompt at a time. */
  const attach = (frame, { override = false } = {}) => {
    if (!frame || !current || frame.body.byteLength > OVERRIDE_MAX_BYTES) return;
    let retained = frame.body.byteLength;
    for (const [id, preview] of [...previews].reverse()) {
      if (id === current) continue;
      retained += preview.body.byteLength;
      if (retained > 32 * 1024 * 1024) previews.delete(id);
    }
    /* A job whose override node is sending frames ignores the binary ones.
       With the node's suppression on there are none; with it off, both arrive
       for the same step and the card would flick between the moving clip and
       a single still of it. The clip is the better picture. */
    if (override) overridden.add(current);
    else if (overridden.has(current)) return;
    const seq = (previews.get(current)?.seq || 0) + 1;
    previews.set(current, { ...frame, seq });
    const job = jobs.get(current);
    if (!job) return;
    jobs.set(current, { ...job, previewSeq: seq, previewMime: frame.mime, updatedAt: Date.now() });
    announce(current);
  };

  const onText = (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch (e) { return; }
    if (message?.type === 'status') return;
    if (message?.type === 'kj_preview_override') {
      attach(readOverridePreview(message.data), { override: true });
      return;
    }

    /* A fresh socket is told which node is running, with no prompt named --
       ComfyUI's hello to a client whose prompt is executing. It is the job
       this socket was reopened for. */
    if (message?.type === 'executing' && message.data && !message.data.prompt_id
      && message.data.node !== null && message.data.node !== undefined && current) {
      message.data = { ...message.data, prompt_id: current };
    }

    const id = message?.data?.prompt_id;
    if (id) {
      current = message.type === 'execution_success' || message.type === 'execution_error' ? null : id;
      if (!jobs.has(id)) jobs.set(id, emptyJob(id));
    }
    if (!id) return;

    const before = jobs.get(id);
    const reduced = reduce(before, message);
    // Heard from, whether or not it changed anything -- what `nudge` goes by.
    const after = { ...reduced, heardAt: Date.now() };
    jobs.set(id, after);
    if (reduced === before) return;
    // A run that finished is what the next one of its kind is timed against.
    if (after.state === 'done' && before.state !== 'done' && timings && after.profile?.length) {
      timings.record(after.profile, sampleOf(after, after.updatedAt));
    }
    forget();
    announce(id);
  };

  const onBinary = (bytes) => attach(readPreviewFrame(bytes));

  const connect = () => {
    if (closed || socket) return;
    const url = `${String(base).replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
    let ws;
    try { ws = new WebSocketImpl(url); } catch (e) { schedule(); return; }
    ws.binaryType = 'arraybuffer';
    socket = ws;

    ws.onopen = () => log(`watching ComfyUI at ${url}`);
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onText(e.data);
      else onBinary(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
    };
    ws.onerror = () => { /* onclose follows, and that is where the retry lives */ };
    ws.onclose = () => { socket = null; schedule(); };
  };

  /* Replace a socket that is open and hears nothing. ComfyUI gives a client id
     one socket, and forgets it without closing it when another connects under
     the same id -- so from here it looks connected and simply goes quiet. */
  const reconnect = () => {
    if (closed) return;
    const old = socket;
    socket = null;
    if (retry) { clearTimeout(retry); retry = null; }
    if (!old) { connect(); return; }
    /* The new one only once the old one has gone. ComfyUI forgets a client id
       when any socket of it closes -- whichever socket is registered by then --
       so a new socket opened first was forgotten the moment the old one's close
       reached it, and was as deaf as the one it replaced. */
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      const later = setTimeout(connect, 250);
      later.unref?.();
    };
    old.onmessage = null;
    old.onclose = next;
    const fallback = setTimeout(next, 1500);
    fallback.unref?.();
    try { old.close(); } catch (e) { next(); }
  };

  const schedule = () => {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, RETRY_MS);
    // A reconnect timer must never be the reason the process cannot exit.
    retry.unref?.();
  };

  return {
    /**
     * Start watching, and say what a prompt's nodes are so progress can be
     * named. `profile` is which timings it is measured against and adds to --
     * see server/studioTimings.js.
     */
    register(id, { total, nodes, profile = [] }) {
      connect();
      const existing = jobs.get(id);
      /* `total` and `nodes` are re-applied over `existing` because a job can be
         heard about before it is registered: ComfyUI starts broadcasting the
         moment it accepts the prompt, which is often before this call returns.
         The phases go the same way, and for the same reason. */
      jobs.set(id, {
        ...emptyJob(id, { total, nodes }),
        ...(existing || {}),
        total,
        nodes,
        phases: phasesOf(nodes),
        profile,
        registeredAt: Date.now(),
      });
      forget();
      return jobs.get(id);
    },
    /**
     * ComfyUI's queue says `id` is running. Called by whoever asked it.
     *
     * Reported: ComfyUI drawing away while the card said "queued". The socket
     * had gone quiet -- see `reconnect` -- and a card fed only by it waits for
     * ever. So what the queue says is believed: a job still "queued" here is
     * marked running, and if nothing at all has been heard about it for
     * SILENT_MS the socket is replaced, at most once per SILENT_MS. A job
     * already heard from is left alone: a node can run for a minute without a
     * word, and that is not a broken socket.
     */
    nudge(id, now = Date.now()) {
      let job = jobs.get(id);
      // A browser can reconnect after this process restarted, so the websocket
      // may not have heard the prompt's start. The queue is authoritative for
      // whether it is running; create a minimal state so the SSE subscriber
      // still receives a live snapshot and future websocket messages can fill
      // in the detailed progress.
      if (!job) {
        job = emptyJob(id);
        jobs.set(id, job);
        forget();
      }
      if (job.state === 'done' || job.state === 'failed') return;
      if (job.state === 'queued') {
        // ComfyUI runs one prompt at a time, and the queue says it is this one.
        current = id;
        job = {
          ...job,
          state: 'running',
          phase: job.phase === 'queued' ? 'starting' : job.phase,
          startedAt: job.startedAt || now,
          updatedAt: now,
          registeredAt: job.registeredAt || now,
        };
        jobs.set(id, job);
        announce(id);
      }
      /* Whatever state it was put in above, it has still not been *heard*:
         `heardAt` is only ever set by the socket. Asked again and again while
         the job runs, so a socket that was given its ten seconds on the first
         ask is looked at again on the next. */
      if (!job.heardAt && now - (job.registeredAt || now) >= SILENT_MS && now - reconnectedAt >= SILENT_MS) {
        current = id;
        reconnectedAt = now;
        log('ComfyUI is running a job this socket has not heard about; reconnecting');
        reconnect();
      }
    },
    /* Open the socket, if it is not open, before a prompt is queued: ComfyUI
       tells only the sockets it has at the moment it speaks, and a job it
       starts at once was otherwise half over by the time `register` opened one. */
    open() { connect(); },
    get(id) { return jobs.get(id) || null; },
    /** How far along a job is and how long it has left, from earlier runs; null with none. */
    estimate(job, now = Date.now()) {
      if (!timings || !job?.profile?.length) return null;
      return estimate(timings.lookup(job.profile), job, now);
    },
    preview(id) { return previews.get(id) || null; },
    subscribe(listener) {
      connect();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** For tests, and for a clean shutdown. */
    feed(message) { onText(typeof message === 'string' ? message : JSON.stringify(message)); },
    feedBinary(bytes) { onBinary(bytes); },
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      try { socket?.close(); } catch (e) { /* already gone */ }
      socket = null;
      listeners.clear();
      jobs.clear();
      previews.clear();
      overridden.clear();
    },
  };
};
