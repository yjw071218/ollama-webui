/**
 * Teaching this install a character, or a style, from pictures.
 *
 * ## Why this is training and not a reference image
 *
 * Every other "use this picture" feature here hands ComfyUI the picture and
 * lets a model look at it: img2img, the region edit, the video's reference
 * frame. None of those can be asked for *a different picture of the same
 * character* — they redraw the one they were given.
 *
 * The usual shortcut for that is an image-prompt adapter (IP-Adapter, Flux
 * Redux, a style model) which encodes a reference and conditions on it. This
 * install has none: `StyleModelLoader` lists nothing, and the adapters that do
 * exist here are built for SD/SDXL/Flux, not for the Anima DiT these workflows
 * actually draw with. So the honest route is the one the owner of this machine
 * already takes by hand — train a LoRA — and the whole of that pipeline is
 * installed: `comfyui-anima-trainer` in ComfyUI, and the training daemon it
 * submits to.
 *
 * A LoRA is also the better answer to what was asked for. An adapter conditions
 * one generation; a LoRA is a file, so the character survives the tab being
 * closed, stacks with the nine slots the Anima workflow already has, applies to
 * an edit as readily as to a new picture, and can be handed to the region edit
 * to put a *different* character into a finished picture.
 *
 * ## The shape of a training run
 *
 * `AnimaLoRATrainerFolder` reads a folder of images, each with a same-stem
 * `.txt` caption beside it, from a subfolder of ComfyUI's `input/`. There is
 * also a single-image node that takes an IMAGE batch and one shared caption,
 * and this deliberately does not use it: a batch is one tensor, so every
 * picture in it must be the same size, and mixed references would have to be
 * cropped or squashed to match. The folder node hands the set to the trainer's
 * own aspect-ratio bucketing instead, and each picture keeps its own caption —
 * which for a style LoRA is the difference between training and noise, since
 * what varies between the pictures is exactly what the captions must carry.
 *
 * The dataset gets into that folder over HTTP, through ComfyUI's own
 * `/upload/image`: it honours a `subfolder`, and writes what it is given
 * without looking at it, so the `.txt` sidecars travel the same road as the
 * PNGs. That matters because this server does not assume it shares a filesystem
 * with ComfyUI — `COMFYUI_URL` may well point somewhere else — and every other
 * picture this app sends already goes that way.
 *
 * ## Two things that are not obvious from the node
 *
 * The trainer returns a MODEL and writes no file of its own, and ComfyUI runs
 * only what an output node depends on. A graph of just the trainer is a graph
 * with no outputs, which ComfyUI accepts and then executes nothing of. So the
 * MODEL goes into `PreviewAny`, whose entire purpose is to be an output node
 * that will take anything.
 *
 * And the node does not train: it submits to a separate daemon on localhost and
 * waits. If that daemon is not running the node raises, minutes of setup in,
 * with a message about `make daemon` that never reaches the browser. So it is
 * asked first — see `daemonState` — and a run that cannot work is refused
 * before anybody's pictures are uploaded.
 */

/* The trainer writes into ComfyUI's own `models/loras`, so a finished LoRA
   appears in the same list the Studio's LoRA slots already offer. Nothing here
   has to move it, and nothing has to be restarted to see it: ComfyUI rebuilds
   that list when it is asked for the node definitions, which is what
   `listInstalled` does on every request. */

/** The node classes a training run needs, and the pack that brings them. */
export const TRAIN_NODES = ['AnimaLoRATrainerFolder', 'PreviewAny'];
export const TRAIN_PACK = 'comfyui-anima-trainer';

/* Anima's DiT, as the workflow that will *use* the result actually loads it
   (workflows/anima.json, node 1328). A LoRA is trained against one base and
   applies cleanly only to that base, so the two have to agree; picking
   whatever happened to be first in the list is how an afternoon of GPU time
   becomes a file that makes every picture slightly worse. */
export const TRAIN_BASE = 'anima_aestheticV11.safetensors';

