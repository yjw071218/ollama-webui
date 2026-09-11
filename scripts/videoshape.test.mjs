// Video prompts as H3 timelines, the shape of what gets made, and films in the
// gallery viewer.
//
//   - The model is taught MiniMax H3's timeline format when a video is on the
//     table, and whatever it writes is made to cover exactly the clip.
//   - A requested ratio is honoured; otherwise a picture made from a picture
//     keeps that picture's shape -- the last one attached, or the generated one
//     being edited or animated.
//   - A picture they attached is found at all: it lives in `images`, and the
//     search for "the latest picture" was looking somewhere no message has.
//   - Pressing a video in the gallery opens it rather than downloading it.
import fs from 'node:fs';
import path from 'node:path';
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

/* ============================================================ the timeline */

const V = await load('src/videoPrompt.js');
const three = '[0s-2s] A puppy sleeps on a sunlit floor.\n[2s-5s] It wakes and stretches.\n[5s-8s] It trots to the door.';

eq('segments are read with their text', V.timelineOf(three).map(s => [s.start, s.end]), [[0, 2], [2, 5], [5, 8]]);
eq('the clip is as long as its last segment', V.durationFromTimeline(three), 8);
eq('no timecodes, no length', V.durationFromTimeline('a cat walks'), null);
eq('a timeline that fits is left as it is', V.normalizeTimeline(three, 8), three);
eq('one that runs long is cut where the clip ends',
  V.normalizeTimeline(three, 5), '[0s-2s] A puppy sleeps on a sunlit floor.\n[2s-5s] It wakes and stretches.');
eq('gaps and a short ending are closed up',
  V.normalizeTimeline('[0s-2s] a.\n[3s-4s] b.', 6), '[0s-2s] a.\n[2s-6s] b.');
eq('a first segment that starts late starts at zero', V.normalizeTimeline('[1s-3s] a.', 5), '[0s-5s] a.');
eq('dashes and spacing are forgiven', V.timelineOf('[0 - 2s] a [2s–5s] b').length, 2);
eq('a paragraph becomes one segment over the whole clip',
  V.normalizeTimeline('A cat walks across a sunny room.', 5), '[0s-5s] A cat walks across a sunny room.');
eq('lengths are held to what H3 makes', [V.clampSeconds(2), V.clampSeconds(15.4), V.clampSeconds(60), V.clampSeconds('x')], [5, 15, 20, null]);

check('the guide teaches the format', /\[0s-2s\]/.test(V.H3_GUIDE) && /duration/.test(V.H3_GUIDE));
check('and the sound through what is seen', /Imply the sound/i.test(V.H3_GUIDE));
check('it is sent for a question about video', V.asksForVideo('이 그림을 영상으로 만들어줘') && V.asksForVideo('animate this'));
check('and not for anything else', !V.asksForVideo('귀여운 여자아이 그려줘'));

const app = read('src/App.jsx');
check('only when the question is about video', /const videoGuide = asksForVideo\(thisTurn\[0\]\?\.content\) \? `\\n\\n\$\{H3_GUIDE\}` : '';/.test(app));
check('on both protocols', (app.match(/\$\{videoGuide\}/g) || []).length === 2);
check('the length comes from the model, else its timeline, else the Studio',
  /clampSeconds\(opts\.duration\)\s*\n\s*\?\? clampSeconds\(durationFromTimeline\(rawPrompt\)\)\s*\n\s*\?\? clampSeconds\(settings\.duration\)/.test(app));
check('and the timeline is made to fit it before it is sent', /const prompt = normalizeTimeline\(rawPrompt, duration\);/.test(app));

const T = await load('src/tools.js');
const video = T.TOOL_SCHEMAS.find(s => s.function.name === 'generate_video').function.parameters.properties;
check('generate_video asks for a timeline', /\[0s-2s\]/.test(video.prompt.description));
check('and takes a length and a shape', !!video.duration && !!video.aspect);
eq('which reach the tag', T.nativeCallToTag('generate_video', { prompt: '[0s-5s] x', from: 'last_image', duration: 8, aspect: '9:16' }),
  '<TOOL_GENERATE_VIDEO from="last_image" duration="8" aspect="9:16">[0s-5s] x</TOOL_GENERATE_VIDEO>');
