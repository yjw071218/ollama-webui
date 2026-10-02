/**
 * Long clips and looping clips, out of a model that makes five seconds.
 *
 * ## What MiniMax H3 will actually do
 *
 * Its own tooltip says it: "trained range is ~124-362" frames at 24 fps -- five
 * to fifteen seconds. The input accepts 3600, and a minute asked for in one pass
 * is a minute of drift: the room changes, the character's face wanders, the
 * sound stops matching. So a long clip here is *segments*, each inside the range
 * the model was trained on, joined so that nothing between them moves.
 *
 * ## What joins them
 *
 * `MiniMaxH3HybridRefAndKeyframe` from the `minimax-h3-hybrid-cond` node pack,
 * which is the one thing that makes this possible: it puts a first/last keyframe
 * pin *and* the reference pictures in one conditioning payload. The stock nodes
 * are one or the other -- pin the frame and lose the character, or keep the
 * character and have every segment start somewhere new -- and the pack's own
 * README says not to try wiring both of the stock nodes into one sample.
 *
 * So segment N is pinned at frame 0 to the last frame segment N-1 actually
 * produced, and every segment still carries the reference picture. Continuity
 * from the pin, identity from the reference.
 *
 * ## And what makes a loop a loop
 *
 * The same pin at both ends: first frame and last frame are the same picture, so
 * the clip arrives back where it started, which is what a Live2D idle does. Two
 * details decide whether it actually loops or merely nearly loops:
 *
 * - The picture is scaled to the clip's exact size first. The node resizes the
 *   first frame by stretching and the last by centre-cropping, and a picture
 *   whose aspect is a few pixels off the clip's would therefore be pinned to two
 *   *slightly different* images -- a flinch at the seam that is very hard to see
 *   and impossible to un-see.
 * - The first frame is dropped from what is saved. Frame 0 and the last frame
 *   are the same picture by construction, so a player looping the file shows it
 *   twice: one stutter per lap. Dropping the first leaves the last one to be
 *   frame 0 of the next lap.
 *
 * Everything here works on the API-format graph, after `buildPrompt`, and every
 * function is pure: give it a graph and it gives back what changed. The reason
 * is that none of this can be checked by looking at the result -- a seam that
 * stutters and a chain that drifts both look like "the model did that".
 */

/* The node pack. Absent, everything here reports itself rather than building a
   graph that ComfyUI will refuse forty seconds later. */
export const HYBRID_NODE = 'MiniMaxH3HybridRefAndKeyframe';

/* One definition of how a clip is cut up, shared with the browser: it needs the
   segment length to size the picture (a segment's cost, not the whole clip's)
   and this needs it to build the segments. */
export { SEGMENT_SECONDS, segmentPlan } from '../src/videoPrompt.js';
import { SEGMENT_SECONDS, segmentPlan } from '../src/videoPrompt.js';

/**
 * The node ids a transform needs, found by what they are rather than by number.
 *
 * The workflow is a file somebody exports from ComfyUI and re-exports when they
 * change it, so `_meta.source` numbers move. What does not move is that there is
 * exactly one conditioning node, one sampler, one video decode and one audio
 * decode in it.
 */
export const findH3Nodes = (graph) => {
  const byClass = (...names) => Object.keys(graph)
    .filter(id => names.includes(graph[id]?.class_type));
  const [cond] = byClass('MiniMaxH3ReferenceToVideo', 'MiniMaxH3ImageToVideo', HYBRID_NODE);
  const [sampler] = byClass('SamplerCustomAdvanced');
  const [decode] = byClass('VAEDecode');
  const [decodeAudio] = byClass('VAEDecodeAudio');
  const [noise] = byClass('RandomNoise');
  return { cond, sampler, decode, decodeAudio, noise };
};

/**
 * Every input that is a link to `[fromId, slot]`, rewired to `to`.
 *
 * `only` is the set of nodes that existed before the transform started, and it
 * is not optional in spirit: the parts built to *make* `to` -- the batch joins,
 * the frame the next segment opens on -- read from `fromId` on purpose, and
 * rewiring those points them at their own output. ComfyUI's answer to a graph
 * with a cycle in it is to hang, having said nothing.
 */
