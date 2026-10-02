// Three things that went wrong around a picture asked for in conversation.
//
//   1. Exported as Markdown or HTML, the answer to "draw me one" was missing:
//      the picture was never exported, and the text was only the call.
//   2. The call itself -- `<TOOL_GENERATE_IMAGE style="anime" ...>` -- was shown
//      to the reader as part of the answer, prompt and all.
//   3. "Make her hair short" came back with short hair and a different collar,
//      buttons, socks and shoes: an edit redrew the whole picture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const CALL = '<TOOL_GENERATE_IMAGE style="anime" negative="long hair, ponytail" from="last_image" '
  + 'change="0.65" region="hair">A cute girl with a short bob</TOOL_GENERATE_IMAGE>';
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;

/* ============================================ 2. the call, in the dropdown */

const { parseAssistantMessage } = await load('src/messageParts.js');

{
  const blocks = parseAssistantMessage(`네, 단발로 바꿔 드릴게요.\n${CALL}`);
  const text = blocks.filter(b => b.type === 'text');
  const call = blocks.find(b => b.type === 'tool_call');
  eq('the words stay the answer', text.map(b => b.content), ['네, 단발로 바꿔 드릴게요.']);
  check('and the call is not among them', !text.some(b => b.content.includes('TOOL_GENERATE_IMAGE')));
  check('it is a tool call, for the thinking dropdown', !!call);
  eq('  which tool', call?.tool, 'TOOL_GENERATE_IMAGE');
  eq('  its attributes, by name', [call?.attrs.style, call?.attrs.from, call?.attrs.region], ['anime', 'last_image', 'hair']);
  eq('  its prompt', call?.content, 'A cute girl with a short bob');
  check('  and the prompt is not mistaken for a path', call?.path === undefined);
}

{
  const blocks = parseAssistantMessage('<TOOL_GENERATE_IMAGE negative="x" style="photo">a lighthouse</TOOL_GENERATE_IMAGE>');
  check('attributes in any order', blocks.length === 1 && blocks[0].type === 'tool_call');
}

{
  // The tools that were handled before still are.
  const [search] = parseAssistantMessage('<TOOL_SEARCH_FILES path="C:\\src" query="todo"></TOOL_SEARCH_FILES>');
  eq('a file search keeps its path', search.path, 'C:\\src');
  eq('and its query', search.query, 'todo');
  const [read] = parseAssistantMessage('<TOOL_READ_FILE>C:\\notes.txt</TOOL_READ_FILE>');
  eq('a read keeps the path in its body', read.path, 'C:\\notes.txt');
  const parts = parseAssistantMessage('<think>hm</think>\nAnswer.\n<TOOL_RESULT>out</TOOL_RESULT>');
  eq('reasoning, text and results still split', parts.map(b => b.type), ['think', 'text', 'tool_result']);
}

{
  /* Still being written. For the seconds a model takes to write a prompt the
     tag has no end, and the raw tag was on screen until it did. */
  const half = '그려 드릴게요.\n<TOOL_GENERATE_IMAGE style="anime" negative="blur">A cute gi';
  const live = parseAssistantMessage(half, { streaming: true });
  eq('while streaming, a half-written call is a pending step', live.map(b => b.type), ['text', 'tool_call']);
  check('  marked as pending', live[1].pending === true);
  eq('  with what is written so far', live[1].content, 'A cute gi');
  check('  and none of it in the answer', !live[0].content.includes('<TOOL'));
  const opening = parseAssistantMessage('<TOOL_GENERATE_IMAGE sty', { streaming: true });
  eq('even before its opening tag is finished', opening.map(b => b.type), ['tool_call']);
  // A finished message that mentions an opening tag wrote it on purpose.
  const settled = parseAssistantMessage('Write <TOOL_TIME> to ask for the time.');
  eq('once finished, an unclosed tag is text', settled.map(b => b.type), ['text']);
}

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the transcript uses the parser', /parseAssistantMessage\(gMsg\.content, \{/.test(app));
check('telling it which message is still arriving', /streaming: streamingNow && n === group\.length - 1/.test(app));
/* A call that never ran looks like one that worked unless it says otherwise. It
   says so the way a failed tool does. */