check('the video tag is read by name, like the drawing one',
  /pattern: new RegExp\(`<TOOL_GENERATE_VIDEO\$\{TAG_ATTRS\}/.test(app));

/* =============================================================== the shape */

const P = await load('src/pictureTools.js');
eq('a ratio', P.parseAspect('16:9'), { w: 16, h: 9 });
eq('written another way', P.parseAspect('9x16'), { w: 9, h: 16 });
eq('or as a word', [P.parseAspect('세로'), P.parseAspect('가로'), P.parseAspect('정사각형')], [{ w: 9, h: 16 }, { w: 16, h: 9 }, { w: 1, h: 1 }]);
eq('nonsense is no shape', P.parseAspect('whatever'), null);
{
  const s = P.sizeForAspect({ w: 16, h: 9 }, 1296 * 1728);
  check('16:9 is 16:9', Math.abs(s.width / s.height - 16 / 9) < 0.02, JSON.stringify(s));
  check('at the workflow\'s area', Math.abs(s.width * s.height - 1296 * 1728) / (1296 * 1728) < 0.05);
  const v = P.sizeForAspect({ w: 9, h: 16 }, 1088 * 1088, 32);
  check('video sizes land on 32', v.width % 32 === 0 && v.height % 32 === 0, JSON.stringify(v));
  const strip = P.sizeForAspect({ w: 10, h: 1 }, 1024 * 1024);
  check('a strip is held to 3:1', strip.width / strip.height <= 3.05, JSON.stringify(strip));
}
eq('a PNG kept as bare base64 is known as one', P.sniffImageMime('iVBORw0KGgoAAAA'), 'image/png');
eq('and a JPEG', P.sniffImageMime('/9j/4AAQ'), 'image/jpeg');
eq('bare base64 becomes a data URL', P.asImageDataUrl('/9j/abc'), 'data:image/jpeg;base64,/9j/abc');
eq('a data URL stays one', P.asImageDataUrl('data:image/png;base64,x'), 'data:image/png;base64,x');

// Who decides the shape.
check('an attached picture is found where it is kept',
  /const images = message\.role === 'user' \? \(message\.images \|\| \[\]\) : \[\];/.test(app)
  && /return \{ dataUrl: asImageDataUrl\(images\[images\.length - 1\]\), attached: true \}/.test(app));
check('an edit keeps the edited picture\'s shape, a request names one, else the source picture',
  /const source = edit\?\.dataUrl \|\| \(!ratio && opts\.shapeFrom\) \|\| null;/.test(app));
check('a new picture asked for with an attachment takes its shape',
  /\.\.\.\(!edit && attachedNow \? \{ shapeFrom: asImageDataUrl\(attachedNow\) \} : \{\}\)/.test(app));
check('a video takes the shape of the picture it animates',
  /if \(!size && referenceDataUrl\) \{\s*\n\s*const dims = await pictureSize\(referenceDataUrl\)/.test(app));
check('or of the picture attached with the request', /const aspect = attrs\.aspect \|\| \(!reference && attachedNow/.test(app));
check('"again" keeps the shape of the one it is another take of', /\{ shapeFrom: picture\.dataUrl \}/.test(app));
const image = T.TOOL_SCHEMAS.find(s => s.function.name === 'generate_image').function.parameters.properties;
check('generate_image takes a shape', !!image.aspect);
check('which reaches the tag', /aspect="1:1"/.test(T.nativeCallToTag('generate_image', { prompt: 'x', aspect: '1:1' })));
check('and the model is told when to use it', /const shapeAdvice = /.test(app) && (app.match(/\$\{shapeAdvice\}/g) || []).length === 2);

/* ============================================================ the gallery */

check('a film in the gallery opens in the viewer', /type: item\.video \? 'video' : 'image',/.test(app));
check('which plays it', /viewingAttachment\.type === 'video' \? \(\s*\n\s*<video src=\{viewingAttachment\.preview\} controls autoPlay/.test(app));
check('and still offers the download', /viewingAttachment\.type === 'video' && \(\s*\n\s*<button[\s\S]{0,200}downloadPicture/.test(app));
check('rather than downloading on a press', !/item\.video\s*\n?\s*\? downloadPicture\(item\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
