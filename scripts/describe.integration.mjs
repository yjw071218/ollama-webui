// A picture read back as a prompt, against the real tagger and a real vision
// model.
//
// scripts/describeimage.test.mjs proves every decision about what lands in the
// prompt box with both halves stubbed. What it cannot show is the join: that
// an uploaded picture is somewhere `/studio/picture-tags` will accept, that
// WD14 answers in the shape `tagsFromFrames` expects, and that a vision model
// asked DESCRIBE_PROMPT writes something `readDescription` can use rather than
// a paragraph of preamble.
//
//   node scripts/describe.integration.mjs [picture.png] [vision-model]
//
// Needs ComfyUI with the WD14 tagger, and Ollama with a model that can see.
// Says so and exits cleanly when either is missing.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.resolve(ROOT, 'node_modules/.describe-live-bundle.mjs');
const COMFY = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const VISION = process.argv[3] || 'qwen3.8:latest';

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/describeImage.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { DESCRIBE_PROMPT, tagsFromFrames, readDescription, composePrompt } =
  await import(pathToFileURL(OUT).href);

const S = await import(pathToFileURL(path.join(ROOT, 'server/studio.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

try {
  const probe = await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(4000) });
  if (!probe.ok) throw new Error(String(probe.status));
} catch (e) {
  console.log(`SKIP  no ComfyUI at ${COMFY}; the tagger cannot be reached`);
  process.exit(0);
}

/* node's zlib gained crc32 only recently; this is the table-free fallback. */
const crc32 = (buf) => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
};

/* A plain still life, drawn here rather than taken from this install's own
   output folder. A test that reaches into whatever pictures happen to be on
   the machine is a test whose result depends on what somebody was making last
   week -- and, on a machine used for pictures of people, one that puts their
   pictures through two models to assert something about a code path. Drawn
   input is reproducible and nobody's. */
const drawStillLife = () => {
  /* A 4-bit PNG would be smaller; this is written uncompressed-per-row with
     zlib's stored blocks so it needs nothing but node's own zlib. */
  const W = 512, H = 512;
  const px = Buffer.alloc(W * H * 3);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const at = (y * W + x) * 3;
    px[at] = r; px[at + 1] = g; px[at + 2] = b;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Wall above, table below.
      if (y > 350) set(x, y, 190, 165, 130); else set(x, y, 245, 243, 238);
    }
  }
  // A white cup with a dark rim, sitting on the table.
  const cx = 230, cy = 300, rx = 70, ry = 95;
  for (let y = cy - ry; y <= cy + ry; y++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1) set(x, y, y < cy - ry + 30 ? 90 : 252, y < cy - ry + 30 ? 60 : 252, y < cy - ry + 30 ? 40 : 250);
    }
  }
  // A red book lying beside it.
  for (let y = 320; y < 360; y++) for (let x = 330; x < 470; x++) set(x, y, 180, 70, 60);
  for (let y = 312; y < 320; y++) for (let x = 335; x < 465; x++) set(x, y, 225, 215, 200);

  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;                                  // filter: none
    px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const given = process.argv[2];
const picture = given && fs.existsSync(given)
  ? fs.readFileSync(given)
  : drawStillLife();
console.log(given && fs.existsSync(given)
  ? `picture: ${path.basename(given)} (${picture.length} bytes)`
  : `picture: a still life drawn by the test (${picture.length} bytes)`);

/* The routes, driven the way the server drives them. Nothing here reimplements
   the handlers -- the point is to exercise the ones that ship. */
const routes = S.createStudioRoutes({});
const call = (routePath, { body = null, headers = {} } = {}) => new Promise((resolve) => {
  const route = routes.find(r => r.path === routePath);
  if (!route) return resolve({ status: 404, body: { error: `no route ${routePath}` } });

  /* Enough of an IncomingMessage for the handlers to read a body from.
     `off` and `resume` are not decoration: server/requestBody.js detaches its
     listeners when it settles, and a stub without them throws *after* the
     route has already done its work -- which reads as the route failing. */
  const req = {
    method: 'POST',
    url: routePath,
    headers: { 'content-type': 'application/json', ...headers },
    on(event, fn) {
      if (event === 'data' && body) setImmediate(() => fn(body));
      if (event === 'end') setImmediate(() => setImmediate(fn));
      return this;
    },
    once(event, fn) { return this.on(event, fn); },
    off() { return this; },
    removeListener() { return this; },
    resume() { return this; },
    setEncoding() { return this; },
    [Symbol.asyncIterator]: async function* () { if (body) yield body; },
  };
  let status = 200;
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) { status = code; },
    end(text) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: String(text).slice(0, 200) }; }
      resolve({ status: status === 200 ? res.statusCode : status, body: parsed });
    },
  };
  route.handler(req, res);
});

