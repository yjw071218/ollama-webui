// The Studio's new tools: ratio buttons, post-processing a picture, films in
// the viewer, card size, and a title that says a job finished while nobody was
// looking.
//
// Asked for: more image and video features, and a better Studio to use. Each
// of these has a quiet way to be wrong -- a ratio that changes the pixel count
// (and so the time and the memory), an upscale card that forgets which
// picture it came from, a viewer that still skips every film -- so the
// arithmetic is pinned here and the wiring is read out of the source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const S = await import(pathToFileURL(path.join(ROOT, 'src/studioTools.js')).href);

/* ------------------------------------------------------------- the shape */

{
  const area = 1024 * 1360;
  const portrait = S.presetSize('2:3', 1024, 1360);
  check('2:3 is 2:3', Math.abs(portrait.width / portrait.height - 2 / 3) < 0.02, JSON.stringify(portrait));
  check('at the pixel count already chosen', Math.abs(portrait.width * portrait.height - area) / area < 0.04);
  check('on the latent grid', portrait.width % 16 === 0 && portrait.height % 16 === 0);
  const wide = S.presetSize('16:9', 1088, 1088, 32);
  check('a video size lands on 32', wide.width % 32 === 0 && wide.height % 32 === 0, JSON.stringify(wide));
  check('and is wide', wide.width > wide.height);
  eq('a square is a square', (({ width, height }) => width === height)(S.presetSize('1:1', 832, 1216)), true);
  eq('nonsense makes no size', S.presetSize('banana', 1024, 1024), null);

  eq('the ratio a size already is', S.matchPreset(1024, 1024), '1:1');
  eq('within rounding', S.matchPreset(832, 1248), '2:3');
  // Found by photographing it: nothing was lit for Anima's own default size.
  eq('including the trained buckets, which are 2.6% off', S.matchPreset(832, 1216), '2:3');
  eq('a wide outline is wide', S.ratioGlyph('4:3'), { width: 22, height: 17 });
  eq('a tall one is tall', S.ratioGlyph('9:16'), { width: 12, height: 22 });
  eq('and a square is square', S.ratioGlyph('1:1'), { width: 22, height: 22 });
  eq('and none when it is none of them', S.matchPreset(1000, 1100), '');
  eq('pressing a ratio lands on that ratio', S.matchPreset(portrait.width, portrait.height), '2:3');
  eq('megapixels, to two places', S.megapixels(1024, 1360), '1.39');
  eq('a job\'s size read back', S.parseJobSize('1024×1360'), { width: 1024, height: 1360 });
  eq('written with an x too', S.parseJobSize('512x768'), { width: 512, height: 768 });
  eq('and nothing is nothing', S.parseJobSize(''), null);
}

/* ------------------------------------------------- after it is made */

{
  const job = {
    id: 'j1', state: 'done', prompt: '1girl, shrine', negative: 'lowres', parts: { prompt: '1girl, shrine' },
    model: 'anima-base', modelLabel: 'Anima', size: '1024×1360', seed: 7,
    outputs: [{ media: 'image', url: '/studio/view?filename=a.png&subfolder=webui&type=output', filename: 'a.png' }],
  };
  eq('an upscale is asked for at twice the size, with the size it has now',
    S.opRequest(job, 'upscale', 'upload-1.png', 'r1'),
    { op: 'upscale', image: 'upload-1.png', factor: 2, width: 1024, height: 1360, requestId: 'r1' });
  eq('a cut-out has no factor', S.opRequest(job, 'rmbg', 'u.png', 'r2').factor, undefined);

  const card = S.opJobFrom(job, 'upscale', { id: 'op-1', label: 'Anima · Upscale ×2', now: 5 });
  eq('the new card is twice the size', card.size, '2048×2720');
  eq('and remembers the picture it came from', card.parent, 'j1');
  eq('with its prompt, so reuse and search still work', [card.prompt, card.negative, card.parts.prompt], ['1girl, shrine', 'lowres', '1girl, shrine']);
  eq('queued, like a generation', card.state, 'queued');
  eq('a cut-out keeps the size', S.opJobFrom(job, 'rmbg', { id: 'op-2', label: 'x' }).size, '1024×1360');
  eq('an upscale is compared against the picture it enlarged', card.before, job.outputs[0].url);
  eq('a cut-out is not', S.opJobFrom(job, 'rmbg', { id: 'op-3', label: 'x' }).before, undefined);
  eq('nor an upscale of a film', S.opJobFrom({ ...job, outputs: [{ media: 'video', url: 'v' }] }, 'upscale', { id: 'op-4', label: 'x' }).before, undefined);

  // The bar between them.
  eq('the bar follows the pointer', S.splitAt(150, { left: 100, width: 200 }), 25);
  eq('and stops at the edges', [S.splitAt(0, { left: 100, width: 200 }), S.splitAt(999, { left: 100, width: 200 })], [0, 100]);
  eq('an unmeasured frame puts it in the middle', S.splitAt(10, null), 50);
  eq('arrows move it a little, with shift a lot', [S.splitByKey(50, 'ArrowLeft'), S.splitByKey(50, 'ArrowRight', true)], [48, 60]);
  eq('Home and End to either side', [S.splitByKey(50, 'Home'), S.splitByKey(50, 'End')], [0, 100]);
  eq('and never past them', S.splitByKey(99, 'ArrowRight'), 100);
  eq('other keys are not its', S.splitByKey(50, 'Enter'), null);
  eq('the picture a job made, not its film', S.pictureOutput({ outputs: [{ media: 'video' }, { media: 'image', url: 'p' }] }).url, 'p');
  eq('and none from a job that made none', S.pictureOutput({ outputs: [{ media: 'video' }] }), null);
}

