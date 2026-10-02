// Whether a generated picture is shown straight away.
//
// A safeguard fails in two directions and both are quiet. Too eager, and a
// gallery of landscapes is a wall of frosted glass nobody can use; too lax,
// and the one picture it existed for goes up on a shared screen. Neither
// throws, so the rules are pinned here one by one — and so is the wiring,
// because a verdict nobody renders protects nothing.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const S = await import(pathToFileURL(path.join(ROOT, 'src/safeguard.js')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'src/nsfwClassifier.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the prompt */

eq('an explicit rating tag is explicit', S.promptSignal('masterpiece, 1girl, nsfw, beach'), 'explicit');
eq('weights and underscores do not hide a tag', S.promptSignal('1girl, (completely_nude:1.2)'), 'explicit');
eq('a sentence is read for its words', S.promptSignal('a photo of a nude woman on a beach at dusk'), 'explicit');
eq('a named suggestive tag stays suggestive', S.promptSignal('1girl, covered nipples, smile'), 'suggestive');
eq('a swimsuit is suggestive', S.promptSignal('1girl, bikini, ocean'), 'suggestive');
eq('the sensitive rating is suggestive', S.promptSignal('rating:sensitive, 1girl'), 'suggestive');
eq('the strongest tag wins, wherever it is', S.promptSignal('bikini, beach, nude'), 'explicit');
eq('an ordinary prompt says nothing', S.promptSignal('1girl, solo, smile, library, reading'), null);
eq('a word inside another word is not that word', S.promptSignal('a cottage in sussex, essex countryside'), null);
eq('an empty prompt says nothing', S.promptSignal(''), null);
eq('a tag is named as a person would name it', S.normaliseTag('(blue_eyes:1.2)'), 'blue eyes');

/* ---------------------------------------- the words the tagger actually uses

   These lists were written for prompts -- what a person types -- and are now
   read off WD14's output as well. The two vocabularies overlap but are not the
   same, and the gap is exactly where a picture gets shown that should not be:
   a tag the tagger emits and no list knows falls through everything.

   The negative cases matter as much as the positive ones. WD14 puts `breasts`
   on any clothed character, so a list that veiled it would veil half a gallery
   -- and a safeguard that over-veils is one that gets turned off, which
   protects nothing at all. */

const tagged = (tags) => S.promptSignal(tags) || 'safe';

eq('a swimsuit is what the tagger says far more often than a bikini',
  tagged('1girl, swimsuit, beach, smile'), 'suggestive');
eq('and a school swimsuit too', tagged('1girl, school swimsuit, poolside'), 'suggestive');
eq('breasts out is not the same statement as breasts',
  tagged('1girl, breasts out, indoors'), 'explicit');
eq('  and breasts alone, which the tagger puts on anybody clothed, is not one at all',
  tagged('1girl, large breasts, school uniform, classroom'), 'safe');
eq('an areola slip is explicit', tagged('1girl, areola slip, dress'), 'explicit');
eq('so is anything put aside', tagged('1girl, panties aside'), 'explicit');
eq('no panties is suggestive', tagged('1girl, no panties, skirt, standing'), 'suggestive');

/* A garment is not exposure; "only that garment" is.
 *
 * `panties`, `bra` and `underwear` are filed by the tag dictionary shipped in
 * this repo under 패션 > 언더웨어 -- fashion. Read off a prompt that is
 * arguable; read off the tagger it is wrong, and provably: on a drawing of a
 * girl in an oversized shirt with nothing showing at all, WD14 reports
 * `panties` because it infers underwear is being worn. The picture was veiled
 * for it. */
eq('wearing underwear is not showing anything', tagged('1girl, panties, shirt, standing'), 'safe');
eq('nor is wearing a bra', tagged('1girl, bra, shirt'), 'safe');
eq('but wearing only it is', tagged('1girl, underwear only'), 'suggestive');
eq('and so is seeing it', tagged('1girl, panty shot, skirt'), 'suggestive');
eq('swimwear is unchanged', tagged('1girl, bikini, beach'), 'suggestive');

