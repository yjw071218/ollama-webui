// More things to do with a picture.
//
//   - Anima prompts as tags and a sentence, checked against the tag list.
//   - Background removal, upscaling and tag reading, as small ComfyUI graphs.
//   - Extending a picture and painting over part of it, as region edits with a
//     mask handed in rather than found.
//   - Several pictures from one request; the chat's choice of workflow; the
//     buttons under a picture; the gallery.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
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

/* ======================================================= Anima's prompt */

const { shapeAnimaPrompt } = await load('server/animaPrompt.js');
const { findTag, tagKey } = await load('server/booruTags.js');

/** A tag list of a dozen rows, shaped like the real index. */
const ROWS = [
  ['1girl', 0, 6500000], ['solo', 0, 5400000], ['smile', 0, 3100000], ['short hair', 0, 2400000],
  ['school uniform', 0, 850000], ['standing', 0, 1200000], ['chibi', 0, 270000], ['bob cut', 0, 108000],
  ['sparkling eyes', 0, 13700], ['sailor collar', 0, 300000], ['highres', 5, 5900000],
  ['hatsune miku', 4, 120000], ['open', 0, 90000], ['lighthouse', 0, 9000],
];
const index = {
  names: ROWS.map(r => r[0]),
  lower: ROWS.map(r => r[0].toLowerCase()),
  counts: Int32Array.from(ROWS, r => r[2]),
  categories: Int8Array.from(ROWS, r => r[1]),
  descriptions: ROWS.map(() => ''),
  descLower: ROWS.map(() => null),
  get size() { return this.names.length; },
};

eq('a tag is found however it is spelled', [findTag(index, 'School_Uniform'), findTag(index, 'nope')], [4, -1]);
eq('escaped brackets fold away', tagKey('bob cut girl \\(memekko\\)'), 'bob cut girl (memekko)');

{
  const out = shapeAnimaPrompt('1girl, solo, short_hair, bob cut, a girl standing, smile', index);
  eq('tags stay tags, in the list\'s spelling', out.tags.slice(0, 5), ['1girl', 'solo', 'short hair', 'bob cut', 'standing']);
  check('the sentence is kept after them', /, a girl standing\.$/.test(out.prompt), out.prompt);
}
{
  const out = shapeAnimaPrompt('A cute young girl with a short bob haircut, chibi proportions, large sparkling eyes', index);
  eq('"a cute young girl" is 1girl', out.tags[0], '1girl');
  check('"bob haircut" is bob cut', out.tags.includes('bob cut'), out.tags.join());
  check('and tags inside a sentence are lifted out', out.tags.includes('chibi') && out.tags.includes('sparkling eyes'), out.tags.join());
  check('with the words themselves still there', out.prompt.includes('large sparkling eyes'));
}
{
  const out = shapeAnimaPrompt('the door was open beside a lighthouse', index);
  check('a common English word is not read as a tag', !out.tags.includes('open'));
  check('nor a rare single word inside prose', !out.tags.includes('lighthouse'));
  eq('but a phrase that is exactly a tag is one, whatever its count', shapeAnimaPrompt('lighthouse', index).tags, ['lighthouse']);
}
check('a meta tag is not a thing in the picture', !shapeAnimaPrompt('highres, 1girl', index).tags.includes('highres'));
check('a character is kept as a tag', shapeAnimaPrompt('hatsune miku, smile', index).tags.includes('hatsune miku'));
check('nothing is invented for a prompt with no tags in it',
  shapeAnimaPrompt('a stormy sea at dusk', index).tags.length === 0);
eq('no index, no change', shapeAnimaPrompt('x', { size: 0 }).changed, false);

const studio = read('server/studio.js');
check('the queue route shapes a chat prompt for Anima only when asked',
  /if \(job\.shapeTags && definition\.id === 'anima-base'\)/.test(studio));
check('and says what it sent', /\.\.\.\(shaped\?\.changed \? \{ prompt: shaped\.prompt, tags: shaped\.tags \} : \{\}\)/.test(studio));

/* ============================================= operations on a picture */

const O = await load('server/imageOps.js');
const info = (extra = {}) => ({
  LoadImage: {}, SaveImage: {}, ImageScaleBy: {},
  RMBG: { input: { required: { model: [['RMBG-2.0', 'BEN2']] } } },
  UpscaleModelLoader: { input: { required: { model_name: ['COMBO', { options: ['2x-AnimeSharpV4_Fast_RCAN_PU.safetensors', 'realesrganX4plusAnime_v1.pt'] }] } } },
  ImageUpscaleWithModel: {},
  'WD14Tagger|pysssss': { input: { required: { model: [['wd-v1-4-moat-tagger-v2', 'wd-swinv2-tagger-v3']] } } },
  ...extra,
});