check('a call nobody answered is shown as not run',
  /const notRun = !answered && !isStreamingRow && !part\.pending;/.test(app)
  && /\{notRun && \([\s\S]{0,200}tool-receipt is-failed[\s\S]{0,300}t\('tool\.notRun'\)/.test(app));
check('a drawing is answered by its picture', /\|\| \(isDrawing && drewInGroup\)/.test(app));
const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
eq('every language names "tool.notRun"', i18n.split("'tool.notRun':").length - 1, 12);

/* ================================================== 1. the export */

const { exportTurns, sessionToMarkdown, sessionToHtml } = await load('src/htmlExport.js');

const session = {
  title: 'Drawing',
  messages: [
    { role: 'user', content: '귀여운 여자아이 그려줘' },
    // The whole text of the answer is the call; the picture is beside it.
    { role: 'assistant', content: CALL, generated: [{ dataUrl: PNG, prompt: 'A cute girl [bob]\nline two' }] },
    { role: 'user', content: '단발로 바꿔줘' },
    // A tool loop: a leg, the result, and the reply after it.
    { role: 'assistant', content: `바꿔 볼게요.\n${CALL}` },
    { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_GENERATE_IMAGE ---\nThe image was generated.\n</TOOL_RESULT>' },
    { role: 'assistant', content: '단발로 바꿨어요!', generated: [{ dataUrl: PNG, prompt: 'bob' }] },
    { role: 'assistant', content: 'hostile', generated: [{ dataUrl: 'javascript:alert(1)' }, { dataUrl: 'https://x.test/a.png' }] },
  ],
};

const turns = exportTurns(session);
eq('a turn per question and per answer', turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant']);
check('an answer that was only a call is kept, for its picture', turns[1].media.length === 1 && turns[1].body === '');
eq('a tool loop is one answer', turns[3].body, '바꿔 볼게요.\n\n단발로 바꿨어요!\n\nhostile');
check('with its picture', turns[3].media.length === 1);
check('and the call is in neither', !turns.some(t => t.body.includes('TOOL_')));
check('nothing but an embedded image or film is embedded',
  !turns.some(t => t.media.some(m => !m.dataUrl.startsWith('data:image/'))));

const md = sessionToMarkdown(session);
check('the Markdown has the answer to "draw me one"',
  md.indexOf('## 🤖 Assistant') > md.indexOf('귀여운 여자아이 그려줘')
  && md.indexOf('![') > md.indexOf('## 🤖 Assistant'));
check('as the picture itself, embedded', md.includes(`](${PNG})`));
check('with its prompt as a one-line caption', md.includes('![A cute girl bob line two]('));
check('and no tool tags', !md.includes('<TOOL_'));

const html = sessionToHtml(session);
check('the HTML shows the picture', html.includes(`<img src="${PNG}"`));
check('with its prompt as alt text', /alt="A cute girl bob line two"/.test(html));
check('and nothing from outside', !html.includes('javascript:') && !html.includes('https://x.test'));
check('the app exports Markdown through the same code',
  /import \{ sessionToHtml, sessionToPrintableHtml, sessionToMarkdown \} from '\.\/htmlExport\.js';/.test(app)
  && !/const sessionToMarkdown = /.test(app));

/* ================================================= 3. editing one part */

const W = await load('server/workflows.js');

eq('the part to change, as nouns', W.regionTerms(' hair , shoulders,, eyes, sky '), ['hair', 'shoulders', 'eyes']);
eq('none is none', W.regionTerms(''), []);

const everything = new Set([...W.REGION_NODES, 'GrowMaskWithBlur', 'DifferentialDiffusion']);

/** Anima's graph, reduced to the nodes the edit touches. */
const anima = () => ({
  m: { class_type: 'UNETLoader', inputs: {}, _meta: { source: 'unet' } },
  g: { class_type: 'Ext Model Input ED', inputs: { model: ['m', 0] }, _meta: { source: '1300' } },
  a: { class_type: 'Load Image ED', inputs: { image: 'x.png' }, _meta: { source: '1176' } },
  b: { class_type: 'Efficient Loader ED', inputs: { paint_mode: '✍️ Txt2Img', pixels: ['a', 0], mask: ['a', 1] }, _meta: { source: '1291' } },
  c: { class_type: 'KSampler ED', inputs: { denoise: 1 }, _meta: { source: '1298' } },
  d: { class_type: 'Upscaler', inputs: { image: ['c', 0] }, _meta: { source: '28' } },
  e: { class_type: 'Save Image ED', inputs: { image_opt: ['d', 0], context_opt: ['c', 0], filename_prefix: 'webui/x' }, _meta: { source: '2' } },
  f: { class_type: 'PreviewImage', inputs: { images: ['d', 0] }, _meta: { source: '25' } },
});
const byClass = (graph, cls) => Object.entries(graph).filter(([, n]) => n.class_type === cls);

{
  const graph = anima();
  const def = W.WORKFLOWS['anima-base'];
  W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 0.9, size: { width: 832, height: 1216 } });
  const out = W.applyRegionEdit(graph, def, { image: 'ref.png', region: 'hair', available: everything });
  check('anima redraws only the hair', out.applied, JSON.stringify(out));

  const [[samKey, sam]] = byClass(graph, 'SAM3Segment');
  eq('  found by SAM3, from the word', sam.inputs.prompt, 'hair');
  eq('  in the picture as the sampler sees it', sam.inputs.image, ['a', 0]);
  /* SAM3Segment's offset is a dilation of n² run twice, and its blur greys the
     thin ends of the hair into ghosts. Both measured, both left at zero. */
  eq('  with neither its own offset nor its own blur', [sam.inputs.mask_offset, sam.inputs.mask_blur], [0, 0]);
  const [[growKey, grow]] = byClass(graph, 'GrowMaskWithBlur');
  eq('  grown past the old outline', grow.inputs.mask, [samKey, 1]);
  check('  and only then softened', grow.inputs.expand > grow.inputs.blur_radius && grow.inputs.blur_radius > 0);
  eq('  the loader inpaints', graph.b.inputs.paint_mode, '🎨 Inpaint(Ksampler)');
  eq('  inside that mask', graph.b.inputs.mask, [growKey, 0]);

  const [[compKey, comp]] = byClass(graph, 'ImageCompositeMasked');
  eq('  and the finished picture goes back over the original', comp.inputs.source, ['d', 0]);
  eq('  through the same mask', comp.inputs.mask, [growKey, 0]);
  check('  at whatever size the original is', comp.inputs.resize_source === true);
  const [[, original]] = byClass(graph, 'LoadImage');
  eq('  the original, at full size', original.inputs.image, 'ref.png');
  eq('  which is what is saved', graph.e.inputs.image_opt, [compKey, 0]);
  eq('  and what every preview shows', graph.f.inputs.images, [compKey, 0]);
  eq('  while the save keeps its context', graph.e.inputs.context_opt, ['c', 0]);

  /* Reported: the edge of an edited part looked pasted on -- a smudged band
     along the hem with the old lace showing through. A noise mask alone is all
     or nothing, however soft its edge; DifferentialDiffusion makes the sampler
     follow the grey, so the edge fades into the picture as it was. */
  const [[ddKey, dd]] = byClass(graph, 'DifferentialDiffusion');
  eq('  the edge fades rather than cuts: the model goes through DifferentialDiffusion', graph.g.inputs.model, [ddKey, 0]);
  eq('  wrapping the model it was given', dd.inputs.model, ['m', 0]);
  check('  and says it did', out.smoothed === true);
  check('  the edge is soft enough to fade across, and still grown first', grow.inputs.blur_radius >= 8 && grow.inputs.expand > grow.inputs.blur_radius);
}

/* Reported: a new black bow ended in a strip of the old pink one. SAM3 leaves
   what is on the clothes out of "clothes", the holes survive the grow, and the
   composite puts the original back through them. Closed, where comfyui_essentials
   is installed -- after the grow, so only what the grow nearly closed is. */
{
  const graph = anima();
  const def = W.WORKFLOWS['anima-base'];
  W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 1, size: { width: 832, height: 1216 } });
  W.applyRegionEdit(graph, def, { image: 'ref.png', region: 'clothes', available: new Set([...everything, 'MaskFix+']) });
  const [[samKey]] = byClass(graph, 'SAM3Segment');
  const grows = byClass(graph, 'GrowMaskWithBlur');
  const [[closeKey, close]] = byClass(graph, 'MaskFix+');
  const hard = grows.find(([, n]) => n._meta.source === 'region#grow-hard')?.[1];
  const [softKey, soft] = grows.find(([, n]) => n._meta.source === 'region#grow') || [];
  check('small holes are closed: grown hard first', hard && hard.inputs.mask[0] === samKey && hard.inputs.expand === 40 && hard.inputs.blur_radius === 0);
  eq('  then closed', close.inputs.mask[0], grows.find(([, n]) => n === hard)[0]);
  check('  by less than the grow nearly closed -- a hand on the dress stays out', close.inputs.fill_holes > 0 && close.inputs.fill_holes <= 2 * hard.inputs.expand);
  check('  and softened last', soft.inputs.mask[0] === closeKey && soft.inputs.expand === 0 && soft.inputs.blur_radius === 12);
  eq('  which is the mask the edit uses', graph.b.inputs.mask, [softKey, 0]);
  eq('  and the composite', byClass(graph, 'ImageCompositeMasked')[0][1].inputs.mask, [softKey, 0]);
  /* A painted one too: the gaps a brush leaves between strokes were threads of
     the old picture through the new one. Closed by as much as it is grown, so a
     hole the size of a face, painted round on purpose, stays. */
  /* Reported: the ends of what was masked were left behind -- lace reaching past SAM3's outline, half kept in the soft edge. Clothes and the background are widened further; the hair, eyes and face are not, where 40 below a fringe is the eyes. */
  eq('clothes are widened further than the hair', [W.regionGrow(['clothes']), W.regionGrow(['hair'])], [40, 24]);
  eq('  any garment, or the background', [W.regionGrow(['black dress']), W.regionGrow(['shirt', 'hair']), W.regionGrow(['background'])], [40, 40, 40]);
  eq('  and not the face or eyes', [W.regionGrow(['eyes']), W.regionGrow(['face']), W.regionGrow([])], [24, 24, 24]);
  const hairGraph = anima();
  W.applyImg2Img(hairGraph, def, { image: 'ref.png', denoise: 1, size: { width: 832, height: 1216 } });
  W.applyRegionEdit(hairGraph, def, { image: 'ref.png', region: 'hair', available: new Set([...everything, 'MaskFix+']) });
  eq('  so a hair edit is grown as before', byClass(hairGraph, 'GrowMaskWithBlur').find(([, n]) => n._meta.source === 'region#grow-hard')?.[1].inputs.expand, 24);
  const painted = anima();
  W.applyImg2Img(painted, def, { image: 'ref.png', denoise: 1 });
  W.applyRegionEdit(painted, def, { image: 'ref.png', maskImage: 'mask.png', maskGrow: 40, available: new Set([...W.MASK_NODES, 'GrowMaskWithBlur', 'MaskFix+']) });
  const [[, paintedClose]] = byClass(painted, 'MaskFix+');
  const paintedGrows = byClass(painted, 'GrowMaskWithBlur').map(([, n]) => n.inputs);
  eq('a painted mask is grown, its gaps closed, then softened',
    [paintedGrows[0].expand, paintedGrows[0].blur_radius, paintedClose.inputs.fill_holes, paintedGrows[1].expand, paintedGrows[1].blur_radius],
    [40, 0, 40, 0, 20]);
  const extended = anima();
  W.applyImg2Img(extended, def, { image: 'ref.png', denoise: 1 });
  W.applyRegionEdit(extended, def, { image: 'ref.png', maskImage: 'margin.png', maskGrow: 0, available: new Set([...W.MASK_NODES, 'GrowMaskWithBlur', 'MaskFix+']) });
  eq('an extended canvas\'s margin is left exactly as it was built', byClass(extended, 'MaskFix+').length + byClass(extended, 'GrowMaskWithBlur').length, 0);
}

