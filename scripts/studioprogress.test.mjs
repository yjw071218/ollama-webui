// Watching a generation happen, in the browser half.
//
// The arithmetic and the wiring, not the pixels. Three of the four things this
// file gets wrong would be wrong *quietly* — an estimate that says forty
// minutes for a ninety-second job, a preview URL that never changes so the
// browser serves a cached first frame for the whole run, a phase key rendered
// as `studio.phase.frobnicating` because a node pack nobody has heard of turned
// up in the graph. None of them throw.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const { previewUrl, formatDuration, remainingMs, phaseLabel } =
  await import(pathToFileURL(path.join(ROOT, 'src/jobProgress.js')).href);

const source = fs.readFileSync(path.join(ROOT, 'src/studioProgress.jsx'), 'utf8');

/* ------------------------------------------------------------ the preview URL

   The frame changes several times a second and the URL is what tells the
   browser so. A URL that stayed the same would be served from cache for the
   whole generation — a preview that appears once and then freezes, which reads
   as the job hanging. */

check('no frame yet is no URL', previewUrl('abc', 0) === null);
check('and no job is no URL', previewUrl(null, 3) === null);
const first = previewUrl('abc', 1);
const later = previewUrl('abc', 2);
check('a URL carries the job', /id=abc/.test(first), first);
check('and the frame number', /seq=1/.test(first), first);
check('so each frame is its own URL', first !== later, `${first} vs ${later}`);
check('an id with a slash in it is escaped',
  !previewUrl('a/b', 1).includes('a/b'), previewUrl('a/b', 1));

/* --------------------------------------------------------------- the clock */

eq('under a minute', formatDuration(43000), '0:43');
eq('and over it', formatDuration(91000), '1:31');
// Padded, because 1:5 is not a time and a column of times that jump width is
// not a column.
eq('seconds are always two digits', formatDuration(65000), '1:05');
eq('nothing is 0:00', formatDuration(0), '0:00');
eq('and so is rubbish', formatDuration(undefined), '0:00');
eq('a negative clock does not run backwards', formatDuration(-5000), '0:00');

/* ------------------------------------------------------------ the estimate

   This is the one worth being careful about. In the first seconds the fraction
   is tiny and noisy, and elapsed/fraction produces enormous numbers — "about 40
   minutes left" on a job that takes ninety seconds. A reader who sees that
   cancels, so the honest output early on is nothing at all. */

check('nothing to divide by yet', remainingMs(0.01, 8000) === null);
check('nor enough time to divide', remainingMs(0.5, 1200) === null);
check('a finished job has nothing left to say', remainingMs(1, 60000) === null);
check('and neither does a missing fraction', remainingMs(null, 60000) === null);
check('nor one that is not a number', remainingMs(NaN, 60000) === null);

// Half done after a minute is another minute.
eq('half way is the same again', Math.round(remainingMs(0.5, 60000) / 1000), 60);
// Nearly done is nearly nothing.
check('nearly done is nearly none of it', remainingMs(0.9, 90000) < 11000);
check('and never below zero', remainingMs(0.999, 100000) >= 0);

/* -------------------------------------------------------------- the labels */

const t = (key) => ({
  'studio.phase.sampling': 'Drawing',
  'studio.phase.working': 'Working',
}[key] ?? key);

eq('a known phase is named', phaseLabel('sampling', t), 'Drawing');
// A pack nobody has heard of must not put a translation key on somebody's
// screen.
eq('an unknown one falls back rather than leaking a key', phaseLabel('frobnicating', t), 'Working');
eq('and so does nothing at all', phaseLabel(undefined, t), 'Working');

/* --------------------------------------------------------------- the wiring */

check('the stream is closed when the job ends',
  /state === 'done' \|\| data\.state === 'failed'\)\s*source\.close\(\)/.test(source.replace(/\s+/g, ' ')));
/* The clock has to run on its own. A job sitting in ComfyUI's queue behind
   another produces no messages at all, so anything derived from the last one
   freezes -- which is how a healthy queued job read "0:00" for fourteen
   minutes, the most alarming thing a progress card can do. And it cannot come
   from the server either: that is a different machine's idea of now. */
check('the clock ticks rather than waiting to be told',
  /setInterval\(\(\) => tick\(n => n \+ 1\), 1000\)/.test(source));
