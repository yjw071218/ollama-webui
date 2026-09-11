// Reading back the settings a picture was made with.
//
// Three dialects, each easy to half-read: take A1111's settings line one comma
// too early and the seed becomes part of the sampler; follow ComfyUI's
// negative wire into the positive text and the import swaps them; miss that a
// chunk is compressed and a Korean prompt comes back as bytes. Each of those is
// a form filled in wrongly with no error — so each is built here as a real PNG
// and read back.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zlibSync, strToU8 } from 'fflate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const P = await import(pathToFileURL(path.join(ROOT, 'src/pngInfo.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A PNG with nothing in it but a header and the chunks given. The CRCs are
   zero: nothing here checks them, and a reader that did would refuse files
   that every viewer opens. */
const chunk = (type, data) => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  return out;
};
const png = (chunks, width = 64, height = 96) => {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...chunks, chunk('IEND', new Uint8Array())];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const tEXt = (key, text) => chunk('tEXt', new Uint8Array([...strToU8(key), 0, ...strToU8(text)]));
const iTXt = (key, text) => chunk('iTXt', new Uint8Array([
  ...strToU8(key), 0, 1, 0, 0, 0, ...zlibSync(strToU8(text)),
]));

/* ------------------------------------------------------------- AUTOMATIC1111 */

const a1111 = P.readGenerationInfo(png([tEXt('parameters', [
  'masterpiece, 1girl, blue eyes',
  'Negative prompt: lowres, bad hands',
  'Steps: 28, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 832x1216, Model: anima, Lora hashes: "a: 1f2, b: 3c4", Version: f1.0',
].join('\n'))]));
eq('the prompt is everything before the negative', a1111?.prompt, 'masterpiece, 1girl, blue eyes');
eq('the negative is its own line', a1111?.negative, 'lowres, bad hands');
eq('the numbers', [a1111?.steps, a1111?.cfg, a1111?.seed], [28, 7, 12345]);
eq('an old sampler name carries its scheduler', [a1111?.sampler, a1111?.scheduler], ['dpmpp_2m', 'karras']);
eq('the size', [a1111?.width, a1111?.height], [832, 1216]);
eq('it says where it came from', a1111?.source, 'a1111');

const forge = P.readGenerationInfo(png([tEXt('parameters',
  'a lighthouse\nSteps: 8, Sampler: Euler a, Schedule type: Simple, CFG scale: 1, Seed: 7, Size: 1024x1360')]));
eq('a newer sampler keeps its scheduler apart', [forge?.sampler, forge?.scheduler], ['euler_ancestral', 'simple']);
check('no negative line is no negative', forge && !('negative' in forge));

const multi = P.readGenerationInfo(png([tEXt('parameters',
  'line one,\nline two\nNegative prompt: bad\nworse\nSteps: 20, Seed: 1, Size: 512x512')]));
eq('a prompt over several lines stays whole', multi?.prompt, 'line one,\nline two');
eq('and so does a negative', multi?.negative, 'bad\nworse');

/* A compressed international chunk, which is what PIL writes when the text
   will not fit Latin-1 -- that is, for any Korean prompt. */
const korean = P.readGenerationInfo(png([iTXt('parameters', '벚꽃 아래 소녀\nSteps: 20, Seed: 3, Size: 512x768')]));
eq('a compressed UTF-8 chunk reads as text', korean?.prompt, '벚꽃 아래 소녀');

/* ------------------------------------------------------------------ ComfyUI */