{
  const { paintedGrow } = await load('src/pictureTools.js');
  eq('a painted area is widened by a share of the picture', paintedGrow({ width: 2638, height: 3520 }), 53);
  eq('and never by less than it was', paintedGrow({ width: 512, height: 512 }), 12);
  eq('an unmeasured one by the least', paintedGrow({}), 12);
  check('the chat asks for it rather than a fixed 12',
    /const grow = paint \? paintedGrow\(await pictureSize\(edit\.dataUrl\)\.catch\(\(\) => \(\{\}\)\)\) : 0;/.test(app)
    && /mask: paint\.mask, maskGrow: grow/.test(app));
}

{
  const graph = {
    '1': { class_type: 'VAELoader', inputs: {}, _meta: { source: '30:12' } },
    '2': { class_type: 'EmptyLatentImage', inputs: {}, _meta: { source: '30:5' } },
    '3': { class_type: 'KSampler', inputs: { latent_image: ['2', 0], denoise: 1 }, _meta: { source: '30:3' } },
    '4': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] }, _meta: { source: '30:8' } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'webui/x' }, _meta: { source: '1' } },
  };
  const def = W.WORKFLOWS['krea2-turbo'];
  W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 0.9, size: { width: 832, height: 1216 } });
  const out = W.applyRegionEdit(graph, def, { image: 'ref.png', region: 'hair, shoulders', available: new Set(W.REGION_NODES) });
  check('krea 2 redraws only the region', out.applied, JSON.stringify(out));
  eq('  one search per part', byClass(graph, 'SAM3Segment').map(([, n]) => n.inputs.prompt), ['hair', 'shoulders']);
  const [[, union]] = byClass(graph, 'MaskComposite');
  eq('  joined without rounding the edge away', union.inputs.operation, 'add');
  check('  grown with ComfyUI\'s own node when KJNodes is absent', byClass(graph, 'GrowMask').length === 1);
  const [[noiseKey, noise]] = byClass(graph, 'SetLatentNoiseMask');
  const encodeKey = byClass(graph, 'VAEEncode')[0][0];
  eq('  the encoded picture is masked', noise.inputs.samples, [encodeKey, 0]);
  eq('  before the sampler sees it', graph['3'].inputs.latent_image, [noiseKey, 0]);
  eq('  stretched rather than cropped, so it lines up again', byClass(graph, 'ImageScale')[0][1].inputs.crop, 'disabled');
  eq('  the picture already loaded is reused for the original', byClass(graph, 'LoadImage').length, 1);
  eq('  and the save gets the composite', graph['5'].inputs.images, [byClass(graph, 'ImageCompositeMasked')[0][0], 0]);
  check('  and a ComfyUI without DifferentialDiffusion gets the edge as before',
    byClass(graph, 'DifferentialDiffusion').length === 0 && out.smoothed === false);
}