/* -------------------------------------------------------- the viewer */

{
  const jobs = [
    { id: 'a', state: 'done', outputs: [{ media: 'image', url: 'a.png' }] },
    { id: 'b', state: 'done', outputs: [{ media: 'image', url: 'frame.png' }, { media: 'video', url: 'b.mp4' }] },
    { id: 'c', state: 'running', outputs: [] },
    { id: 'd', state: 'failed' },
  ];
  const viewable = S.viewableOf(jobs);
  eq('finished jobs open in the viewer, films included', viewable.map(v => v.job.id), ['a', 'b']);
  eq('a film opens as the film', viewable[1].output.url, 'b.mp4');
}

/* -------------------------------------------------------- when it is done */

{
  const before = [{ id: 'a', state: 'running' }, { id: 'b', state: 'queued' }, { id: 'c', state: 'done' }];
  const after = [{ id: 'a', state: 'done' }, { id: 'b', state: 'failed' }, { id: 'c', state: 'done' }, { id: 'd', state: 'done' }];
  eq('only what was being made and now is not', S.justFinished(before, after).map(j => j.id), ['a', 'b']);
  eq('nothing changed, nothing finished', S.justFinished(after, after), []);
}

eq('a card size nobody chose is medium', (() => { const g = globalThis.localStorage; delete globalThis.localStorage; const v = S.readDensity(); globalThis.localStorage = g; return v; })(), 'm');

/* ------------------------------------------------------------ the wiring */

const panel = read('src/StudioPanel.jsx');
const lightbox = read('src/StudioLightbox.jsx');