export const rewire = (graph, fromId, slot, to, { except = [], only = null } = {}) => {
  let moved = 0;
  for (const [id, node] of Object.entries(graph)) {
    if (id === to[0] || except.includes(id)) continue;
    if (only && !only.has(id)) continue;
    for (const [name, value] of Object.entries(node.inputs || {})) {
      if (Array.isArray(value) && String(value[0]) === String(fromId) && Number(value[1]) === Number(slot)) {
        node.inputs[name] = to;
        moved += 1;
      }
    }
  }
  return moved;
};

/** A node id nothing else is using. */
const freeId = (graph) => {
  const used = Object.keys(graph).map(Number).filter(Number.isFinite);
  return String((used.length ? Math.max(...used) : 0) + 1);
};

const addNode = (graph, class_type, inputs, title) => {
  const id = freeId(graph);
  graph[id] = { class_type, inputs, _meta: { title: title || class_type } };
  return id;
};

/** A deep copy of one node, with the same links. */
const copyNode = (graph, id, title) => {
  const source = graph[id];
  const copy = JSON.parse(JSON.stringify(source));
  copy._meta = { ...(copy._meta || {}), title: title || copy._meta?.title || '' };
  // Not the editor id: two nodes claiming to be node 16 makes `findNode` -- and
  // anything reading settings back out of the graph -- pick one at random.
  delete copy._meta.source;
  const newId = freeId(graph);
  graph[newId] = copy;
  return newId;
};

/**
 * Turn the conditioning node into the hybrid one, and give it its keyframes.
 *
 * The inputs are the same names on both nodes -- clip, vae, audio_vae, prompt,
 * width, height, length, ref_image_size, `ref_images.ref_image_0` -- which is
 * why this is a change of `class_type` and two new inputs rather than a rebuild.
 */
const asHybrid = (graph, id, { first, last }) => {
  const node = graph[id];
  node.class_type = HYBRID_NODE;
  /* Every one of its required inputs, including the one that only ever exists
     as a widget: `also_ref_first_frame` is declared with a default, which makes
     it optional in the editor and required over the API. ComfyUI refuses the
     whole prompt for it -- "Required input is missing" -- and refuses it at
     submission, which is the good case; leaving it out is a feature that never
     ran once. False is the behaviour that was there before: the first frame is
     a keyframe, not another <Picture N>. */
  if (node.inputs.also_ref_first_frame === undefined) node.inputs.also_ref_first_frame = false;
  if (first) node.inputs.first_frame = first;
  else delete node.inputs.first_frame;
  if (last) node.inputs.last_frame = last;
  else delete node.inputs.last_frame;
  return node;
};

/**
 * A clip that ends where it began.
 *
 * Needs a picture: a loop is pinned to a frame, and without one there is nothing
 * to pin it to. Returns `{ applied: false, reason }` rather than throwing, so a
 * request that cannot be honoured is reported before the GPU is spent.
 */
export const applyH3Loop = (graph, { available = null } = {}) => {
  if (available && !available.has(HYBRID_NODE)) {
    return { applied: false, reason: 'missing', missing: [HYBRID_NODE] };
  }
  const { cond, decode } = findH3Nodes(graph);
  if (!cond || !decode) return { applied: false, reason: 'shape' };

  const node = graph[cond];
  const reference = node.inputs['ref_images.ref_image_0'];
  if (!Array.isArray(reference)) return { applied: false, reason: 'noReference' };

  // Who was reading the decoded frames before this function added anything.
  const before = new Set(Object.keys(graph));

  /* The picture at exactly the clip's size, so both pins are the same pixels.
     Centre-cropped, because that is what the node does to the last frame, and
     the two have to agree. */
  const scaled = addNode(graph, 'ImageScale', {
    image: reference,
    upscale_method: 'lanczos',
    width: node.inputs.width,
    height: node.inputs.height,
    crop: 'center',
  }, 'Loop keyframe');

  asHybrid(graph, cond, { first: [scaled, 0], last: [scaled, 0] });

  /* The duplicate frame, dropped -- see the note at the top. The first rather
     than the last, because dropping the first needs no arithmetic: `length` is
     clamped to what is there, so 4096 means "the rest". */
  const trimmed = addNode(graph, 'ImageFromBatch', {
    image: [decode, 0], batch_index: 1, length: 4096,
  }, 'Drop the repeated frame');
  rewire(graph, decode, 0, [trimmed, 0], { except: [trimmed], only: before });

  return { applied: true, kind: 'loop', dropped: 1 };
};