{
  // Krea 2, where this ComfyUI has DifferentialDiffusion: it goes on the sampler's model.
  const graph = {
    '0': { class_type: 'UNETLoader', inputs: {}, _meta: { source: '30:1' } },
    '1': { class_type: 'VAELoader', inputs: {}, _meta: { source: '30:12' } },
    '2': { class_type: 'EmptyLatentImage', inputs: {}, _meta: { source: '30:5' } },
    '3': { class_type: 'KSampler', inputs: { model: ['0', 0], latent_image: ['2', 0], denoise: 1 }, _meta: { source: '30:3' } },
    '4': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] }, _meta: { source: '30:8' } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'webui/x' }, _meta: { source: '1' } },
  };
  const def = W.WORKFLOWS['krea2-turbo'];
  W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 0.9, size: { width: 832, height: 1216 } });
  const out = W.applyRegionEdit(graph, def, { image: 'ref.png', region: 'clothes', available: everything });
  const [[ddKey, dd]] = byClass(graph, 'DifferentialDiffusion');
  eq('krea 2\'s sampler draws through DifferentialDiffusion', graph['3'].inputs.model, [ddKey, 0]);
  eq('  wrapping its own model', dd.inputs.model, ['0', 0]);
  check('  reported', out.smoothed === true);
  eq('  and no Anima guide on a model it was not trained for', byClass(graph, 'AnimaLLLiteApply').length, 0);
}

