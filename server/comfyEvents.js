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
  startedAt: null,
  updatedAt: Date.now(),
  previewSeq: 0,
  // What the latest frame is -- `video/mp4` needs a <video>, not an <img>.
  previewMime: '',
});

/**
 * One websocket message, folded into one prompt's state.
 *
 * Returns a *new* object when something changed and the same one when nothing
 * did, so a subscriber can skip a message without comparing fields. Messages
 * for other prompts return the state untouched, which is how a second job
 * queued behind this one does not scribble on it.
 */
export const reduce = (job, message) => {
  const { type, data } = message || {};
  if (!type || !job) return job;
  // Every message that concerns a prompt names it. The ones that do not --
  // `status`, and the previews -- are handled elsewhere.
  if (data?.prompt_id && data.prompt_id !== job.id) return job;

  const now = Date.now();
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
      if (node === null) return next({ state: 'done', node: null, phase: 'saving', step: 0, steps: 0 });
      const className = job.nodes?.[node]?.class || '';
      return next({
        state: 'running',
        node,
        nodeClass: className,
        nodeTitle: job.nodes?.[node]?.title || '',
        phase: phaseOf(className),
        step: 0,
        steps: 0,
        done: job.done.includes(node) ? job.done : [...job.done, node],
      });
    }

    case 'progress': {
      const max = Number(data?.max) || 0;
      const value = Number(data?.value) || 0;
      if (value === job.step && max === job.steps) return job;
      return next({ state: 'running', step: value, steps: max });
    }

    case 'executed':
      return next({ state: 'running' });

    case 'execution_error':
      return next({
        state: 'failed',
        error: data?.exception_message
          ? `${data.node_type || 'a node'}: ${data.exception_message}`
          : 'the workflow failed in ComfyUI',
      });

    case 'execution_interrupted':
      return next({ state: 'failed', error: 'stopped' });

    case 'execution_success':
      return next({ state: 'done', node: null, phase: 'saving' });

    default:
      return job;
  }
};

/** How far through, as a fraction, or null when there is nothing to go on. */
export const fractionOf = (job) => {
  if (!job || job.state === 'queued') return null;
  if (job.state === 'done') return 1;
  /* Two numbers, and the finer one wins where it exists. Node count moves in
     visible jumps and is meaningless while one node runs for a minute; the
     step counter is smooth but only covers the node it belongs to. So node
     progress sets the floor and the current node's steps fill the gap to the
     next one. */
  if (!job.total) return null;
  const finished = Math.min(job.done.length, job.total);
  const base = finished / job.total;
  if (!job.steps) return Math.min(base, 0.99);
  const slice = (1 / job.total) * (job.step / job.steps);
  return Math.min(base + slice, 0.99);
};

/* ------------------------------------------------------------- the socket */

const RETRY_MS = 3000;
const KEEP_JOBS = 8;

/**
 * One connection to ComfyUI, shared by everything that wants to watch.
 *
 * Opens lazily -- an app whose owner never uses the Studio should not hold a
 * socket open to a ComfyUI that may not be running -- and reconnects on its
 * own, because ComfyUI restarts are a normal part of installing a node and a
 * dead socket that stays dead means the progress bar never works again until
 * this app is restarted too.
 */
export const createComfyEvents = ({ base, clientId, WebSocketImpl = globalThis.WebSocket, log = () => {} }) => {
  const jobs = new Map();
  const listeners = new Set();
  const previews = new Map();          // prompt id -> { mime, body, seq }
  const overridden = new Set();        // prompt ids that have sent a KJ frame
  let socket = null;
  let retry = null;
  let closed = false;
  let current = null;                  // which prompt the binary frames belong to

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
    if (!frame || !current) return;
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

    const id = message?.data?.prompt_id;
    if (id) {
      current = message.type === 'execution_success' || message.type === 'execution_error' ? null : id;
      if (!jobs.has(id)) jobs.set(id, emptyJob(id));
    }
    if (!id) return;

    const before = jobs.get(id);
    const after = reduce(before, message);
    if (after === before) return;
    jobs.set(id, after);
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

  const schedule = () => {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = null; connect(); }, RETRY_MS);
    // A reconnect timer must never be the reason the process cannot exit.
    retry.unref?.();
  };

  return {
    /** Start watching, and say what a prompt's nodes are so progress can be named. */
    register(id, { total, nodes }) {
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
      });
      forget();
      return jobs.get(id);
    },
    get(id) { return jobs.get(id) || null; },
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
    },
  };
};