/* Between these many pictures. One is enough for the trainer to run and not
   enough to learn a character from — it learns that one pose, that one
   background. The ceiling is about the wait: every picture is another pass per
   epoch, and this is already measured in tens of minutes. */
export const MIN_IMAGES = 1;
export const MAX_IMAGES = 40;

/* What a run is worth turning the dials to. `rank` is how much capacity the
   LoRA has, `epochs` how many times it reads the set. A style needs more of
   both than a character does: a character is a handful of features that recur
   in every picture, a style is everything else about all of them. */
export const DIALS = {
  rank: { min: 4, max: 128, step: 4 },
  epochs: { min: 1, max: 200, step: 1 },
  lr: { min: 0.000001, max: 0.001, step: 0.000001 },
};

export const PRESETS = {
  character: { rank: 16, epochs: 25, lr: 0.00005 },
  style: { rank: 32, epochs: 30, lr: 0.00005 },
};

/** The hardware tiers the node offers, smallest first. */
export const GPU_TIERS = ['8GB', '16GB', 'high'];

const optionsOf = (objectInfo, cls, input) => {
  const decl = objectInfo?.[cls]?.input?.required?.[input] || objectInfo?.[cls]?.input?.optional?.[input];
  if (!Array.isArray(decl)) return [];
  return Array.isArray(decl[0]) ? decl[0] : [];
};

const missingOf = (objectInfo, classes) => classes.filter(cls => !objectInfo?.[cls]);

/* ------------------------------------------------------------ the dataset

   One flat folder directly under `input/`, because that is the only shape the
   node's picker can name: it lists the *immediate* subdirectories of the input
   directory, so `input/webui/luna` would never appear in it.

   The prefix is so a folder this app made is recognisable among the ones the
   owner of the machine keeps there by hand, and so nothing this app writes can
   collide with one of theirs. */

export const DATASET_PREFIX = 'webui-lora-';

/**
 * A name someone typed, as a folder and a file can both be called.
 *
 * Lowercased ASCII, because the same string becomes a `.safetensors` filename
 * that ComfyUI then hands around as a model name inside JSON graphs; a Korean
 * or emoji name survives all of that in principle and is a bad thing to find
 * out otherwise halfway through a forty-minute run.
 */
export const slugify = (name) => String(name || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);

/** Where this run's pictures go, under ComfyUI's `input/`. */
export const datasetFolder = (id) => `${DATASET_PREFIX}${slugify(id) || 'set'}`;

/**
 * The files a dataset is, as names and bodies for the uploader.
 *
 * Numbered rather than named after whatever the reader's files were called:
 * the trainer pairs an image with its caption by matching stems, and a stem
 * has to survive being a filename on this machine, ComfyUI's duplicate
 * handling, and the trainer's own temp copy. `img_0001` survives all three;
 * `사진 (2).PNG` is three separate ways to lose the pairing.
 */
export const datasetFiles = (items = []) => items.flatMap((item, i) => {
  const stem = `img_${String(i + 1).padStart(4, '0')}`;
  return [
    { stem, name: `${stem}.png`, kind: 'image', source: item.image },
    { stem, name: `${stem}.txt`, kind: 'caption', text: `${String(item.caption || '').trim()}\n` },
  ];
});

/* ------------------------------------------------------------ the daemon

   `comfyui-anima-trainer` does not train. It submits to a long-lived process
   from the anima_lora repo — one job at a time, on its own detached
   subprocess, so a CUDA out-of-memory kills the run and not ComfyUI — and
   blocks until that finishes. The node explicitly does not start it.

   Which port is in the daemon's own pidfile, mirrored per-user at
   `~/.anima/daemon.json` exactly so a ComfyUI node installed in a different
   tree can find it. Read here for the same reason, falling back to the
   documented default. */

export const DAEMON_PORT = 8765;

/** Where the training daemon answers, honouring the same env the node reads. */
export const daemonBase = (env = {}, pidfile = null) => {
  const port = Number(env.ANIMA_DAEMON_PORT) || Number(pidfile?.port) || DAEMON_PORT;
  return `http://127.0.0.1:${port}`;
};