/* Reported: after the edge was fixed, changing the outfit still came back with
   a second hand under the bear and blurred skin on the arms. The clothes mask
   covers the arms under a sheer dress and they were redrawn from the prompt
   alone. The inpainting LLLite sees the picture around the mask, so what is
   drawn inside continues what is outside. */
{
  eq('the newest inpainting guide is picked',
    W.pickInpaintLLLite(['anima-lllite-pose-1.safetensors', 'anima-lllite-inpainting-v1.safetensors', 'anima-lllite-inpainting-v2.safetensors']),
    'anima-lllite-inpainting-v2.safetensors');
  eq('and none when there is none', W.pickInpaintLLLite(['anima-lllite-pose-1.safetensors']), '');

  const withGuide = new Set([...everything, 'ModelPatchLoader', 'AnimaLLLiteApply']);
  const graph = anima();
  const def = W.WORKFLOWS['anima-base'];
  W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 1 });
  const out = W.applyRegionEdit(graph, def, {
    image: 'ref.png', region: 'clothes', available: withGuide, patches: ['anima-lllite-inpainting-v2.safetensors'],
  });
  const [[, load]] = byClass(graph, 'ModelPatchLoader');
  const [[lliteKey, lllite]] = byClass(graph, 'AnimaLLLiteApply');
  const [[ddKey, dd]] = byClass(graph, 'DifferentialDiffusion');
  eq('anima is guided by the inpainting LLLite', load.inputs.name, 'anima-lllite-inpainting-v2.safetensors');
  eq('  on the model it was given', lllite.inputs.model, ['m', 0]);
  eq('  shown the picture as the sampler sees it', lllite.inputs.image, ['a', 0]);
  eq('  and the region', lllite.inputs.mask, graph.b.inputs.mask);
  eq('  at full strength, all the way through', [lllite.inputs.strength, lllite.inputs.start_percent, lllite.inputs.end_percent], [1, 0, 1]);
  eq('  under the soft edge', dd.inputs.model, [lliteKey, 0]);
  eq('  which is what the sampler draws with', graph.g.inputs.model, [ddKey, 0]);
  check('  and says which guide it used', out.guided === 'anima-lllite-inpainting-v2.safetensors');

  const plain = anima();
  W.applyImg2Img(plain, def, { image: 'ref.png', denoise: 1 });
  const bare = W.applyRegionEdit(plain, def, { image: 'ref.png', region: 'clothes', available: withGuide, patches: [] });
  check('without the file there is no guide, and the edit is as before',
    byClass(plain, 'AnimaLLLiteApply').length === 0 && bare.applied && !bare.guided);
  const noNode = anima();
  W.applyImg2Img(noNode, def, { image: 'ref.png', denoise: 1 });
  W.applyRegionEdit(noNode, def, { image: 'ref.png', region: 'clothes', available: everything, patches: ['anima-lllite-inpainting-v2.safetensors'] });
  eq('nor on a ComfyUI without the node', byClass(noNode, 'AnimaLLLiteApply').length, 0);

  const studioSource = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8');
  check('the queue route hands over what model_patches holds',
    /patches: installed\.objectInfo\?\.ModelPatchLoader\?\.input\?\.required\?\.name\?\.\[0\] \|\| \[\],/.test(studioSource));
  /* And says which guide ran, beside the result. An edit that came back
     unnatural is the reported symptom, and whether the guide was in the graph
     at all is the first thing to know about it. */
  check('and records which guide ran, and how hard',
    /guide = region\.guided \|\| '';/.test(studioSource)
    && /guideStrength = region\.strength;/.test(studioSource)
    && /\.\.\.\(guide \? \{ guide, guideStrength \} : \{\}\),/.test(studioSource));
  check('the queue route hands the two dials over as they were set',
    /guideStrength: job\.guideStrength,/.test(studioSource)
    && /growScale: job\.maskGrowScale,/.test(studioSource));
}