/* And the four the whole thing exists for are untouched by any of that. */
for (const tag of ['nude', 'nipples', 'pussy', 'bottomless', 'sex', 'completely nude', 'topless']) {
  eq(`${tag} is explicit, whatever else is in the picture`,
    tagged(`1girl, standing, ${tag}, simple background`), 'explicit');
}
eq('and so is no bra', tagged('1girl, no bra, shirt'), 'suggestive');

/* The list is checked before the words for a reason. `covered pussy` is a
   picture of something covered, and letting the word inside it reach the
   explicit regex would veil a swimsuit as pornography. */
eq('covered is covered, whatever word is inside it',
  tagged('1girl, covered pussy, swimsuit'), 'suggestive');
eq('as it already was for nipples', tagged('1girl, covered nipples, shirt'), 'suggestive');

// An ordinary picture, in the tagger's own words, stays ordinary.
eq('and an ordinary picture is left alone',
  tagged('1girl, solo, long hair, looking at viewer, blush, simple background, '
    + 'long sleeves, dress, holding, bow, jewelry, twintails, pink hair, earrings, frills'), 'safe');

/* ---------------------------------------------------------- the classifier */

eq('porn and hentai are one verdict for two media', S.verdictFrom({ porn: 0.3, hentai: 0.3, drawing: 0.4 }), 'explicit');
eq('sexy on its own is suggestive', S.verdictFrom({ sexy: 0.5, neutral: 0.5 }), 'suggestive');
eq('a clean drawing is safe', S.verdictFrom({ drawing: 0.9, hentai: 0.05, neutral: 0.05 }), 'safe');
eq('several small doubts add up', S.verdictFrom({ porn: 0.1, hentai: 0.2, sexy: 0.35 }), 'suggestive');
eq('nothing at all is safe', S.verdictFrom({}), 'safe');

eq('the stronger of two verdicts', S.strongest('safe', 'explicit'), 'explicit');
eq('no opinion defers to the other', S.strongest(null, 'suggestive'), 'suggestive');

/* ----------------------------------------------------------------- levels */

check('off shows everything', !S.shouldVeil('explicit', 'off') && !S.shouldVeil('pending', 'off'));
check('explicit hides explicit only', S.shouldVeil('explicit', 'explicit') && !S.shouldVeil('suggestive', 'explicit'));
check('suggestive hides both', S.shouldVeil('explicit', 'suggestive') && S.shouldVeil('suggestive', 'suggestive'));
check('safe is never hidden', !S.shouldVeil('safe', 'suggestive'));
// Showing the picture for the second before the classifier answers would be
// the one flash the safeguard exists to prevent.
check('not yet judged is hidden until it is', S.shouldVeil('pending', 'explicit'));
eq('the default hides explicit pictures', S.DEFAULT_LEVEL, 'explicit');

/* ------------------------------------------------------------- revealing */

S.setRevealed('pic-1', true);
check('a revealed picture is revealed', S.isRevealed('pic-1'));
S.setRevealed('pic-1', false);
check('and can be hidden again', !S.isRevealed('pic-1'));

/* ------------------------------------------------------------ cache keys */

eq('the gallery thumbnail and the file are one picture',
  C.cacheKey('/studio/view?filename=a.png&subfolder=webui&type=output&preview=webp%3B85'),
  C.cacheKey('/studio/view?filename=a.png&subfolder=webui&type=output'));
const big = `data:image/png;base64,${'A'.repeat(50000)}`;
check('a data URL is keyed by a hash, not by itself', C.cacheKey(big).length < 40);
check('two different pictures get two keys', C.cacheKey(big) !== C.cacheKey(`${big}B`));

/* ---------------------------------------------------------------- wiring */

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const panel = read('src/StudioPanel.jsx');
const app = read('src/App.jsx');
const lightbox = read('src/StudioLightbox.jsx');
const progress = read('src/studioProgress.jsx');
const store = read('src/settingsStore.js');
const server = read('server/studio.js');