check('the ratio buttons are drawn from the presets', /ASPECT_PRESETS\.map\(\(preset\) =>/.test(panel)
  && /\.\.\.presetSize\(preset, f\.width, f\.height, model\?\.kind === 'video' \? 32 : 16\)/.test(panel));
check('and the one the size already is, is lit', /const activeRatio = matchPreset\(canvasW, canvasH\);/.test(panel));
check('upscale and cut-out are one press away on a picture',
  /onClick: \(\) => runOp\(job, 'upscale'\)/.test(panel) && /onClick: \(\) => runOp\(job, 'rmbg'\)/.test(panel));
check('as a job of their own, watched like a generation',
  /setJobs\(prev => \[opJobFrom\(job, op, \{ id: data\.id, label \}\), \.\.\.prev\]\);\s*\n\s*poll\(data\.id\);/.test(panel));
check('through the operation the chat already uses', /fetch\('\/studio\/op'/.test(panel));
check('a refused one is a failed card saying why', /if \(!data\?\.success\) \{ failed\(data\?\.error/.test(panel));
check('animating a picture sets it as the video\'s reference',
  /pendingReference\.current = name; setModelId\(videoWorkflow\.id\);/.test(panel)
  && /restored\.referenceImage = pendingReference\.current;/.test(panel));
check('and says what to do next', /setNotice\(t\('studio\.op\.animateReady'\)\)/.test(panel));
check('without starting a video nobody asked for', !/animate[\s\S]{0,900}submitOne\(/.test(panel.slice(panel.indexOf('const animate = async'), panel.indexOf('const runOp = async'))));
check('the rest is in a menu, named', /<JobMenu label=\{t\('studio\.more'\)\}/.test(panel) && /role="menu"/.test(panel));
check('the viewer walks films too', /const viewable = viewableOf\(shown\);/.test(panel) && /video: output\.media === 'video',/.test(panel));
check('which play in it', /item\.video \? \(\s*\n\s*<video/.test(lightbox) && /onLoadedMetadata=/.test(lightbox));
check('with space as play and pause', /event\.key === ' ' && !onButton && item\?\.video/.test(lightbox));
check('and a film card has a way into it', /className="studio-job-expand" onClick=\{onOpen\}/.test(panel));

/* The gallery and the conversation open pictures in the same viewer. They had
   the attachment box: no arrows, no filling the screen, no prompt. */
{
  const gallery = read('src/PictureGallery.jsx');
  const app = read('src/App.jsx');
  check('the gallery opens its pictures in the Studio\'s viewer',
    /<StudioLightbox/.test(gallery) && /setViewing\(opened\.key\)/.test(gallery));
  /* Unless several are being picked, in which case a tap picks. A grid where a
     plain tap sometimes opens and sometimes selects is one nobody trusts, so
     picking is a mode entered on purpose rather than a modifier key -- there is
     no modifier key on the phone half of this. */
  check('  or picks one, while several are being picked',
    /picking \? togglePicked\(opened\.key\) : setViewing\(opened\.key\)/.test(gallery));
  check('  walking the grid as it is filtered', /onIndex=\{n => setViewing\(items\[n\]\.key\)\}/.test(gallery));
  check('  judged and revealed as its card is',
    /revealKey: item\.source === 'studio' \? item\.full : cacheKey\(item\.full\),/.test(gallery)
    && /\.\.\.\(known \? \{ verdict: strongest\(known, promptSignal\(item\.prompt\)\) \} : \{\}\)/.test(gallery));
  check('  with the way back to its chat, and into the composer',
    /id: 'goto'[\s\S]{0,160}when: \(shown\) => shown\.fromChat/.test(gallery) && /id: 'attach'/.test(gallery));
  check('the gallery no longer hands pictures to the attachment box', !/onOpen=\{\(item\) => setViewingAttachment/.test(app));
  check('a picture in a conversation opens in the viewer',
    /onClick=\{\(\) => setViewingPicture\(`\$\{currentSession\.id\}:\$\{i\}:\$\{n\}`\)\}/.test(app) && /<StudioLightbox/.test(app));
  check('  a film too, from the corner of its player', /className="picture-expand"/.test(app));
  check('  every picture in the chat a step of its arrows', /const shown = chatPictures\(\[currentSession\]\);/.test(app));
  check('  revealed under the key the message uses', /revealKey: cacheKey\(item\.full\),/.test(app));
  check('  with what can be done to it from the message', /id: 'redraw'/.test(app) && /id: 'paint'/.test(app));
  check('  and closed on leaving the chat', /useEffect\(\(\) => \{ setViewingPicture\(null\); \}, \[currentSessionId\]\);/.test(app));
  check('the viewer judges what arrives without a verdict',
    /const useItemVerdict = / .test(lightbox) && /if \(given\) return item\.verdict;/.test(lightbox));
  check('  and reveals it under the place\'s key', /const revealKey = item\?\.revealKey \|\| item\?\.url;/.test(lightbox));
  check('a swipe across is the next picture, down is closing',
    /go\(dx < 0 \? 1 : -1\)/.test(lightbox) && /onTouchEnd=\{onTouchEnd\}/.test(lightbox));
  check('the viewer brings its own styles', /import '\.\/studio\.css';/.test(lightbox));
}

/* Before and after: an upscale or an edit laid over what it was made from, a
   bar between them to drag. */
{
  const app = read('src/App.jsx');
  const panel = read('src/StudioPanel.jsx');
  const compare = read('src/BeforeAfter.jsx');
  const css = read('src/studio.css');
  check('a chat edit remembers what it started from -- by name and ComfyUI\'s copy, not the bytes again',
    /\.\.\.\(referenceImage && !edit\.blob \? \{ before: \{ filename: edit\.filename \|\| '', input: referenceImage \} \} : \{\}\)/.test(app)
    && /filename: picture\.filename \|\| '',\s*\n\s*region,/.test(app));
  check('  and so does an upscale', /\.\.\.\(op === 'upscale' \? \{ before: \{ filename: picture\.filename \|\| '', input: image \} \} : \{\}\)/.test(app));
  check('a Studio picture made from a picture remembers it; a film does not',
    /request\.referenceImage && model\.kind === 'image'\s*\n\s*\? \{ before: `\/studio\/view\?\$\{new URLSearchParams\(\{ filename: request\.referenceImage, type: 'input' \}\)\}` \}/.test(panel));
  check('  and the viewer is given it', /\.\.\.\(output\.media === 'image' && job\.before \? \{ before: job\.before \} : \{\}\)/.test(panel));
  check('in a conversation, a button lays the two in place of the picture',
    /\) : comparing \? \(\s*\n[\s\S]{0,300}<BeforeAfter before=\{beforeUrl\} after=\{picture\.dataUrl\} t=\{t\} \/>/.test(app)
    && /setComparingPictures\(open => \(\{ \.\.\.open, \[`\$\{i\}:\$\{n\}`\]: !open\[`\$\{i\}:\$\{n\}`\] \}\)\)/.test(app));
  check('  offered only where there is something to compare with', /\{beforeUrl && \(\s*\n\s*<button/.test(app));
  check('the viewer has it too, on a button and on C',
    /\{canCompare && \(\s*\n\s*<button type="button" className=\{`studio-lightbox-btn \$\{showCompare \? 'is-on' : ''\}`\}/.test(lightbox)
    && /\(event\.key === 'c' \|\| event\.key === 'C'\) && canCompare/.test(lightbox));
  check('  never through the glass', /const showCompare = comparing && canCompare && !veiled;/.test(lightbox));
  check('  Escape takes the bar down before it closes the viewer', /if \(full\) setFull\(false\); else if \(showCompare\) setComparing\(false\); else onClose\(\);/.test(lightbox));
  check('  a drag across it is not a swipe to the next picture', /if \(!start \|\| item\.video \|\| showCompare\) return;/.test(lightbox));
  check('  and the arrows on its handle move the bar, not the picture',
    /if \(onBar && \['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'\]\.includes\(event\.key\)\) return;/.test(lightbox));
  check('the original is clipped to the left of the bar', /style=\{\{ clipPath: `inset\(0 \$\{100 - position\}% 0 0\)` \}\}/.test(compare));
  check('  anywhere on the picture drags it', /onPointerDown=\{onPointerDown\}/.test(compare) && /setPointerCapture/.test(compare));
  check('  the handle is a slider the keyboard can move', /role="slider"/.test(compare) && /onKeyDown=\{onKeyDown\}/.test(compare));
  check('  an original that has gone leaves the result whole', /onError=\{\(\) => setBroken\(true\)\}/.test(compare));
  check('  both fitted into one box, so an upscale lines up', /\.before-after img \{[\s\S]*?object-fit: contain;/.test(css));
  const i18n = read('src/i18n.jsx');
  for (const key of ['compare.before', 'compare.after', 'compare.toggle', 'compare.handle', 'compare.missing', 'compare.upscale', 'compare.edit']) {
    eq(`every language names "${key}"`, i18n.split(`'${key}':`).length - 1, 12);
  }
}
check('favourite and reuse from the viewer', /onFavorite=\{n => toggleFavorite\(viewable\[n\]\.job\.id\)\}/.test(panel)
  && /onReuse=\{\(n\) => \{ reuse\(viewable\[n\]\.job\); setViewing\(null\); \}\}/.test(panel));
check('F stars in the viewer', /event\.key === 'f' \|\| event\.key === 'F'\) && onFavorite/.test(lightbox));
check('card size is chosen and applied', /className=\{`studio-gallery is-density-\$\{density\}`\}/.test(panel) && /onClick=\{\(\) => setDensity\(value\)\}/.test(panel));
check('a job finished while hidden marks the title', /document\.title = `\$\{unseen\.current\.failed \? '⚠️' : '✅'\}/.test(panel));
check('which is cleared when the tab is looked at', /document\.title = PAGE_TITLE;/.test(panel));
check('and asks for no permission', !/Notification\./.test(panel));

const css = read('src/studio.css');
for (const cls of ['.studio-ratio', '.studio-ratio.is-on', '.studio-density', '.studio-gallery.is-density-s',
  '.studio-gallery.is-density-l', '.studio-job-menu', '.studio-job-expand', '.studio-lightbox-stage video']) {
  check(`${cls} is styled`, css.includes(cls));
}

const i18n = read('src/i18n.jsx');
for (const key of ['studio.aspect', 'studio.more', 'studio.op.upscale', 'studio.op.rmbg', 'studio.op.animate',
  'studio.op.animateReady', 'studio.density', 'studio.density.s', 'studio.density.m', 'studio.density.l']) {
  eq(`every language has "${key}"`, i18n.split(`'${key}':`).length - 1, 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