/* Krea 2 has no guide for the arms under new clothes: its pose ControlNet was
   tried and blotched the dress. It keeps the soft edge, and nothing else. */
{
  const krea = () => ({
    '0': { class_type: 'UNETLoader', inputs: {}, _meta: { source: '30:10' } },
    '1': { class_type: 'VAELoader', inputs: {}, _meta: { source: '30:12' } },
    '2': { class_type: 'EmptyLatentImage', inputs: {}, _meta: { source: '30:5' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['11', 0], text: ['21', 0] }, _meta: { source: '30:6' } },
    '13': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] }, _meta: { source: '30:13' } },
    '3': { class_type: 'KSampler', inputs: { model: ['0', 0], positive: ['6', 0], negative: ['13', 0], latent_image: ['2', 0], denoise: 1 }, _meta: { source: '30:3' } },
    '4': { class_type: 'VAEDecode', inputs: { samples: ['3', 0] }, _meta: { source: '30:8' } },
    '5': { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: 'webui/x' }, _meta: { source: '1' } },
  });
  const ostris = new Set([...everything, 'DWPreprocessor', 'TextEncodeKrea2OstrisEdit', 'Krea2OstrisEditModelPatch', 'LoraLoaderModelOnly']);
  const graph = krea();
  W.applyImg2Img(graph, W.WORKFLOWS['krea2-turbo'], { image: 'ref.png', denoise: 1, size: { width: 832, height: 1216 } });
  const out = W.applyRegionEdit(graph, W.WORKFLOWS['krea2-turbo'], { image: 'ref.png', region: 'clothes', available: ostris });
  const [[ddKey, dd]] = byClass(graph, 'DifferentialDiffusion');
  check('a Krea 2 region edit is made', out.applied);
  eq('  under the soft edge, on the model it was given', dd.inputs.model, ['0', 0]);
  eq('  which is what the sampler draws with', graph['3'].inputs.model, [ddKey, 0]);
  eq('  from the prompt as written', graph['3'].inputs.positive, ['6', 0]);
  check('  with no pose guide, even where its nodes are installed',
    ['DWPreprocessor', 'TextEncodeKrea2OstrisEdit', 'Krea2OstrisEditModelPatch', 'LoraLoaderModelOnly', 'AnimaLLLiteApply']
      .every(cls => byClass(graph, cls).length === 0));
}

{
  const graph = anima();
  const def = W.WORKFLOWS['anima-base'];
  W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 0.9 });
  const out = W.applyRegionEdit(graph, def, { image: 'ref.png', region: 'hair', available: new Set(['LoadImage']) });
  check('without SAM3 it says so rather than guessing', !out.applied && out.reason === 'missing'
    && out.missing.includes('SAM3Segment'));
  eq('  and leaves the loader as an ordinary edit', graph.b.inputs.paint_mode, '🦱 Img2Img');
  check('no region is no region edit', !W.applyRegionEdit(anima(), def, { image: 'r.png', region: '' }).applied);
  check('nor for a workflow that cannot', !W.applyRegionEdit({}, W.WORKFLOWS['minimax-h3'], { image: 'r.png', region: 'hair' }).applied);
}