{
  const { prompt } = O.removeBackgroundGraph({ image: 'p.png', objectInfo: info() });
  const rmbg = Object.values(prompt).find(n => n.class_type === 'RMBG');
  eq('background removal uses RMBG-2.0', rmbg.inputs.model, 'RMBG-2.0');
  eq('onto transparency', rmbg.inputs.background, 'Alpha');
  eq('and saves what it cut out', Object.values(prompt).find(n => n.class_type === 'SaveImage').inputs.images, ['2', 0]);
  eq('without the pack it says which', O.removeBackgroundGraph({ image: 'p.png', objectInfo: { LoadImage: {}, SaveImage: {} } }).missing, ['RMBG']);
}

{
  const two = O.upscaleGraph({ image: 'p.png', factor: 2, size: { width: 1000, height: 1000 }, objectInfo: info() });
  eq('twice the size takes the 2× model', two.prompt[2].inputs.model_name, '2x-AnimeSharpV4_Fast_RCAN_PU.safetensors');
  check('with nothing to scale back', !two.prompt[4]);
  const four = O.upscaleGraph({ image: 'p.png', factor: 4, size: { width: 1000, height: 1000 }, objectInfo: info() });
  eq('four times takes the 4× model', four.prompt[2].inputs.model_name, 'realesrganX4plusAnime_v1.pt');
  const capped = O.upscaleGraph({ image: 'p.png', factor: 4, size: { width: 2638, height: 3520 }, objectInfo: info() });
  check('a large picture is held under the limit', capped.factor < 2 && capped.prompt[4]?.inputs.scale_by < 1,
    JSON.stringify(capped.factor));
  // The 4× model, brought back down to the limit.
  const reached = 3520 * 4 * capped.prompt[4].inputs.scale_by;
  check('  which is measured on the longer side', Math.abs(reached - O.UPSCALE_LIMIT) < 2, String(reached));
  check('one already past it is refused, not enlarged by nothing',
    O.upscaleGraph({ image: 'p.png', size: { width: 6000, height: 6000 }, objectInfo: info() }).tooLarge === true);
}

{
  const { prompt } = O.tagGraph({ image: 'p.png', objectInfo: info() });
  eq('tags are read with the v3 tagger', prompt[2].inputs.model, 'wd-swinv2-tagger-v3');
  check('spelled with spaces', prompt[2].inputs.replace_underscore === true);
  eq('and come back as text', O.textsOf({ outputs: { 2: { tags: ['1girl, solo'] }, 9: { images: [{}] } } }), ['1girl, solo']);
}