check('every finished picture in the gallery is behind the veil',
  /<Veil key=\{item\.url\} verdict=\{verdict\}[\s\S]{0,600}<img src=\{thumbOf\(item\.url\)\}/.test(panel));
check('the verdict is kept on the job, so it syncs',
  /safety: \{ verdict, by, \.\.\.\(scores \? \{ scores \} : \{\}\)/.test(panel));
/* And which witness said so, because they are not equal: a classifier answer
   written down once would otherwise outlive every correction the tagger made
   afterwards. */
check('  with which witness said so',
  /const TAGGED = new Set\(\['tagger', 'frames'\]\);/.test(panel)
  && /if \(TAGGED\.has\(job\.safety\?\.by\) && !TAGGED\.has\(by\)\) return job;/.test(panel));
check('the last preview frame is not shown behind a veiled picture', /lastFrame && !hidden/.test(panel));
check('a half-drawn picture is veiled by its prompt', /veil=\{shouldVeil\(asked, level\)\}/.test(panel)
  && /studio-progress-frame \$\{veiled \? 'is-veiled'/.test(progress));
check('the viewer keeps the veil and will not enlarge through it',
  /if \(!veiledNow\.current\) setFull\(true\);/.test(lightbox) && /<VeilOverlay/.test(lightbox));
check('pictures in a conversation are veiled too', /<SafePicture\s+src=\{picture\.dataUrl\}/.test(app));
check('and so is the picture being drawn for one', /veil=\{shouldVeil\(promptSignal\(drawing\.prompt\), safeLevel\)\}/.test(app));
check('the verdict cache is this browser\'s, not a synced setting', /'nsfwVerdicts'/.test(store));
check('the level can be changed from the gallery', /setSafeguardLevel\(e\.target\.value\)/.test(panel));

// The gallery's lighter copies.
check('the gallery shows thumbnails', /<img src=\{thumbOf\(item\.url\)\}/.test(panel));
// The job's main output -- its film if it made one -- rather than outputs[0].
check('the viewer still opens the file itself', /url: output\.url,/.test(panel) && /const viewable = viewableOf\(shown\);/.test(panel));
check('the server passes on only the previews ComfyUI accepts',
  /\/\^\(webp\|jpeg\);\\d\{1,3\}\$\/\.test\(preview\)/.test(server));

/* ------------------------------------------------- a video, by its frames

   Asked for: judge a finished video by what the tagger sees in it, not by its
   prompt alone. The picture classifier reads stills, and handed a film it
   failed -- so a clip was shown or hidden on what it was asked to be. */

const V = await import(pathToFileURL(path.join(ROOT, 'src/videoSafety.js')).href);
{
  const yoga = [
    '1girl, solo, short hair, shorts, barefoot, indoors, window',
    '1girl, solo, breasts, cleavage, medium breasts, sports bra, midriff',
  ];
  eq('a clip with cleavage in one frame is suggestive', V.verdictFromFrames(yoga), 'suggestive');
  eq('one explicit frame makes an explicit clip', V.verdictFromFrames([...yoga, '1girl, completely nude, nipples']), 'explicit');
  eq('a clip of a beach is safe', V.verdictFromFrames(['ocean, sky, no humans, beach, waves']), 'safe');
  eq('and nothing read is not a verdict of anything else', V.verdictFromFrames([]), 'safe');
  check('the tags that decided it are named', JSON.stringify(V.decidingTags([...yoga, 'completely nude, nipples, 1girl'], 'explicit')) === '["completely nude","nipples"]');

  const fromStudio = V.videoFileOf({ url: '/studio/view?filename=a_00001_.mp4&subfolder=webui&type=output' });
  check('a Studio film is found from its URL', fromStudio.filename === 'a_00001_.mp4' && fromStudio.subfolder === 'webui' && fromStudio.type === 'output');
  const kept = V.videoFileOf({ filename: 'b.mp4', subfolder: 'webui', type: 'output' });
  check('a chat film from what it kept', kept.subfolder === 'webui');
  check('an older chat film, which kept only its name, is in webui/', V.videoFileOf({ filename: 'c.mp4' }).subfolder === 'webui');
  eq('and nothing is no file', V.videoFileOf({}), null);
}

{
  const O = await import(pathToFileURL(path.join(ROOT, 'server/imageOps.js')).href);
  const T = await import(pathToFileURL(path.join(ROOT, 'server/videoTags.js')).href);
  const info = {
    VHS_LoadVideo: { input: { required: {} } },
    'WD14Tagger|pysssss': { input: { required: { model: [['wd-vit-tagger-v3', 'wd-swinv2-tagger-v3']] } } },
  };
  const five = O.videoTagGraph({ video: 'webui/a.mp4 [output]', objectInfo: info, duration: 5 });
  eq('the video is loaded from where ComfyUI wrote it', five.prompt[1].inputs.video, 'webui/a.mp4 [output]');
  eq('ten frames across five seconds', [five.prompt[1].inputs.force_rate, five.prompt[1].inputs.frame_load_cap].join(), '2,10');
  eq('small, which is what the tagger reads at anyway', five.prompt[1].inputs.custom_height, 512);
  eq('with the tagger the pictures use', five.prompt[2].inputs.model, 'wd-swinv2-tagger-v3');
  const twenty = O.videoTagGraph({ video: 'x.mp4 [output]', objectInfo: info, duration: 20 });
  eq('a long clip is spread over, not cut short', twenty.prompt[1].inputs.force_rate, 0.5);
  eq('without a length, one a second up to twenty', [O.videoTagGraph({ video: 'x.mp4 [output]', objectInfo: info }).prompt[1].inputs.force_rate,
    O.videoTagGraph({ video: 'x.mp4 [output]', objectInfo: info }).prompt[1].inputs.frame_load_cap].join(), '1,20');
  check('a ComfyUI without the nodes says which', O.videoTagGraph({ video: 'x', objectInfo: {} }).missing?.includes('VHS_LoadVideo'));

  eq('a file ComfyUI wrote is named for its loader', T.videoFile({ filename: 'a.mp4', subfolder: 'webui' })?.annotated, 'webui/a.mp4 [output]');
  eq('a way out of the folder is not', T.videoFile({ filename: 'a.mp4', subfolder: '../../Windows' }), null);
  eq('nor a name with a path in it', T.videoFile({ filename: '../a.mp4' }), null);
  eq('nor a folder that is not ComfyUI\'s', T.videoFile({ filename: 'a.mp4', type: 'system' }), null);
  eq('nor something that is not a video', T.videoFile({ filename: 'a.png' }), null);
  const cache = T.createVideoTagCache();
  cache.set('output:webui/a.mp4', ['1girl']);
  eq('what was seen is kept', cache.get('output:webui/a.mp4')?.frames?.[0], '1girl');
}

const safeImage = read('src/SafeImage.jsx');
const gallery = read('src/PictureGallery.jsx');
check('a video is judged by its frames and its prompt, the stronger winning',
  /export const useVideoVerdict/.test(safeImage) && /if \(mine\?\.verdict\) return strongest\(mine\.verdict, asked\);[\s\S]{0,80}if \(mine\?\.failed\) return asked \|\| 'safe';/.test(safeImage.slice(safeImage.indexOf('useVideoVerdict'))));
/* The viewer keeps one hook and changes the picture under it: a verdict held
   over from the last one would show the next one bare until the classifier
   answered. */
check('a picture\'s verdict counts only for that picture', /const mine = result\?\.src === src \? result : null;/.test(safeImage));
check('and a film\'s only for that film', /const mine = result\?\.key === key \? result : null;/.test(safeImage));
check('covered until the frames are read', /return asked === 'explicit' \? 'explicit' : 'pending';\s*\n\};\s*\n\s*\n\/\*\* The glass itself/.test(safeImage));
check('in the Studio', /verdict=\{filmVerdict \|\| asked \|\| 'safe'\}/.test(panel) && /file: film \? videoFileOf\(\{ url: film\.url \}\) : null/.test(panel));
check('in the chat', /video=\{!!picture\.video\}/.test(app) && /file=\{picture\.video \? videoFileOf\(/.test(app));
check('which now keeps where its film is', /file: \{ filename: output\.filename, subfolder: output\.subfolder/.test(app));
check('and in the gallery', /const judged = item\.video \? \(filmVerdict \|\| asked \|\| 'safe'\) : verdict;/.test(gallery));
check('the server tags a file once, however many ask', /if \(!tagging\.has\(file\.key\)\)/.test(server) && /const known = videoTags\.get\(file\.key\);/.test(server));
check('and keeps what it saw with the rest of its data', /createVideoTagCache\(\{ file: path\.join\(DATA_DIR, 'video-tags\.json'\) \}\)/.test(server));

/* ------------------------------------------------------------ languages */

const i18n = read('src/i18n.jsx');
for (const key of ['safe.show', 'safe.hide', 'safe.explicit', 'safe.suggestive', 'safe.checking',
  'safe.level', 'safe.level.off', 'safe.level.explicit', 'safe.level.suggestive',
  'studio.find', 'studio.favorites', 'studio.favorite', 'studio.unfavorite', 'studio.noneMatch',
  'studio.batch', 'studio.useAsReference', 'studio.importPng', 'studio.importDrop', 'studio.imported',
  'studio.importNone', 'studio.undo', 'studio.keysHint']) {
  eq(`every language names "${key}"`, i18n.split(`'${key}':`).length - 1, 12);
}

/* ============================ what is in the picture, not what was asked for

   Reported: a prompt that says nothing remarkable, a finished picture that is
   explicit, and it was shown.

   Both of the witnesses a still had can miss that. The prompt knows only the
   request -- "1girl, beach, sitting" is ordinary and the picture is whatever
   the model made of it. The classifier is a 224-pixel MobileNet trained on
   photographs, and on a drawing it is guessing.

   The tagger is not guessing: WD14 was trained on exactly the vocabulary these
   prompts are written in, so its output can be judged by the very same lists,
   and a video has been judged this way for a while. This is that, for a still.
*/

{
  const P = await import(pathToFileURL(path.join(ROOT, 'src/pictureSafety.js')).href);

  // The same reading as a prompt, because it is the same vocabulary.
  eq('tags from the picture are judged as a prompt is',
    P.verdictFromFrames(['1girl, nude, standing']), 'explicit');
  eq('a swimsuit in the picture is suggestive', P.verdictFromFrames(['1girl, bikini, beach']), 'suggestive');
  eq('and an ordinary picture is safe', P.verdictFromFrames(['1girl, school uniform, library']), 'safe');
  eq('nothing read is safe', P.verdictFromFrames([]), 'safe');
  eq('the tag that decided it can be named',
    JSON.stringify(P.decidingTags(['1girl, nude'], 'explicit')), '["nude"]');

  /* Which file to ask about. The name is handed to a node that opens files, so
     a path in it is a way out of the folder and is refused here as well as on
     the server. */
  eq('an address names the file',
    JSON.stringify(P.pictureFileOf({ url: '/studio/view?filename=a.png&subfolder=webui&type=output' })),
    JSON.stringify({ filename: 'a.png', subfolder: 'webui', type: 'output' }));
  eq('a bare name is found where every workflow writes',
    JSON.stringify(P.pictureFileOf({ filename: 'b.png' })),
    JSON.stringify({ filename: 'b.png', subfolder: 'webui', type: 'output' }));
  eq('a path is not a name', P.pictureFileOf({ filename: '../../secrets.png' }), null);
  eq('nor is a video', P.pictureFileOf({ filename: 'a.mp4' }), null);
  eq('and a picture the reader attached has no file at all', P.pictureFileOf({}), null);

  /* ---- the wiring. A witness nobody consults is not a witness. */
  const safeImage = read('src/SafeImage.jsx');
  check('a picture is shown to the tagger as well', /judgePicture\(file\)/.test(safeImage));
  /* And when it has looked, it is the one believed.
   *
   * This was `strongest` of all three, and that was wrong in the direction
   * nobody notices until it happens to them: a witness that cannot be
   * overruled cannot be wrong. The classifier is a 224-pixel MobileNet whose
   * "hentai" class fires on drawn art as such, so on an install that makes
   * anime constantly it calls ordinary pictures explicit -- reported as a gym
   * uniform, nothing in the prompt, nothing in the tags, veiled. The tagger is
   * looking at the same file and is not guessing. */
  /* Including over the prompt, which was the last thing still able to
     overrule it. A prompt is a request made before the picture exists, not a
     description of what arrived; reported as `bottomless` in the request and
     a drawing of a girl in an oversized shirt covering her completely. */
  check('  and when the tagger has looked, it is the witness that answers',
    /if \(seen\) return seen;/.test(safeImage));
  check('  with the classifier standing in only until then',
    /if \(known\) return strongest\(known, asked\);/.test(safeImage)
    && /if \(mine\?\.verdict\) return strongest\(mine\.verdict, asked\);/.test(safeImage));
  /* The prompt is the gate while there is nothing else to go on -- the minute
     the picture is being drawn, and anything the tagger cannot read. That is
     the job it is good at: it is available before the first step has run. */
  check('  with the prompt standing in until something has looked',
    /const asked = promptSignal\(prompt\);/.test(safeImage)
    && /return asked === 'explicit' \? 'explicit' : 'pending';/.test(safeImage));
  /* The point of the whole change: an unremarkable prompt and a classifier
     that says nothing must not be able to show an explicit picture. Since the
     three are combined by `strongest`, that is a property of the combination
     rather than of any one of them -- checked here as arithmetic. */
  eq('an explicit picture is covered however ordinary the prompt was',
    S.strongest(S.strongest('safe', S.promptSignal('1girl, beach, sitting')), 'explicit'), 'explicit');
  /* The other direction, which is the one that was reported: an ordinary
     picture the classifier called explicit is not veiled once the tagger has
     read the file and found nothing. The prompt still is not overruled. */
  eq('a tagger that looked and found nothing is believed over the classifier',
    S.strongest(S.promptSignal('1girl, gym uniform, indoors'), 'safe') || 'safe', 'safe');
  eq('but not over a prompt that asked for it',
    S.strongest(S.promptSignal('1girl, nude'), 'safe'), 'explicit');

  check('the Studio, the gallery and the viewer all hand it the file',
    /file: picture \? pictureFileOf\(/.test(read('src/StudioPanel.jsx'))
    && /file: item\.video \? null : pictureFileOf\(/.test(read('src/PictureGallery.jsx'))
    && /pictureFileOf\(\{ url: item\.url, filename: item\.filename \}\)/.test(read('src/StudioLightbox.jsx')));
  check('and so does a picture drawn in a conversation',
    /filename=\{picture\.filename \|\| ''\}/.test(read('src/App.jsx'))
    && /file: video \? null : pictureFileOf\(\{ url: src, filename \}\)/.test(safeImage));

  // One run per file, however many cards are looking at it.
  check('a gallery of sixty does not queue sixty tagging jobs',
    /let busy = false;/.test(read('src/pictureSafety.js'))
    && /known\.set\(key, asked\)/.test(read('src/pictureSafety.js')));

  const studio = read('server/studio.js');
  check('the server tags a still with the same tagger it tags frames with',
    /route\('\/studio\/picture-tags'/.test(studio) && /tagGraph\(\{ image: file\.annotated/.test(studio));
  check('  and keeps the answer, so a picture is tagged once ever',
    /picture-tags\.json/.test(studio));
  check('  behind the same name check a video gets',
    /const file = pictureFile\(body\);/.test(studio));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
