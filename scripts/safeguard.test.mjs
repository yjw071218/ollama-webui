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
check('the verdict is kept on the job, so it syncs', /safety: \{ verdict, scores \}/.test(panel));
check('the last preview frame is not shown behind a veiled picture', /lastFrame && !hidden/.test(panel));
check('a half-drawn picture is veiled by its prompt', /veil=\{shouldVeil\(asked, level\)\}/.test(panel)
  && /studio-progress-frame \$\{veiled \? 'is-veiled'/.test(progress));
check('the viewer keeps the veil and will not enlarge through it',
  /if \(!veiledNow\.current\) setFull\(true\);/.test(lightbox) && /<VeilOverlay/.test(lightbox));
check('pictures in a conversation are veiled too', /<SafePicture src=\{picture\.dataUrl\}/.test(app));
check('and so is the picture being drawn for one', /veil=\{shouldVeil\(promptSignal\(drawing\.prompt\), safeLevel\)\}/.test(app));
check('the verdict cache is this browser\'s, not a synced setting', /'nsfwVerdicts'/.test(store));
check('the level can be changed from the gallery', /setSafeguardLevel\(e\.target\.value\)/.test(panel));

// The gallery's lighter copies.
check('the gallery shows thumbnails', /<img src=\{thumbOf\(item\.url\)\}/.test(panel));
check('the viewer still opens the file itself', /url: job\.outputs\[0\]\.url,/.test(panel));
check('the server passes on only the previews ComfyUI accepts',
  /\/\^\(webp\|jpeg\);\\d\{1,3\}\$\/\.test\(preview\)/.test(server));

/* ------------------------------------------------------------ languages */

const i18n = read('src/i18n.jsx');
for (const key of ['safe.show', 'safe.hide', 'safe.explicit', 'safe.suggestive', 'safe.checking',
  'safe.level', 'safe.level.off', 'safe.level.explicit', 'safe.level.suggestive',
  'studio.find', 'studio.favorites', 'studio.favorite', 'studio.unfavorite', 'studio.noneMatch',
  'studio.batch', 'studio.useAsReference', 'studio.importPng', 'studio.importDrop', 'studio.imported',
  'studio.importNone', 'studio.undo', 'studio.keysHint']) {
  eq(`every language names "${key}"`, i18n.split(`'${key}':`).length - 1, 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