/* Read at render, not captured in the timer: a browser throttles intervals in a
   page it is not painting -- to once a minute in a background tab -- and a
   clock frozen by that would be wrong exactly when a progress message had just
   arrived to prove it was not. Any re-render is also a tick. */
check('and read at render, so an arriving message moves it too',
  /return active \? Date\.now\(\) - since\.current : 0;/.test(source));
check('but stops when the job does', /useElapsed\(state !== 'done' && state !== 'failed'\)/.test(source));
// Sampling emits previews and upscaling does not; without holding the last one
// the picture appears and then vanishes for the minute that follows.
check('the last frame is held across a phase that makes none',
  /if \(preview\) held\.current = \{ src: preview/.test(source) && /const shown = held\.current;/.test(source));

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
check('a chat generation says which job to watch', /setDrawing\(\{ id: queued\.id/.test(app));
// Including on the way out through a throw: a progress bar left on screen after
// the thing it was measuring gave up is worse than none.
check('and always takes it down again', /finally \{\s*(\/\/[^\n]*\n\s*)*setDrawing\(null\);/.test(app));
check('the conversation shows it instead of the thinking dots',
  /isStreamingRow && !drawing && textBlocks\.length === 0/.test(app));
// ComfyUI runs one prompt at a time, so a job behind another sends nothing at
// all -- "queued" with no idea whether that means seconds or an hour.
check('a job waiting its turn says how many are in front',
  /setDrawing\(d => \(d && d\.ahead !== state\.ahead/.test(app)
  && /queuedAhead=\{drawing\.ahead \|\| 0\}/.test(app));

/* The Studio's settings are what a chat generation runs with -- but not its
   prompt, which belongs to whatever was being made there. */
check('a chat generation reuses the Studio settings', /studioSettingsFor\('minimax-h3'/.test(app));
check('validated against what ComfyUI still has', /restoreForm\(descriptor, saved\)/.test(app));
check('but not the prompt sitting in the Studio',
  /const studioSettingsFor[\s\S]{0,2600}?\n  \};/.test(app)
  && !/const studioSettingsFor[\s\S]{0,2600}?\n  \};/.exec(app)[0].includes('prompt: form.prompt'));

/* The ceiling used to be two minutes, from when this always ran a distilled
   model at its default size. Measured here: 90 seconds for Anima and 151 for
   Krea 2 with nothing else on the GPU -- and more than ten minutes for the same
   work with a 35B language model resident on the same card, which is exactly
   the situation a picture asked for in a conversation is asked for in. */
check('and long enough for a workflow sharing a GPU with the model that asked for it',
  /deadlineMs = 1200000/.test(app));

const tools = fs.readFileSync(path.join(ROOT, 'src/tools.js'), 'utf8');
check('the model writes the negative prompt too', /negative: \{\s*type: 'string'/.test(tools));
check('and it reaches the tag', /negative="\$\{attr\(args\.negative \|\| ''\)\}"/.test(tools));
/* Every attribute is optional and independently so — a pattern that required
   any of them would fail on the most common call there is, which carries only
   a prompt. And they are read by name: models do not write them in the order
   they are documented, and a fixed-order pattern did not match
   `negative="…" style="…"` at all, so the call was never run. */
check('the drawing tag reads its attributes by name',
  /pattern: new RegExp\(`<TOOL_GENERATE_IMAGE\$\{TAG_ATTRS\}/.test(app)
  && /const attrs = tagAttrs\(m\[1\]\);/.test(app));
{
  const { TAG_ATTRS, tagAttrs } = await import(pathToFileURL(path.join(ROOT, 'src/tools.js')).href);
  /* Built rather than described: the point of the pattern is that a bare call
     matches it, and the only way to know that is to run it. */
  const live = new RegExp(`<TOOL_GENERATE_IMAGE${TAG_ATTRS}\\s*>([\\s\\S]*?)<\\/TOOL_GENERATE_IMAGE>`);
  check('a bare call matches', live.test('<TOOL_GENERATE_IMAGE>a cat</TOOL_GENERATE_IMAGE>'));
  check('so does one with only a style',
    live.test('<TOOL_GENERATE_IMAGE style="anime">a cat</TOOL_GENERATE_IMAGE>'));
  const edit = live.exec('<TOOL_GENERATE_IMAGE style="anime" negative="blur" from="last_image" change="0.6" region="hair">a cat</TOOL_GENERATE_IMAGE>');
  check('and a full one', !!edit);
  if (edit) {
    const attrs = tagAttrs(edit[1]);
    eq('  the style is read', attrs.style, 'anime');
    eq('  the negative is read', attrs.negative, 'blur');
    eq('  what to edit is read', attrs.from, 'last_image');
    eq('  how much to change is read', attrs.change, '0.6');
    eq('  which part to change is read', attrs.region, 'hair');
    eq('  and the prompt is the body', edit[2], 'a cat');
  }
  const shuffled = live.exec('<TOOL_GENERATE_IMAGE negative="blur, extra fingers" style="anime">a cat</TOOL_GENERATE_IMAGE>');
  check('in any order', !!shuffled && tagAttrs(shuffled[1]).style === 'anime');
  eq('and an escaped quote comes back as one',
    tagAttrs('negative="a &quot;signature&quot;"').negative, 'a "signature"');
}

/* ------------------------------------------------------- the card in a chat */

const J = await import(pathToFileURL(path.join(ROOT, 'src/jobProgress.js')).href);

// MiniMax's preview is the clip itself, and an <img> given an MP4 is a broken icon.
check('an MP4 frame is a clip', J.isClip('video/mp4'));
check('an animated WebP is not: an <img> plays it', !J.isClip('image/webp'));
check('nor is nothing', !J.isClip(undefined));

eq('the measured shape wins', J.frameRatio(0.75, 1.5), 0.75);
eq('then the one asked for', J.frameRatio(null, 1.5), 1.5);
eq('a picture defaults to square', J.frameRatio(null, null), 1);
check('a video to wide', Math.abs(J.frameRatio(null, null, true) - 16 / 9) < 1e-9);
eq('and nothing is taller than a card can hold', J.frameRatio(0.1, null), 0.5);
eq('or wider', J.frameRatio(9, null), 2.2);

eq('a size string has a shape', J.sizeRatio('1344x768'), 1344 / 768);
eq('so does a size object', J.sizeRatio({ width: 800, height: 1000 }), 0.8);
eq('and nothing has none', J.sizeRatio(null), null);
eq('nor a broken string', J.sizeRatio('1344x'), null);

const timeline = '[0s-2s] A puppy sleeps on a sunlit floor.\n  [2s-5s] It wakes and yawns.';
eq('a timeline reads as one line without its timecodes',
  J.promptExcerpt(timeline), 'A puppy sleeps on a sunlit floor. It wakes and yawns.');
const long = J.promptExcerpt('word '.repeat(80), 40);
check('a long prompt is cut near the limit', long.length <= 41 && long.endsWith('…'), long);
check('at a word', !/wor…$/.test(long), long);

check('the card plays a clip in a <video>', /<video[\s\S]{0,900}onLoadedData/.test(source));
check('and starts each new clip where the last one had got to',
  /element\.currentTime = \(\(performance\.now\(\) - clock\.current\) \/ 1000\) % length/.test(source));
check('it shows the prompt it is making', /studio-progress-prompt/.test(source));
check('and the conversation passes what the card needs',
  /kind=\{drawing\.kind/.test(app) && /aspect=\{drawing\.aspect\}/.test(app) && /source=\{drawing\.source\}/.test(app));

/* ------------------------------------------------------- when an answer was

   The bubble is made when the question is sent. The time under an answer is
   when it was finished -- after the four minutes of video, not before them. */
check('every turn marks its answer finished on the way out',
  (app.match(/finally \{\s*markAnswered\(startedIn, /g) || []).length >= 3);
check('but not an older answer left last by a queued question',
  /if \(last\.at && last\.at < since\) return s;/.test(app));
check('and no time is shown while it is still arriving',
  /!\(msg\.role === 'assistant' && isThisChatGenerating/.test(app));

const V = await import(pathToFileURL(path.join(ROOT, 'src/variants.js')).href);
let answered = { content: 'one', at: 100 };
answered = V.appendVariant(answered, { content: 'two', at: 200 });
eq('a regeneration keeps its own finish time', answered.at, 200);
eq('and paging back shows the first one\'s', V.selectVariant(answered, 0).at, 100);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