const graph = {
  3: { class_type: 'KSampler', inputs: {
    seed: 42, steps: 20, cfg: 5.5, sampler_name: 'euler', scheduler: 'normal',
    positive: ['10', 0], negative: ['7', 0], model: ['4', 0], latent_image: ['5', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1360, batch_size: 1 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a red lighthouse', clip: ['4', 1] } },
  8: { class_type: 'CLIPTextEncode', inputs: { text: 'sunset', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  10: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['6', 0], conditioning_2: ['8', 0] } },
};
const comfy = P.readGenerationInfo(png([tEXt('prompt', JSON.stringify(graph))]));
eq('the prompt is found by following the positive wire', comfy?.prompt, 'a red lighthouse, sunset');
eq('and the negative by following its own', comfy?.negative, 'blurry');
eq('the sampler\'s settings', [comfy?.seed, comfy?.steps, comfy?.cfg, comfy?.sampler, comfy?.scheduler],
  [42, 20, 5.5, 'euler', 'normal']);
eq('the size from the empty latent', [comfy?.width, comfy?.height], [1024, 1360]);

// Anima's shape: a loader that takes the text itself, and a sampler that
// reads everything from a context rather than a positive wire.
const loaderGraph = {
  1291: { class_type: 'Efficient Loader ED', inputs: { positive: '1girl, library', negative: 'lowres',
    seed: 9, empty_latent_width: 832, empty_latent_height: 1216 } },
  1298: { class_type: 'KSampler ED', inputs: { steps: 30, context: ['1291', 0], seed: 9 } },
};
const loader = P.readGenerationInfo(png([tEXt('prompt', JSON.stringify(loaderGraph))]));
eq('a loader that holds the text is read', [loader?.prompt, loader?.negative], ['1girl, library', 'lowres']);
eq('and its latent size', [loader?.width, loader?.height, loader?.steps], [832, 1216, 30]);

const noSize = P.readGenerationInfo(png([tEXt('prompt', JSON.stringify({
  1: { class_type: 'KSampler', inputs: { seed: 1, steps: 4, positive: ['2', 0] } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'cat' } },
}))], 640, 480));
eq('with no latent node, the picture\'s own size', [noSize?.width, noSize?.height], [640, 480]);

/* ------------------------------------------------------------------ NovelAI */

const nai = P.readGenerationInfo(png([tEXt('Comment', JSON.stringify({
  prompt: '1girl, cherry blossoms', uc: 'lowres', steps: 28, scale: 5, seed: 77,
  sampler: 'k_euler_ancestral', noise_schedule: 'karras', width: 832, height: 1216,
}))]));
eq('NovelAI\'s prompt and negative', [nai?.prompt, nai?.negative], ['1girl, cherry blossoms', 'lowres']);
eq('its sampler without the k_', [nai?.sampler, nai?.scheduler], ['euler_ancestral', 'karras']);
eq('its numbers', [nai?.steps, nai?.cfg, nai?.seed], [28, 5, 77]);

/* ------------------------------------------------------------------- nothing */

eq('not a PNG is nothing', P.readGenerationInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
eq('a PNG with no settings is nothing', P.readGenerationInfo(png([tEXt('Software', 'paint')])), null);

/* ------------------------------------------------------ one of this machine's

   A picture this Studio actually made, if this machine has one: the graph
   that ComfyUI really writes, rather than one written for a test. */
const made = 'C:/Artificial_Intelligence/ComfyUI-Easy-Install/ComfyUI-Easy-Install/ComfyUI/output/webui/realmtva1vqw_00001_.png';
if (fs.existsSync(made)) {
  const real = P.readGenerationInfo(fs.readFileSync(made));
  check('a real Anima picture gives back its prompt', typeof real?.prompt === 'string' && real.prompt.length > 10,
    JSON.stringify(real)?.slice(0, 200));
  check('and a seed and a size', Number.isFinite(real?.seed) && real?.width > 0 && real?.height > 0,
    JSON.stringify(real)?.slice(0, 300));
} else {
  console.log('SKIP  no picture from this Studio on this machine');
}

/* --------------------------------------------------------------- wiring */

const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
check('a PNG dropped on the form is imported', /onDrop=\{dropFiles\}/.test(panel));
check('an import can be undone as a whole', /setForm\(imported\.before\)/.test(panel));
check('a sampler this ComfyUI lacks is not set', /\(choices\.sampler \|\| \[\]\)\.includes\(info\.sampler\)/.test(panel));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
