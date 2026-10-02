// The Studio's black-and-white switch: what it does to a request on the way
// out. All pure; see src/monochrome.js for why the LoRAs are the point.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  MONO_TAGS, splitTopLevel, monochromePrompt, monochromePart, monochromeParts,
  monochromeNegative, monochromeLoras, applyMonochrome,
} = await import(pathToFileURL(path.resolve(HERE, '../src/monochrome.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------ splitting
check('a weighted group is one piece',
  JSON.stringify(splitTopLevel('a, (b, c:0.75), d')) === JSON.stringify(['a', '(b, c:0.75)', 'd']));
check('escaped brackets are text, not grouping',
  JSON.stringify(splitTopLevel(String.raw`safe \(container\), 1girl`)) === JSON.stringify([String.raw`safe \(container\)`, '1girl']));
check('empty pieces are dropped', splitTopLevel('a,, ,b').length === 2);

// ------------------------------------------------------------ the prompt
const lead = 'newest, (best quality), anime coloring, flat color, 1girl, colored eyelashes, (colorful:1.2), smile';
const mono = monochromePrompt(lead);
console.log(`\n  ${mono}\n`);
check('mono tags go first', mono.startsWith(MONO_TAGS.join(', ')), mono);
check('colour words are out',
  !/anime coloring|flat color|colored eyelashes|colorful/.test(mono), mono);
check('everything else stays, in order', mono.endsWith('newest, (best quality), 1girl, smile'), mono);
check('mono tags already there are not doubled',
  (monochromePrompt('monochrome, 1girl, greyscale').match(/monochrome/g) || []).length === 1);
check('a weighted group keeps its weight and loses its colour words',
  monochromePrompt('1girl, (muted color, clean composition:0.75)').endsWith('1girl, (clean composition:0.75)'));
check('a group left with nothing goes, rather than staying as "(:0.75)"',
  monochromePrompt('1girl, (muted color, flat color:0.75)') === 'monochrome, greyscale, 1girl');
check('a weighted mono tag is not doubled either',
  (monochromePrompt('(monochrome:1.7), 1girl').match(/monochrome/g) || []).length === 1);
check('an empty prompt is just the mono tags', monochromePrompt('') === MONO_TAGS.join(', '));

// ------------------------------------------------------------ one box
check('a colour in front of eyes or hair takes the tag with it',
  monochromePart('blue eyes, light brown hair, 1girl') === '1girl');
check('a colour in front of a thing leaves the thing', monochromePart('pink bow, red dress') === 'bow, dress');
check('black, white and grey are what the picture is made of',
  monochromePart('black hair, white dress, grey eyes') === 'black hair, white dress, grey eyes');
check('an escaped bracket is text, not a group',
  monochromePart(String.raw`safe \(container\), watercolor \(medium\)`) === String.raw`safe \(container\)`);
check('a weighted artist keeps its brackets',
  monochromePart('(@hiro (dismaless):1.4), @saho 4545') === '(@hiro (dismaless):1.4), @saho 4545');
check('prose asking for a painting asks for a drawing',
  monochromePart('A masterpiece digital painting by top tier artists')
    === 'A masterpiece line drawing by top tier artists');
check('prose asking for colour asks for tones',
  monochromePart('soft light and vibrant colors all around') === 'soft light and greyscale tones all around');
check('short tags are not treated as prose', monochromePart('oil painting') === 'oil painting');

// ------------------------------------------------------------ the four boxes
/* The boxes from the picture that started this: a lead asking for anime
   colouring, mono tags typed into the artist box, and a trailing group and
   sentence asking for watercolour and painting. */
const parts = monochromeParts({
  lead: 'newest, (best quality), score_8, anime coloring, flat color, minimalist vector illustration',
  artist: '(@ningen mame:1.3), (@naga u:1.1), monochrome, lineart, greyscale,',
  prompt: '1girl, blush, colored eyelashes, brown eyes, grey hair, smile',
  tail: String.raw`(low-contrast, muted color, watercolor \(medium\), clean composition:0.75), A masterpiece digital painting by top tier artists, featuring a high quality character focus`,
});
console.log(`\n  ${JSON.stringify(parts, null, 2).replace(/\n/g, '\n  ')}\n`);
check('the lead starts with the mono tags and loses its colouring',
  parts.lead === 'monochrome, greyscale, newest, (best quality), score_8, minimalist vector illustration', parts.lead);
check('the artist box keeps the artists and loses what is not one',
  parts.artist === '(@ningen mame:1.3), (@naga u:1.1), lineart', parts.artist);
check('the main box loses colours but not the subject',
  parts.prompt === '1girl, blush, grey hair, smile', parts.prompt);
check('the tail keeps its group, weight and sentence, in black and white',
  parts.tail === '(low-contrast, clean composition:0.75), A masterpiece line drawing by top tier artists, featuring a high quality character focus',
  parts.tail);
check('the boxes as sent do not repeat the mono tags',
  (Object.values(parts).join(', ').match(/monochrome/g) || []).length === 1);
check('putting them through again changes nothing',
  JSON.stringify(monochromeParts(parts)) === JSON.stringify({ ...parts, lead: parts.lead }));

// ------------------------------------------------------------ the negative
check('monochrome is taken out of the negative',
  monochromeNegative('worst quality, monochrome, (greyscale:1.2), blurry') === 'worst quality, blurry');

// ------------------------------------------------------------ LoRAs
const stack = [
  { name: 'anima/style/saltystyle_v1_epoch20.safetensors', weight: 0.4 },
  { name: 'anima/ningenmame_v2.safetensors', weight: 0.7 },
  { name: 'anima/hiro_character.safetensors', weight: 0.9 },
  { name: 'anima/lineart_v3.safetensors', weight: 0.6 },
  { name: 'anima/line_art_clean.safetensors', weight: 0.6 },
  { name: 'anima/pink_style.safetensors', weight: 0.5 },
];
const kept = monochromeLoras(stack, ['anima/hiro_character.safetensors']).map(l => l.name);
check('style LoRAs are left out', !kept.some(n => /saltystyle|ningenmame/.test(n)), kept.join(' | '));
check('a character LoRA stays', kept.includes('anima/hiro_character.safetensors'));
check('line-art LoRAs stay', kept.includes('anima/lineart_v3.safetensors') && kept.includes('anima/line_art_clean.safetensors'));
check('a Windows path from ComfyUI is read by its words too',
  monochromeLoras([{ name: String.raw`anima\style\lineart_v3.safetensors` }]).length === 1);
check('"ink" is a word, not a substring of "pink"', !kept.includes('anima/pink_style.safetensors'));

// ------------------------------------------------------------ a request
const request = { model: 'anima-base', prompt: 'flat color, 1girl', negative: 'monochrome, blurry', loras: stack.slice(0, 2), steps: 30 };
const out = applyMonochrome(request);
check('no LoRAs left means no loras field, so the server empties every slot', !('loras' in out));
check('the rest of the request is untouched', out.steps === 30 && out.model === 'anima-base');
check('the request passed in is not changed', request.prompt === 'flat color, 1girl' && request.loras.length === 2);
check('no negative stays no negative', !('negative' in applyMonochrome({ prompt: '1girl' })));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