/**
 * One clip made of several, each pinned to the last frame of the one before.
 *
 * `prompts` is one prompt per segment; a shorter list repeats its last entry,
 * so a caller with nothing to say per segment can pass one.
 *
 * `loop: true` additionally pins the final segment's last frame back to the
 * opening picture, which is a long idle animation rather than a five-second one.
 */
export const applyH3Chain = (graph, { segments = 2, prompts = [], loop = false, available = null } = {}) => {
  const count = Math.max(1, Math.round(Number(segments) || 1));
  if (count === 1) return loop ? applyH3Loop(graph, { available }) : { applied: false, reason: 'single' };
  if (available && !available.has(HYBRID_NODE)) {
    return { applied: false, reason: 'missing', missing: [HYBRID_NODE] };
  }

  const first = findH3Nodes(graph);
  if (!first.cond || !first.sampler || !first.decode || !first.decodeAudio || !first.noise) {
    return { applied: false, reason: 'shape' };
  }

  /* The graph as it arrived. Only these are rewired at the end -- see `rewire`:
     the segments built below read the first segment's decode deliberately. */
  const before = new Set(Object.keys(graph));

  const condNode = graph[first.cond];
  const reference = condNode.inputs['ref_images.ref_image_0'];
  const samplerNode = graph[first.sampler];
  const guiderLink = samplerNode.inputs.guider;
  const sigmasLink = samplerNode.inputs.sigmas;
  const samplerLink = samplerNode.inputs.sampler;
  const noiseNode = graph[first.noise];

  /* What consumes the first segment's pictures and sound today -- the frame
     interpolator, the upscaler, `CreateVideo`. They will be given the whole
     thing instead, once there is a whole thing. */
  const guider = Object.entries(graph)
    .find(([, n]) => n.class_type === 'BasicGuider' && Array.isArray(n.inputs?.conditioning));

  const opening = loop
    ? addNode(graph, 'ImageScale', {
      image: reference,
      upscale_method: 'lanczos',
      width: condNode.inputs.width,
      height: condNode.inputs.height,
      crop: 'center',
    }, 'Loop keyframe')
    : null;

  asHybrid(graph, first.cond, { first: opening ? [opening, 0] : null, last: null });
  if (prompts[0]) graph[first.cond].inputs.prompt = String(prompts[0]);

  let previousDecode = first.decode;
  const videoParts = [[first.decode, 0]];
  const audioParts = [[first.decodeAudio, 0]];

  for (let i = 1; i < count; i += 1) {
    // The last frame of the segment before, which is where this one starts.
    const tail = addNode(graph, 'ImageFromBatch', {
      image: [previousDecode, 0], batch_index: -1, length: 1,
    }, `Segment ${i + 1} opens here`);

    const cond = copyNode(graph, first.cond, `Segment ${i + 1}`);
    graph[cond].inputs.first_frame = [tail, 0];
    // The closing pin, on the last segment only, and only for a loop.
    if (loop && i === count - 1 && opening) graph[cond].inputs.last_frame = [opening, 0];
    else delete graph[cond].inputs.last_frame;
    if (prompts[i] || prompts[prompts.length - 1]) {
      graph[cond].inputs.prompt = String(prompts[i] || prompts[prompts.length - 1]);
    }

    /* A different seed per segment. The same one gives every segment the same
       noise, and with the same prompt and a near-identical opening frame that
       is a visible repeat of the same motion. */
    const noise = copyNode(graph, first.noise, `Segment ${i + 1} noise`);
    const seed = noiseNode.inputs.noise_seed;
    if (Array.isArray(seed)) {
      // The seed comes from a generator node; offset it where it lands.
      const shifted = addNode(graph, 'ComfyMathExpression', {
        expression: `a + ${i}`, 'values.a': seed,
      }, `Segment ${i + 1} seed`);
      graph[noise].inputs.noise_seed = [shifted, 1];
    } else {
      graph[noise].inputs.noise_seed = (Number(seed) || 0) + i;
    }

    const guiderId = guider ? copyNode(graph, guider[0], `Segment ${i + 1} guider`) : null;
    if (guiderId) graph[guiderId].inputs.conditioning = [cond, 0];

    const sampler = copyNode(graph, first.sampler, `Segment ${i + 1} sampler`);
    graph[sampler].inputs.noise = [noise, 0];
    graph[sampler].inputs.guider = guiderId ? [guiderId, 0] : guiderLink;
    graph[sampler].inputs.sampler = samplerLink;
    graph[sampler].inputs.sigmas = sigmasLink;
    graph[sampler].inputs.latent_image = [cond, 1];

    const decode = copyNode(graph, first.decode, `Segment ${i + 1} video`);
    graph[decode].inputs.samples = [sampler, 0];
    const decodeAudio = copyNode(graph, first.decodeAudio, `Segment ${i + 1} sound`);
    graph[decodeAudio].inputs.samples = [sampler, 0];

    /* The pinned frame is the previous segment's last frame *again*, so it is
       dropped here exactly as the loop's repeat is. */
    const trimmed = addNode(graph, 'ImageFromBatch', {
      image: [decode, 0], batch_index: 1, length: 4096,
    }, `Segment ${i + 1} without its repeated frame`);
    /* And the sound with it: one frame is 1/24s, which nobody hears -- but at
       six segments it is a quarter of a second of drift between what is said
       and the mouth saying it. */
    const trimmedAudio = addNode(graph, 'TrimAudioDuration', {
      audio: [decodeAudio, 0], start_index: 1 / 24, duration: 3600,
    }, `Segment ${i + 1} sound, aligned`);

    videoParts.push([trimmed, 0]);
    audioParts.push([trimmedAudio, 0]);
    previousDecode = decode;
  }

  // One clip out of the parts, in order.
  let video = videoParts[0];
  for (let i = 1; i < videoParts.length; i += 1) {
    video = [addNode(graph, 'ImageBatch', { image1: video, image2: videoParts[i] }, `Joined 1-${i + 1}`), 0];
  }
  let audio = audioParts[0];
  for (let i = 1; i < audioParts.length; i += 1) {
    audio = [addNode(graph, 'AudioConcat', { audio1: audio, audio2: audioParts[i], direction: 'after' }, `Sound 1-${i + 1}`), 0];
  }

  /* A loop drops its repeated opening frame too, and it has to happen after the
     join or it would be dropped from every lap but the first. */
  if (loop && opening) {
    video = [addNode(graph, 'ImageFromBatch', {
      image: video, batch_index: 1, length: 4096,
    }, 'Drop the repeated frame'), 0];
  }

  /* Whatever was reading the first segment now reads all of it. Done last, so
     the parts built above keep their own links to the first decode. */
  const movedVideo = rewire(graph, first.decode, 0, video, { only: before });
  const movedAudio = rewire(graph, first.decodeAudio, 0, audio, { only: before });

  return {
    applied: true,
    kind: loop ? 'chain+loop' : 'chain',
    segments: count,
    rewired: { video: movedVideo, audio: movedAudio },
  };
};