// ----------------------------------------------------------------- upload
const boundary = '----describeTest';
const multipart = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="still-life.png"\r\n`
    + 'Content-Type: image/png\r\n\r\n'),
  picture,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);

const uploaded = await call('/studio/upload', {
  body: multipart,
  headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
});
console.log(`upload -> ${JSON.stringify(uploaded.body)}`);

check('ComfyUI accepted the upload', uploaded.body?.success === true,
  JSON.stringify(uploaded.body));
/* The change this feature needed from the server: the parts unjoined, because
   the tagging route validates a filename and a subfolder separately -- a `..`
   in either is a way out of ComfyUI's folders. */
check('the upload reports the name and folder separately',
  typeof uploaded.body?.filename === 'string' && uploaded.body.filename.length > 0
  && typeof uploaded.body?.subfolder === 'string',
  JSON.stringify(uploaded.body));
check('and says which of ComfyUI\'s folders it landed in',
  uploaded.body?.type === 'input', String(uploaded.body?.type));

if (!uploaded.body?.success) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ------------------------------------------------------------------ tags
console.log('tagging (this is a ComfyUI job and can queue behind a generation)…');
const tagged = await call('/studio/picture-tags', {
  body: Buffer.from(JSON.stringify({
    filename: uploaded.body.filename,
    subfolder: uploaded.body.subfolder,
    type: 'input',
  })),
});

if (tagged.body?.missing) {
  console.log(`SKIP  this ComfyUI has no ${tagged.body.missing.join(', ')}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

console.log(`tags -> ${JSON.stringify(tagged.body?.frames)}`);
check('an uploaded picture is somewhere the tagger will accept',
  tagged.body?.success === true, JSON.stringify(tagged.body));

const tags = tagsFromFrames(tagged.body?.frames || []);
console.log(`read as ${tags.length} tags: ${tags.join(', ')}`);
check('WD14 answers in the shape tagsFromFrames expects', tags.length > 0,
  JSON.stringify(tagged.body?.frames));
check('the tags are spelled the way a prompt spells them',
  tags.every(tag => !tag.includes('_') && tag === tag.toLowerCase()), JSON.stringify(tags));
/* The two families this drops are not hypothetical: WD14 emits a rating for
   every picture, and `highres` for anything large. */
check('no rating tag reached the prompt',
  !tags.some(tag => ['general', 'sensitive', 'questionable', 'explicit'].includes(tag)),
  JSON.stringify(tags));
check('no file-property tag did either',
  !tags.some(tag => ['highres', 'absurdres', 'lowres'].includes(tag)), JSON.stringify(tags));

// -------------------------------------------------------------- the sentence
let sentence = '';
let vision = true;
try {
  const models = await (await fetch(`${OLLAMA}/api/tags`)).json();
  const named = (models.models || []).find(m => m.name === VISION);
  if (!named) { vision = false; console.log(`SKIP  ${VISION} is not installed; no sentence to check`); }
} catch (e) {
  vision = false;
  console.log(`SKIP  no Ollama at ${OLLAMA}; no sentence to check`);
}

if (vision) {
  console.log(`describing with ${VISION}…`);
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION,
      messages: [{ role: 'user', content: DESCRIBE_PROMPT, images: [picture.toString('base64')] }],
      stream: false,
      think: false,
      options: { temperature: 0.3, num_predict: 220 },
    }),
  });
  const data = await res.json();
  const raw = data?.message?.content || '';
  sentence = readDescription(raw);
  console.log(`raw      -> ${JSON.stringify(raw.slice(0, 220))}`);
  console.log(`sentence -> ${JSON.stringify(sentence)}`);

  check('the vision model answered', raw.length > 0);
  check('and readDescription got a usable sentence out of it', sentence.length > 0,
    JSON.stringify(raw.slice(0, 200)));
  /* The four ways this reply comes back wrong, each one a line in
     DESCRIBE_PROMPT and each one checked here against a real model. */
  check('it does not open with "this image shows"',
    !/^(this|the)\s+(image|picture|photo)\s+(is|shows|depicts)/i.test(sentence), sentence);
  check('it is not a markdown list', !/^[-*•]/m.test(sentence), sentence);
  check('it is one or two sentences, not a paragraph',
    (sentence.match(/[.!?]/g) || []).length <= 2, sentence);
  check('it is short enough to sit in a prompt', sentence.length <= 400, String(sentence.length));
}

// ------------------------------------------------------------- the result
const empty = composePrompt('', { tags, sentence });
console.log(`\nempty box  -> ${JSON.stringify(empty)}`);
check('an empty box gets the tags and the sentence', empty.length > 0);

const EXISTING = tags.length ? `${tags[0]}, masterpiece` : 'masterpiece';
const appended = composePrompt(EXISTING, { tags, sentence });
console.log(`written-in -> ${JSON.stringify(appended)}`);
check('what was already typed comes first', appended.startsWith(EXISTING), appended);
/* The commonest use of this is on a picture made from the prompt still in the
   box, so this is the case that decides whether it is usable. */
if (tags.length) {
  check('a tag already in the box is not added a second time',
    (appended.match(new RegExp(tags[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1,
    appended);
}
if (sentence) check('and the sentence is last', appended.endsWith(sentence));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
