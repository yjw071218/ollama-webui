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

const everything = new Set([...W.REGION_NODES, 'GrowMaskWithBlur']);

/** Anima's graph, reduced to the nodes the edit touches. */
const anima = () => ({
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