/**
 * One segment of a long clip rendered as its own prompt -- see server/longVideo.js.
 *
 * `firstFrame` is the name ComfyUI knows the previous segment's last frame by,
 * after it was uploaded; empty for the first segment. It is loaded and scaled
 * to the clip's exact size before it is pinned, for the same reason the loop's
 * picture is: the node stretches a first frame that does not match, and the
 * saved file may have been upscaled or cropped on its way out.
 *
 * A loop pins its opening picture on the first segment and its closing picture
 * on the last, which is the reference picture both times -- the same two pins
 * `applyH3Chain` makes inside one graph.
 *
 * `segment`/`count` also set the prompt and shift the seed, so every segment is
 * asked for its own part of the timeline with its own noise.
 */
export const applyH3Segment = (graph, {
  segment = 0, count = 1, prompt = '', firstFrame = '', loop = false, available = null,
} = {}) => {
  /* Only a segment that is pinned needs the hybrid node. A cut's segments are
     each their own shot, pinned to nothing, and the stock node draws them. */
  const pinned = !!firstFrame || loop;
  if (pinned && available && !available.has(HYBRID_NODE)) {
    return { applied: false, reason: 'missing', missing: [HYBRID_NODE] };
  }
  const { cond, noise } = findH3Nodes(graph);
  if (!cond) return { applied: false, reason: 'shape' };
  const node = graph[cond];
  const reference = node.inputs['ref_images.ref_image_0'];
  if (loop && !Array.isArray(reference)) return { applied: false, reason: 'noReference' };

  const atClipSize = (image, title) => addNode(graph, 'ImageScale', {
    image, upscale_method: 'lanczos', width: node.inputs.width, height: node.inputs.height, crop: 'center',
  }, title);

  let first = null;
  if (firstFrame) {
    const load = addNode(graph, 'LoadImage', { image: String(firstFrame) }, `Segment ${segment + 1} opens here`);
    first = [atClipSize([load, 0], `Segment ${segment + 1} opening, at clip size`), 0];
  }
  const loopFrame = loop && (segment === 0 || segment === count - 1) ? atClipSize(reference, 'Loop keyframe') : null;
  if (loop && segment === 0) first = [loopFrame, 0];
  const last = loop && segment === count - 1 ? [loopFrame, 0] : null;
  if (pinned) asHybrid(graph, cond, { first, last });

  if (prompt) node.inputs.prompt = String(prompt);

  if (segment > 0 && noise) {
    const seed = graph[noise].inputs.noise_seed;
    if (Array.isArray(seed)) {
      const shifted = addNode(graph, 'ComfyMathExpression', {
        expression: `a + ${segment}`, 'values.a': seed,
      }, `Segment ${segment + 1} seed`);
      graph[noise].inputs.noise_seed = [shifted, 1];
    } else {
      graph[noise].inputs.noise_seed = (Number(seed) || 0) + segment;
    }
  }
  return { applied: true, kind: loop ? 'segment+loop' : 'segment', segment, count };
};