const studio = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8');
check('the queue route applies it',
  /applyRegionEdit\(graph, definition, \{\s*image: job\.referenceImage,\s*region: job\.region,\s*maskImage,/.test(studio));
// Without a region to protect the rest, 0.9 would redraw the whole picture into another one.
check('and eases off when it cannot', /Math\.min\(Number\(job\.denoise\), 0\.8\)/.test(studio));
check('saying the edit became a whole-picture one', /the whole picture was edited instead/.test(studio));

const tools = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
check('the model is offered the region', /region: \{\s*type: 'string'/.test(tools));
const { nativeCallToTag } = await load('src/tools.js');
check('and a structured call carries it into the tag',
  /region="hair"/.test(nativeCallToTag('generate_image', { prompt: 'x', from: 'last_image', region: 'hair' })));
check('which is left out when there is none', !/region=/.test(nativeCallToTag('generate_image', { prompt: 'x' })));
check('the tag instructions describe it too', /set \\`region\\` to that part/.test(app));
check('an edit redraws its part the way the picture was drawn',
  /edit\.seedModel === model && Number\.isFinite\(Number\(edit\.seed\)\)/.test(app));

/* ------------------------------------------------- the two the reader turns

   Everything else about a region edit is a measurement taken off edits that
   came back wrong. These two are the ones that miss: how much of the picture
   around the mask should reach into it, and how far past the outline the mask
   should go. Both are multipliers, so the measurements underneath them -- 40
   for clothes, 24 for hair, a share of the picture for a painted mask -- are
   kept and moved together rather than replaced by one number. */

{
  const withGuide = new Set([...everything, ...W.MASK_NODES, 'MaskFix+', 'ModelPatchLoader', 'AnimaLLLiteApply']);
  const guide = ['anima-lllite-inpainting-v2.safetensors'];
  const def = W.WORKFLOWS['anima-base'];
  const edit = (opts) => {
    const graph = anima();
    W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 1 });
    const out = W.applyRegionEdit(graph, def, {
      image: 'ref.png', available: withGuide, patches: guide, ...opts,
    });
    return { graph, out };
  };

  // Untouched, everything is exactly what it was before there were dials.
  {
    const { graph } = edit({ region: 'hair' });
    eq('left alone, the guide is at full strength', byClass(graph, 'AnimaLLLiteApply')[0][1].inputs.strength, 1);
    eq('and the hair is widened by the measured 24', byClass(graph, 'GrowMaskWithBlur')[0][1].inputs.expand, 24);
  }
  eq('clothes are still widened further than hair', W.regionGrow(['clothes']), 40);

  // The guide's strength.
  {
    const { graph, out } = edit({ region: 'hair', guideStrength: 0.4 });
    eq('turned down, the guide is turned down', byClass(graph, 'AnimaLLLiteApply')[0][1].inputs.strength, 0.4);
    eq('and the result says how hard it ran', out.strength, 0.4);
  }
  {
    /* At zero the node is left out rather than added and told to do nothing:
       it loads a model patch and encodes the picture whatever its strength. */
    const { graph, out } = edit({ region: 'hair', guideStrength: 0 });
    eq('at zero there is no guide at all', byClass(graph, 'AnimaLLLiteApply').length, 0);
    check('  and nothing claims one ran', !out.guided);
    check('  while the edit itself is made as before', out.applied === true);
  }
  {
    const { graph } = edit({ region: 'hair', guideStrength: 99 });
    eq('a value past the end of the dial is held at the end', byClass(graph, 'AnimaLLLiteApply')[0][1].inputs.strength, 2);
  }
  {
    const { graph } = edit({ region: 'hair', guideStrength: 'quite a lot' });
    eq('and one that is not a number is the default', byClass(graph, 'AnimaLLLiteApply')[0][1].inputs.strength, 1);
  }

  // How far the mask is widened.
  {
    const { graph } = edit({ region: 'hair', growScale: 2 });
    const [[, grown], [, soft]] = byClass(graph, 'GrowMaskWithBlur');
    eq('widened twice as far', grown.inputs.expand, 48);
    /* The soft edge moves with it. The two were measured as a pair -- the
       softening has to fall in the ring the grow made -- and a doubled grow
       with the old 12 is a hard seam inside a wider ring. */
    eq('  and its soft edge with it', soft.inputs.blur_radius, 24);
  }
  {
    const { graph } = edit({ region: 'clothes', growScale: 0.5 });
    eq('the clothes rule is kept under the dial, not replaced by it',
      byClass(graph, 'GrowMaskWithBlur')[0][1].inputs.expand, 20);
  }
  eq('the scale reaches regionGrow itself', W.regionGrow(['hair'], 1.5), 36);
  eq('and is held to the dial there too', W.regionGrow(['hair'], 99), 60);
  check('a mask is never widened away to nothing', W.regionGrow(['hair'], 0) >= 1);

  // A painted mask is widened by a share of its own picture; the dial moves the share.
  {
    const graph = anima();
    W.applyImg2Img(graph, def, { image: 'ref.png', denoise: 1 });
    W.applyRegionEdit(graph, def, {
      image: 'ref.png', maskImage: 'mask.png', maskGrow: 40, growScale: 1.5,
      available: withGuide, patches: guide,
    });
    eq('a painted mask is widened by the dial too', byClass(graph, 'GrowMaskWithBlur')[0][1].inputs.expand, 60);
  }

  // What the two sides have to agree on, so a slider cannot ask for something refused.
  eq('the dials have a default of 1 either way',
    [W.GUIDE_STRENGTH.default, W.MASK_GROW_SCALE.default], [1, 1]);
  check('and a range with the default inside it',
    W.GUIDE_STRENGTH.min <= 1 && W.GUIDE_STRENGTH.max >= 1
    && W.MASK_GROW_SCALE.min <= 1 && W.MASK_GROW_SCALE.max >= 1);
  eq('turning a dial off is only possible for the guide', W.GUIDE_STRENGTH.min, 0);
  check('a mask can always be widened and narrowed', W.MASK_GROW_SCALE.min < 1 && W.MASK_GROW_SCALE.max > 1);

  // And the browser reads its ranges from the server rather than repeating them.
  const client = fs.readFileSync(path.join(ROOT, 'src/inpaint.js'), 'utf8');
  for (const name of ['GUIDE_STRENGTH', 'MASK_GROW_SCALE']) {
    const server = new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(
      fs.readFileSync(path.join(ROOT, 'server/workflows.js'), 'utf8'));
    const browser = new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(client);
    eq(`  ${name} is the same dial in both places`, browser?.[1]?.trim(), server?.[1]?.trim());
  }
}

/* ------------------------------------------------------ the dials, turned

   The half in the browser: what is stored, what is shown, and -- the one that
   matters -- what is sent. A dial nobody has touched must not appear on the
   wire at all, so that a reader who never opens this sends today exactly the
   request they sent yesterday. */

{
  const store = new Map();
  globalThis.localStorage = {
    get length() { return store.size; },
    key: (i) => [...store.keys()][i] ?? null,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const I = await load('src/inpaint.js');

  eq('both dials start where the measurements are', I.getInpaintTuning(), { guideStrength: 1, maskGrowScale: 1 });
  eq('and untouched they are not on the wire at all', I.inpaintFields(), {});

  I.setInpaintTuning({ guideStrength: 0.4 });
  eq('one turned, one kept', I.getInpaintTuning(), { guideStrength: 0.4, maskGrowScale: 1 });
  eq('and only the turned one is sent', I.inpaintFields(), { guideStrength: 0.4 });

  I.setInpaintTuning({ maskGrowScale: 1.5 });
  eq('both turned, both sent', I.inpaintFields(), { guideStrength: 0.4, maskGrowScale: 1.5 });

  I.setInpaintTuning({ guideStrength: I.GUIDE_STRENGTH.default });
  eq('and turning one back takes it off the wire again', I.inpaintFields(), { maskGrowScale: 1.5 });

  /* A slider's arithmetic does not land on its own step: five presses of the
     right arrow from 1 is 1.2500000000000002, and without rounding that is
     what would be stored, shown, and sent. */
  I.setInpaintTuning({ maskGrowScale: 1.2500000000000002 });
  eq('what a slider actually produces is rounded to its step', I.getInpaintTuning().maskGrowScale, 1.25);

  I.setInpaintTuning({ guideStrength: 99, maskGrowScale: -5 });
  eq('neither can be pushed past its end',
    I.getInpaintTuning(), { guideStrength: I.GUIDE_STRENGTH.max, maskGrowScale: I.MASK_GROW_SCALE.min });
  I.setInpaintTuning({ guideStrength: 'loads' });
  eq('and a value that is not a number is the default', I.getInpaintTuning().guideStrength, 1);

  eq('a multiplier is shown as one', [I.asFactor(1), I.asFactor(1.25), I.asFactor(0)], ['×1', '×1.25', '×0']);

  I.setInpaintTuning({ guideStrength: 1, maskGrowScale: 1 });

  /* ---- and the wiring, because a slider nobody sends is a slider that
     silently does nothing. Three places redraw part of a picture, and all
     three have to carry them. */
  const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
  check('an edit from a conversation carries the dials',
    /\.\.\.\(referenceImage \? inpaintFields\(\) : \{\}\),/.test(app));
  check('so does a redraw the check asked for', /\.\.\.inpaintFields\(\),/.test(panel));
  check('and an edit made in the Studio itself',
    /\.\.\.\(form\.referenceImage \? inpaintFields\(\) : \{\}\),/.test(panel));
  check('they are turned in the Studio, where the pictures are',
    /setInpaintTuning/.test(panel) && /GUIDE_STRENGTH\.min/.test(panel) && /MASK_GROW_SCALE\.min/.test(panel));
  check('and there is a way back to where they started',
    /t\('inpaint\.reset'\)/.test(panel));

  // Every string the group shows, in every language.
  const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
  const keys = [...new Set([...panel.matchAll(/'(inpaint\.[A-Za-z]+)'/g)].map(m => m[1]))];
  const dicts = (i18n.match(/^const [a-zA-Z]+ = \{$/gm) || []).length;
  check('the group has strings to show', keys.length >= 6, `${keys.length}`);
  const missing = keys.filter((key) => {
    const count = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    return count !== dicts;
  });
  check(`all ${keys.length} of them are translated into all ${dicts} languages`,
    missing.length === 0, missing.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