/**
 * Whether a training run could start at all, and why not.
 *
 * Two separate things can be missing and they have different fixes, so they
 * are reported separately rather than as one "training is unavailable":
 * the ComfyUI node is a pack to install, and the daemon is a process to start.
 */
export const daemonState = async (base, fetchJson) => {
  try {
    const health = await fetchJson(`${base}/health`);
    return health?.ok
      ? { running: true, port: health.port || null, busy: !!health.active_job }
      : { running: false, reason: 'refused' };
  } catch (e) {
    return { running: false, reason: 'down', error: String(e?.message || e) };
  }
};

/* ------------------------------------------------------------- the graph */

/**
 * A training run, as a ComfyUI prompt.
 *
 * `{ missing }` instead when this ComfyUI has not got the nodes, so the caller
 * can name the pack rather than failing after the pictures are uploaded.
 */
export const trainGraph = ({
  dataset,
  saveAs,
  objectInfo,
  base = TRAIN_BASE,
  rank = PRESETS.character.rank,
  epochs = PRESETS.character.epochs,
  lr = PRESETS.character.lr,
  gpu = '16GB',
} = {}) => {
  const missing = missingOf(objectInfo, TRAIN_NODES);
  if (missing.length) return { missing };

  const bases = optionsOf(objectInfo, 'AnimaLoRATrainerFolder', 'anima_model');
  const folders = optionsOf(objectInfo, 'AnimaLoRATrainerFolder', 'dataset_dir');
  const tiers = optionsOf(objectInfo, 'AnimaLoRATrainerFolder', 'gpu');
  const masks = optionsOf(objectInfo, 'AnimaLoRATrainerFolder', 'mask_dir');

  /* The folder has to be in the node's own list or ComfyUI refuses the graph
     on a value-not-in-list, and a folder that is not there means the upload
     did not land -- which is worth saying plainly, because the alternative is
     a validation error naming a dropdown the reader has never seen. */
  if (folders.length && !folders.includes(dataset)) return { noDataset: dataset };

  return {
    prompt: {
      1: {
        class_type: 'AnimaLoRATrainerFolder',
        inputs: {
          anima_model: bases.includes(base) ? base : (bases[0] || base),
          dataset_dir: dataset,
          save_as: saveAs,
          rank,
          epochs,
          lr,
          gpu: tiers.includes(gpu) ? gpu : (tiers[0] || gpu),
          // No masked loss: it wants a `{stem}_mask.png` per picture, and
          // nothing here paints one. Sent as the node's own sentinel when it
          // offers it, so the value is one the picker would have produced.
          ...(masks.includes('(none)') ? { mask_dir: '(none)' } : {}),
        },
        _meta: { title: 'Training' },
      },
      /* The trainer writes the LoRA itself and returns a MODEL. ComfyUI runs
         only what an output node depends on, so without this the graph is
         accepted and nothing in it happens. */
      2: { class_type: 'PreviewAny', inputs: { source: ['1', 0] }, _meta: { title: 'Done' } },
    },
  };
};

/**
 * What the finished LoRA will be called in the Studio's slots.
 *
 * The node saves into ComfyUI's native `models/loras` with no subfolder, so
 * the name is the bare filename -- unlike everything already installed here,
 * which lives under `anima\` and `krea2\` and carries the folder in its name.
 */
export const loraFileName = (saveAs) => `${saveAs}.safetensors`;

/** A LoRA name as it appears in a list, whichever separator that list uses. */
export const sameLora = (a, b) => String(a || '').replace(/\\/g, '/').toLowerCase()
  === String(b || '').replace(/\\/g, '/').toLowerCase();

/** The entry for a just-trained LoRA in ComfyUI's list, or null if it is not there yet. */
export const findLora = (names = [], saveAs) => {
  const wanted = loraFileName(saveAs).toLowerCase();
  return names.find(name => String(name).replace(/\\/g, '/').toLowerCase().split('/').pop() === wanted) || null;
};