/**
 * The workflow's own upscaler, switched on.
 *
 * The MiniMax workflow carries a choice node -- `None`, `RTX VSR`, `ResShift` --
 * that routes the decoded frames through an upscaler before the file is written,
 * set to `None` as exported. RTX Video Super Resolution doubles each side on the
 * card in a fraction of a sampling step's time, so a 768 segment is written at
 * 1536. Only where its node is installed; the graph is left alone otherwise.
 */
export const applyH3Upscale = (graph, { available = null, choice = 'RTX VSR' } = {}) => {
  if (available && !available.has('RTXVideoSuperResolution')) return { applied: false, reason: 'missing', missing: ['RTXVideoSuperResolution'] };
  const combos = Object.keys(graph).filter(id => graph[id]?.class_type === 'CustomCombo' && typeof graph[id].inputs?.choice === 'string');
  // The one whose value decides between the upscalers: a regex testing for RTX reads it.
  const decides = combos.find(id => Object.values(graph).some(node => node.class_type === 'PrimitiveString'
    && Array.isArray(node.inputs?.value) && String(node.inputs.value[0]) === id));
  const target = decides || combos[0];
  if (!target) return { applied: false, reason: 'shape' };
  graph[target].inputs.choice = choice;
  return { applied: true, node: target };
};

/* The pack's pass-through nodes that throw models out of memory mid-graph. */
const UNLOADERS = new Set(['UnloadAllModels', 'UnloadModel']);

/**
 * The workflow's unload nodes, taken out.
 *
 * Its author put three "unload everything" nodes and one "unload this model" in
 * the graph, which is right for a card and a machine with nothing to spare --
 * and means a clip of twelve segments loads forty gigabytes of weights twelve
 * times. With enough memory left (the caller measures), ComfyUI's own model
 * management moves models off the card when the next one needs the room, and
 * the weights stay in RAM between segments. Each node passes its `value` input
 * straight through, so whatever read it reads that instead.
 */
export const bypassUnloads = (graph) => {
  const removed = [];
  for (const [id, node] of Object.entries(graph)) {
    if (!UNLOADERS.has(node?.class_type)) continue;
    const through = node.inputs?.value;
    if (!Array.isArray(through)) continue;
    rewire(graph, id, 0, through, { except: [id] });
    delete graph[id];
    removed.push(id);
  }
  return removed;
};

/**
 * Whatever this job asked for, applied.
 *
 * One entry point so the route does not have to know which of the two it is.
 */
export const applyH3Motion = (graph, { seconds, segmentSeconds, loop = false, prompts = [], available = null } = {}) => {
  const plan = segmentPlan(seconds, segmentSeconds);
  if (plan.count > 1) {
    return { ...applyH3Chain(graph, { segments: plan.count, prompts, loop, available }), plan };
  }
  if (loop) return { ...applyH3Loop(graph, { available }), plan };
  return { applied: false, reason: 'nothingToDo', plan };
};
