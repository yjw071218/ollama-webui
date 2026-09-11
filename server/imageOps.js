/**
 * Things done *to* a picture rather than drawing one: taking the background
 * out, making it bigger, reading its tags.
 *
 * None of these needs a workflow file. The generation workflows are artefacts
 * exported from ComfyUI because they carry an author's whole pipeline; these
 * are three or four nodes each, the same on every install that has the pack,
 * and written out here where they can be read and tested.
 *
 * Each builder returns a ComfyUI API prompt, or `{ missing }` naming the node
 * classes this ComfyUI does not have -- so the caller can say which pack to
 * install rather than failing a minute into a job.
 */

/* The upscalers this app knows how to pick between, by what they are good at.
   Both are anime-trained; the factor decides. Names as ComfyUI lists them, and
   only used when that ComfyUI actually lists them. */
const UPSCALERS = [
  { name: '2x-AnimeSharpV4_Fast_RCAN_PU.safetensors', factor: 2 },
  { name: 'realesrganX4plusAnime_v1.pt', factor: 4 },
];

/* A picture from this app is already large -- the workflows finish with their
   own upscaler -- and doubling a 2638×3520 PNG makes a 37-megapixel file that
   has to live inside a chat message and sync to a phone. So the result is
   capped on its longer side, and a picture that is already past the cap is
   reported rather than enlarged by a factor of one. */
export const UPSCALE_LIMIT = 6144;

const optionsOf = (objectInfo, cls, input) => {
  const decl = objectInfo?.[cls]?.input?.required?.[input] || objectInfo?.[cls]?.input?.optional?.[input];
  if (!Array.isArray(decl)) return [];
  if (Array.isArray(decl[0])) return decl[0];
  return Array.isArray(decl[1]?.options) ? decl[1].options : [];
};

const missingOf = (objectInfo, classes) => classes.filter(cls => !objectInfo?.[cls]);

const save = (images, prefix = 'webui/op') => ({
  class_type: 'SaveImage',
  inputs: { images, filename_prefix: prefix },
  _meta: { title: 'Result' },
});

/**
 * The background out, as a transparent PNG.
 *
 * RMBG-2.0 through ComfyUI-RMBG: it cuts hair and fingers cleanly on anime
 * pictures where the older rembg models leave a halo. The pack downloads the
 * model the first time it runs. Its IMAGE output is already RGBA -- the
 * subject with the mask as alpha -- which is what SaveImage writes as a PNG
 * with transparency.
 */
export const removeBackgroundGraph = ({ image, objectInfo }) => {
  const missing = missingOf(objectInfo, ['LoadImage', 'RMBG', 'SaveImage']);
  if (missing.length) return { missing };
  const models = optionsOf(objectInfo, 'RMBG', 'model');
  return {
    prompt: {
      1: { class_type: 'LoadImage', inputs: { image }, _meta: { title: 'Picture' } },
      2: {
        class_type: 'RMBG',
        inputs: {
          image: ['1', 0],
          model: models.includes('RMBG-2.0') ? 'RMBG-2.0' : (models[0] || 'RMBG-2.0'),
          sensitivity: 1,
          process_res: 1024,
          mask_blur: 0,
          mask_offset: 0,
          invert_output: false,
          refine_foreground: true,
          background: 'Alpha',
          background_color: '#222222',
        },
        _meta: { title: 'Without its background' },
      },
      3: save(['2', 0]),
    },
  };
};

/**
 * Bigger, with the detail an upscaler invents rather than the blur a resize
 * makes. `factor` is 2 or 4; `size` is the picture's own, so the result can be
 * held under the limit.
 */
export const upscaleGraph = ({ image, factor = 2, size, objectInfo }) => {
  const missing = missingOf(objectInfo, ['LoadImage', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'SaveImage']);
  if (missing.length) return { missing };

  const installed = optionsOf(objectInfo, 'UpscaleModelLoader', 'model_name');
  const candidates = UPSCALERS.filter(u => installed.includes(u.name));
  const pool = candidates.length ? candidates : installed.map(name => ({ name, factor: /4x|x4/i.test(name) ? 4 : 2 }));
  if (!pool.length) return { missing: ['an upscale model in models/upscale_models'] };

  const wanted = Number(factor) >= 3 ? 4 : 2;
  const chosen = pool.find(u => u.factor === wanted) || pool[0];

  const longest = Math.max(Number(size?.width) || 0, Number(size?.height) || 0);
  const allowed = longest ? UPSCALE_LIMIT / longest : wanted;
  if (allowed < 1.1) return { tooLarge: true, longest };
  const target = Math.min(wanted, allowed);

  const prompt = {
    1: { class_type: 'LoadImage', inputs: { image }, _meta: { title: 'Picture' } },
    2: { class_type: 'UpscaleModelLoader', inputs: { model_name: chosen.name }, _meta: { title: 'Upscaler' } },
    3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] }, _meta: { title: 'Upscaled' } },
  };
  let result = ['3', 0];
  /* The model scales by its own fixed factor. When that overshoots what was
     asked, or the limit, it is brought back down -- lanczos from a larger
     picture, which keeps what the model added. */
  const ratio = target / chosen.factor;
  if (ratio < 0.98 && objectInfo?.ImageScaleBy) {
    prompt[4] = {
      class_type: 'ImageScaleBy',
      inputs: { image: ['3', 0], upscale_method: 'lanczos', scale_by: Number(ratio.toFixed(4)) },
      _meta: { title: 'To size' },
    };
    result = ['4', 0];
  }
  prompt[9] = save(result);
  return { prompt, factor: Number(target.toFixed(2)), model: chosen.name };
};

/* The tagger, and how sure it has to be. v3 SwinV2 is the balance of the
   family: markedly better than the v1.4 default, a third the size of the EVA02
   large model. The pack downloads it the first time. */
const TAGGER = 'wd-swinv2-tagger-v3';

/** The picture's danbooru tags, as WD14 reads them. */
export const tagGraph = ({ image, objectInfo, threshold = 0.35 }) => {
  const missing = missingOf(objectInfo, ['LoadImage', 'WD14Tagger|pysssss']);
  if (missing.length) return { missing };
  const models = optionsOf(objectInfo, 'WD14Tagger|pysssss', 'model');
  return {
    prompt: {
      1: { class_type: 'LoadImage', inputs: { image }, _meta: { title: 'Picture' } },
      2: {
        class_type: 'WD14Tagger|pysssss',
        inputs: {
          image: ['1', 0],
          model: models.includes(TAGGER) ? TAGGER : (models[0] || TAGGER),
          threshold,
          character_threshold: 0.85,
          replace_underscore: true,
          trailing_comma: false,
          exclude_tags: '',
        },
        _meta: { title: 'Tags' },
      },
    },
  };
};

/**
 * Text a finished job produced -- the tagger's answer is not a file, it is a
 * string the node hands back to ComfyUI's interface, and the history keeps it
 * under whatever key the node chose.
 */
export const textsOf = (entry) => {
  const found = [];
  for (const output of Object.values(entry?.outputs || {})) {
    for (const key of ['tags', 'text', 'string']) {
      for (const value of [].concat(output?.[key] || [])) {
        if (typeof value === 'string' && value.trim()) found.push(value.trim());
      }
    }
  }
  return found;
};