check('the op route runs all three', /job\.op === 'rmbg'[\s\S]{0,200}job\.op === 'upscale'[\s\S]{0,300}job\.op === 'tag'/.test(studio));
check('with the chat model off the card first', /route\('\/studio\/op'[\s\S]{0,2600}await vram\.releaseLlm\(\)/.test(studio));
check('and a job that produced only text is finished', /if \(outputs\.length > 0 \|\| texts\.length > 0\)/.test(studio));

{
  // Through the route, with a ComfyUI that lacks the pack.
  const S = await load('server/studio.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).endsWith('/object_info') ? { LoadImage: {}, SaveImage: {} } : {}),
  });
  try {
    const handler = S.createStudioRoutes({}).find(r => r.path === '/studio/op').handler;
    const req = Readable.from([JSON.stringify({ op: 'rmbg', image: 'p.png' })]);
    req.url = '/studio/op'; req.method = 'POST'; req.headers = {};
    let payload = null, status = 200;
    await handler(req, { statusCode: 200, setHeader() {}, end(text) { payload = JSON.parse(text); status = this.statusCode; } });
    check('a missing pack is named before anything is queued', status === 400 && payload.missing?.includes('RMBG'), JSON.stringify(payload));
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ======================================== a mask handed in, not found */

const W = await load('server/workflows.js');
const byClass = (graph, cls) => Object.entries(graph).filter(([, n]) => n.class_type === cls);

{
  const graph = {
    a: { class_type: 'Load Image ED', inputs: { image: 'x.png' }, _meta: { source: '1176' } },
    b: { class_type: 'Efficient Loader ED', inputs: { paint_mode: '✍️ Txt2Img', mask: ['a', 1] }, _meta: { source: '1291' } },
    c: { class_type: 'KSampler ED', inputs: { denoise: 1 }, _meta: { source: '1298' } },
    e: { class_type: 'SaveImage', inputs: { images: ['c', 0], filename_prefix: 'webui/x' }, _meta: { source: '2' } },
  };
  const def = W.WORKFLOWS['anima-base'];
  W.applyImg2Img(graph, def, { image: 'padded.png', denoise: 1 });
  const out = W.applyRegionEdit(graph, def, {
    image: 'padded.png', maskImage: 'mask.png', maskGrow: 12, available: new Set([...W.MASK_NODES, 'GrowMaskWithBlur']),
  });
  check('a painted or extended area is redrawn', out.applied, JSON.stringify(out));
  eq('  from the mask as given', byClass(graph, 'LoadImageMask')[0]?.[1].inputs, { image: 'mask.png', channel: 'red' });
  check('  with no SAM3 anywhere', byClass(graph, 'SAM3Segment').length === 0);
  eq('  grown as asked', byClass(graph, 'GrowMaskWithBlur')[0]?.[1].inputs.expand, 12);
  eq('  and laid back over the canvas it was painted on', byClass(graph, 'LoadImage')[0]?.[1].inputs.image, 'padded.png');
  check('an extension, which builds its own edge, is not grown',
    !Object.values((() => {
      const g = JSON.parse(JSON.stringify({
        a: graph.a, b: { ...graph.b, inputs: { paint_mode: '✍️ Txt2Img' } }, c: graph.c,
        e: { class_type: 'SaveImage', inputs: { images: ['c', 0], filename_prefix: 'x' } },
      }));
      W.applyImg2Img(g, def, { image: 'p.png', denoise: 1 });
      W.applyRegionEdit(g, def, { image: 'p.png', maskImage: 'm.png', available: new Set(W.MASK_NODES) });
      return g;
    })()).some(n => /GrowMask/.test(n.class_type)));
}
check('the route takes a mask', /maskImage,\s*maskGrow: Number\(job\.maskGrow\) \|\| 0,/.test(studio));

/* ======================================================== extending */

const P = await load('src/pictureTools.js');
eq('horizontal grows both sides by half each', P.extensionMargins('horizontal', 0.5), { left: 0.25, right: 0.25, top: 0, bottom: 0 });
eq('one side takes it all', P.extensionMargins('left', 0.5), { left: 0.5, right: 0, top: 0, bottom: 0 });
eq('all is zoom out', P.extensionMargins('all', 1), { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5 });
eq('an amount out of range is clamped', P.extensionMargins('right', 9).right, 1);
{
  const layout = P.extensionLayout({ width: 1000, height: 1500 }, P.extensionMargins('horizontal', 0.5));
  eq('the canvas is wider by the margins', [layout.width, layout.height, layout.x, layout.y], [1500, 1500, 250, 0]);
  const huge = P.extensionLayout({ width: 6000, height: 4000 }, P.extensionMargins('horizontal', 1));
  check('and never past what a chat can hold, the original kept whole', huge.width <= 8192 && huge.x >= 0 && huge.width >= 6000);
}
{
  const s = P.samplingSize({ width: 1500, height: 1500 }, 1296 * 1728);
  check('the sampling size keeps the shape', Math.abs(s.width / s.height - 1) < 0.02);
  check('and the area', Math.abs(s.width * s.height - 1296 * 1728) / (1296 * 1728) < 0.05);
  check('in multiples of 16', s.width % 16 === 0 && s.height % 16 === 0);
}

/* ============================================================ the tools */

const T = await load('src/tools.js');
const names = T.TOOL_SCHEMAS.map(s => s.function.name);
check('the model is offered the three new tools', ['remove_background', 'upscale_image', 'extend_image'].every(n => names.includes(n)));
check('which are drawing tools: offered without the web switch, and ending the turn',
  ['TOOL_REMOVE_BACKGROUND', 'TOOL_UPSCALE_IMAGE', 'TOOL_EXTEND_IMAGE'].every(n => T.DRAWING_TAGS.has(n)));
eq('upscale becomes a tag', T.nativeCallToTag('upscale_image', { factor: 4 }), '<TOOL_UPSCALE_IMAGE factor="4"></TOOL_UPSCALE_IMAGE>');
eq('so does extend', T.nativeCallToTag('extend_image', { direction: 'left', amount: 0.3, prompt: 'a beach' }),
  '<TOOL_EXTEND_IMAGE direction="left" amount="0.3">a beach</TOOL_EXTEND_IMAGE>');
eq('and background removal', T.nativeCallToTag('remove_background', {}), '<TOOL_REMOVE_BACKGROUND></TOOL_REMOVE_BACKGROUND>');
check('several at once is a count on the drawing', /count="3"/.test(T.nativeCallToTag('generate_image', { prompt: 'x', count: 3 })));

const R = await load('src/toolResults.js');
eq('what the tools tell the model is not shown to the reader',
  R.stripInstructions('The background was removed and the cut-out, on transparency, is already displayed to the user.'), '');
eq('nor for several pictures',
  R.stripInstructions('3 images were generated and are already displayed to the user beneath your reply.'), '');
eq('and each is named for the reader', R.verbKey('TOOL_UPSCALE_IMAGE'), 'tool.did.upscale');

const { parseAssistantMessage } = await load('src/messageParts.js');
check('the new calls go to the thinking dropdown too',
  parseAssistantMessage('<TOOL_UPSCALE_IMAGE factor="2"></TOOL_UPSCALE_IMAGE>')[0]?.type === 'tool_call');

/* ============================================================= the app */

const app = read('src/App.jsx');
check('each new tag has an executor', ['TOOL_REMOVE_BACKGROUND', 'TOOL_UPSCALE_IMAGE', 'TOOL_EXTEND_IMAGE']
  .every(n => new RegExp(`name: '${n}',\\s*\\n\\s*pattern: new RegExp`).test(app)));
check('several pictures come from one call', /const pictures = await generateImages\(count, prompt, style, negative, edit,/.test(app));
check('one after another, not as one batch', /for \(let i = 0; i < total; i \+= 1\)[\s\S]{0,160}await generateOneImage\(/.test(app));

// The chat's workflow, from the Studio's setting.
check('the chat reads which workflow draws', /const chatImageModel = \(style\) => \{[\s\S]{0,300}CHAT_PICTURE_KEY/.test(app));
check('and asks Anima for tags and a sentence', /model === 'anima-base' \? \{ shapeTags: true \} : \{\}/.test(app));
check('and tells the model which way to write the prompt', /const promptAdvice = pictureModel === 'anima-base'/.test(app)
  && /\$\{promptAdvice\}/.test(app));
const S2 = await load('src/studioSettings.js');
eq('the setting has three values', S2.CHAT_PICTURE_MODELS, ['auto', 'anima-base', 'krea2-turbo']);
const panel = read('src/StudioPanel.jsx');
check('and is set in the Studio', /writeChatPictureModel\(scope, e\.target\.value\)/.test(panel));

// Painting.
check('a painted area rides on the question', /tempUserMessage\.paint = paint;/.test(app));
check('the model is told on the wire, not in the transcript',
  /tempUserMessage\.paint = paint;\s*\n\s*finalInputText \+= /.test(app));
check('and the executor uses that picture and that mask', /const paint = thisTurn\[0\]\?\.paint \|\| null;/.test(app)
  && /paint \? \{ mask: paint\.mask, maskGrow: 12 \} : \{\}/.test(app));
check('the editor sends it through the chat', /pendingPaintRef\.current = \{ mask, target: target\.filename \|\| '' \};/.test(app));
const editor = read('src/MaskEditor.jsx');
check('the mask is built at the picture\'s own size', /canvas\.width = width;\s*\n\s*canvas\.height = height;/.test(editor));
check('and exported as white on black', /toDataURL\('image\/png'\)/.test(editor) && /fillStyle = '#000'/.test(editor));

// The buttons under a picture.
for (const kind of ['redraw', 'paint', 'rmbg', 'upscale', 'tags', 'download']) {
  check(`a picture offers "${kind}"`, new RegExp(`pictureAction\\('${kind}', picture\\)`).test(app));
}
check('an action writes its own turn into the chat', /const runPictureAction = async \(\{ request, call, work \}\)/.test(app));

// The gallery.
check('the gallery is one of the sidebar places', /\['gallery', t\('gallery\.tab'\)\]/.test(app));
/* It shares the Studio's overlay class, whose `overflow: hidden` comes from a
   stylesheet loaded later -- so a one-class rule lost and the gallery could not
   scroll. Measured in a browser: overflow-y was `hidden` with 2235px of
   pictures in an 844px window. */
check('and scrolls, by a rule that outranks the Studio\'s overflow: hidden',
  /\.studio-place\.gallery-place \{[^}]*overflow-y: auto/.test(read('src/extras.css')));
/* The one place that collects every picture was the one place that showed
   them all bare. Each card is judged like the place it came from and shares
   that place's reveal. */
const gallery = read('src/PictureGallery.jsx');
check('gallery cards are behind the same glass', /<Veil verdict=\{judged\} level=\{level\} revealKey=\{revealKey\}/.test(gallery));
check('judged from the picture, the prompt, or the Studio\'s verdict',
  /useVerdict\(\{[\s\S]{0,200}prompt: item\.prompt,\s*\n\s*known: item\.job\?\.safety\?\.verdict,/.test(gallery));
check('a film by its prompt, as in the Studio', /item\.video \? \(asked \|\| 'safe'\) : verdict/.test(gallery));
check('revealed in the chat is revealed here', /item\.source === 'studio' \? item\.full : cacheKey\(item\.full\)/.test(gallery));
/* And in the chat the glass is the picture's size: stretched to the column --
   as wide as the row of actions under the picture -- its line sat 19px right
   of the picture's centre. */
check('a chat picture\'s frame is the picture\'s size',
  /\.msg-generated figure > \.safe-frame \{ align-self: flex-start; max-width: 100%; \}/.test(read('src/safeguard.css')));

const G = await load('src/galleryItems.js');
{
  const sessions = [{ id: 's', title: 'Cats', messages: [
    { role: 'user', content: 'draw' },
    { role: 'assistant', content: 'x', at: 5, generated: [{ dataUrl: 'data:image/png;base64,AA', prompt: 'a cat', filename: 'c.png' }] },
  ] }];
  const items = G.chatPictures(sessions);
  eq('every chat picture, with the way back to it', [items.length, items[0].sessionId, items[0].index, items[0].prompt], [1, 's', 1, 'a cat']);
  const jobs = [{ id: 'j', state: 'done', prompt: 'a dog', finishedAt: 9, outputs: [{ url: '/studio/view?filename=a.png', media: 'image' }] },
    { id: 'k', state: 'running', outputs: [] }];
  const studioItems = G.studioPictures(jobs, (u) => `${u}&preview=webp;85`);
  eq('and every finished Studio picture, as the lighter copy', [studioItems.length, studioItems[0].src.endsWith('webp;85')], [1, true]);
}

/* ------------------------------------------------- what a result was made with */

const PS = await load('src/pictureSettings.js');
const drawn = {
  model: 'anima-base', seed: 7, prompt: '1girl, shrine', negative: 'lowres', style: 'anime',
  settings: {
    workflow: 'Anima Base', width: 832, height: 1216, seed: 7, steps: 28, cfg: 5.5000001,
    sampler: 'euler', scheduler: 'karras', checkpoint: 'anime\\anima.safetensors', denoise: 0.65,
    loras: [{ name: 'styles/ink.safetensors', weight: 0.8 }],
  },
};
const rows = PS.settingsRows(drawn);
const valueOf = (key, list = rows) => list.find(r => r.key === key)?.value;
eq('the workflow comes first', rows[0].key, 'workflow');
eq('the size reads as one value', valueOf('size'), '832×1216');
eq('a float as it would be typed', valueOf('cfg'), '5.5');
eq('a file without its folders', valueOf('checkpoint'), 'anima.safetensors');
eq('but the whole path is there to hover', rows.find(r => r.key === 'checkpoint').title, 'anime\\anima.safetensors');
eq('LoRAs with their weights', valueOf('loras'), 'ink.safetensors (0.8)');
eq('the words come last', rows.slice(-2).map(r => r.key), ['negative', 'prompt']);
check('nothing it does not know is shown', !rows.some(r => r.key === 'fps' || r.key === 'duration'));

// A picture from before settings were recorded: what the PNG says, under what
// the result itself kept.
const older = PS.settingsRows({ model: 'krea2-turbo', seed: 99, prompt: 'a lighthouse' },
  { prompt: 'a lighthouse', steps: 8, seed: 12, sampler: 'euler', width: 1024, height: 1360 });
eq('an older picture is read from its file', valueOf('steps', older), '8');
eq('but the seed it kept outranks the one in the graph', valueOf('seed', older), '99');
eq('and its workflow is named', valueOf('workflow', older), 'Krea 2 Turbo');
eq('a video says how long it is', valueOf('duration', PS.settingsRows({ model: 'minimax-h3', duration: 6 })), '6s');
eq('an operation carries what it did', PS.settingsRows({ op: 'upscale', factor: 2 }).find(r => r.key === 'op')?.factor, 2);
eq('copied as one line per setting',
  PS.settingsText([{ key: 'seed', value: '7' }, { key: 'steps', value: '28' }], r => r.key), 'seed: 7\nsteps: 28');

check('a drawn picture keeps what it was drawn with', /settings: queued\.settings/.test(app));
check('and its settings open from under it', /<PictureSettings picture=\{picture\}/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
