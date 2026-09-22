// Turning a picture back into a prompt: what the tagger said, what the vision
// model wrote, and what the box says afterwards.
//
// All pure. The two halves that are not -- uploading the file and asking
// ComfyUI and Ollama -- are a few lines in StudioPanel.jsx; every decision
// about what lands in somebody's prompt is here, where it can be asserted.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.describe-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/describeImage.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  DESCRIBE_PROMPT, tagsFromFrames, tagsIn, newTags, readDescription,
  composePrompt, isDescribable, imageOnClipboard,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------------ prompt
check('the model is told to write English', /in English/.test(DESCRIBE_PROMPT));
// The four ways this reply comes back wrong, each addressed by a line.
check('and not to open with "this image shows"', /this image shows/i.test(DESCRIBE_PROMPT));
check('and given a length', /one or two sentences/i.test(DESCRIBE_PROMPT));
check('and told the tagger covers the subject',
  /tagger already names/i.test(DESCRIBE_PROMPT));

// -------------------------------------------------------------------- tags
const FRAME = '1girl, solo, long_hair, thighhighs, holding sword, rain, night, highres, explicit';
const tags = tagsFromFrames([FRAME]);

check('tags come out in order', tags[0] === '1girl' && tags[1] === 'solo');
// WD14 writes underscores; a prompt is written with spaces.
check('underscores become spaces', tags.includes('long hair'), JSON.stringify(tags));
// The safeguard's vocabulary, not the prompt's: `explicit` in a prompt asks
// for nothing.
check('a rating tag is dropped', !tags.includes('explicit'), JSON.stringify(tags));
// About the file rather than its subject, and this app keeps those in the
// quality rows above and below.
check('a file-property tag is dropped', !tags.includes('highres'), JSON.stringify(tags));
check('everything else survives',
  tags.includes('thighhighs') && tags.includes('holding sword') && tags.includes('rain'));

// A video's tags arrive as one string per frame, and reading them as a set is
// what makes this work on one without knowing it has one.
const many = tagsFromFrames(['1girl, sword', '1girl, rain', 'sword, night']);
check('frames are merged without duplicates',
  many.join('|') === '1girl|sword|rain|night', many.join('|'));

check('nothing is safe', tagsFromFrames([]).length === 0 && tagsFromFrames(null).length === 0);
check('an empty frame yields nothing', tagsFromFrames(['']).length === 0);
check('stray commas yield nothing', tagsFromFrames([' , , ']).length === 0);

// ------------------------------------------------------- against what is there
const EXISTING = '1girl, solo, (long hair:1.2), masterpiece';
const already = tagsIn(EXISTING);
check('the tags already written are recognised', already.has('1girl') && already.has('solo'));
// A weighted tag is the same tag.
check('a weight does not hide a tag', already.has('long hair'), [...already].join('|'));

/* The commonest use of this is on a picture made from the prompt still in the
   box. Without this, `1girl, solo` becomes `1girl, solo, 1girl, solo` and every
   one of those doubles its weight. */
const fresh = newTags(tags, EXISTING);
check('a tag the prompt already has is not added again',
  !fresh.includes('1girl') && !fresh.includes('solo') && !fresh.includes('long hair'),
  JSON.stringify(fresh));
check('and the new ones are', fresh.includes('thighhighs') && fresh.includes('rain'));
check('an empty prompt keeps everything', newTags(tags, '').length === tags.length);

// ------------------------------------------------------------- the sentence
check('a plain description is kept',
  readDescription('A lone figure under a streetlight, lit from behind by the rain.')
    === 'A lone figure under a streetlight, lit from behind by the rain');
// A prompt is not a sentence and does not want the full stop.
check('the trailing full stop goes',
  !readDescription('Something happens.').endsWith('.'));

check('"This image shows" is removed',
  readDescription('This image shows a girl standing in the rain')
    === 'a girl standing in the rain');
check('so is "Here is a description:"',
  readDescription('Here is a description: dark alley, neon reflections')
    === 'dark alley, neon reflections');
check('and "Sure! The picture depicts"',
  readDescription('Sure! The picture depicts a quiet room at dusk')
    === 'a quiet room at dusk');
// A description that legitimately begins that way must survive.
check('a sentence that really starts "The image of" survives',
  /^The image of her/.test(readDescription('The image of her is reflected in the window')),
  readDescription('The image of her is reflected in the window'));

check('markdown is stripped',
  readDescription('**Dramatic** lighting with `hard` shadows') === 'Dramatic lighting with hard shadows');
check('a bulleted list becomes prose',
  readDescription('- soft light\n- shallow depth of field').includes('soft light'));
check('surrounding quotes are removed',
  readDescription('"A rainy street at night"') === 'A rainy street at night');
check('reasoning emitted inline is stripped',
  readDescription('<think>hmm</think>A rainy street') === 'A rainy street');

// Two, because that is what was asked for; a model that wrote six wrote a
// caption and the last four restate it.
const six = readDescription('One. Two. Three. Four. Five. Six.');
check('only two sentences are kept', six === 'One. Two', six);

check('a long description is cut at a clause, not mid-word', (() => {
  const out = readDescription(`${'a quiet room, '.repeat(60)}end`, { maxChars: 100 });
  return out.length <= 100 && !/\ba quiet roo$/.test(out);
})());

check('an empty reply is no sentence', readDescription('') === '');
check('a reply that was only a preamble is no sentence',
  readDescription('Sure! Here is a description:') === '');
check('whitespace is no sentence', readDescription('   \n  ') === '');

// ------------------------------------------------------------- the result
const composed = composePrompt(EXISTING, { tags, sentence: 'Lit from behind by the rain' });
console.log(`\n  ${JSON.stringify(composed)}\n`);

check('what was already written comes first', composed.startsWith(EXISTING));
check('the new tags follow it', composed.includes('thighhighs'));
// Tags first and the sentence last, which is what Anima and the SDXL family
// read best -- and the order the rest of this app writes in.
check('and the sentence is last', composed.endsWith('Lit from behind by the rain'));
check('nothing is duplicated',
  (composed.match(/1girl/g) || []).length === 1, composed);

const replaced = composePrompt(EXISTING, { tags, sentence: 'A rainy street' }, { replace: true });
check('replacing drops what was there', !replaced.includes('masterpiece'), replaced);
check('and keeps every tag, since none can be a duplicate now',
  replaced.startsWith('1girl, solo, long hair'), replaced);

check('an empty box just gets the description',
  composePrompt('', { tags: ['1girl'], sentence: 'At dusk' }) === '1girl, At dusk');
check('tags with no sentence is a valid result',
  composePrompt('', { tags: ['1girl', 'solo'] }) === '1girl, solo');
// The tagger can be unreachable while the vision model is not.
check('a sentence with no tags is a valid result',
  composePrompt('', { sentence: 'At dusk' }) === 'At dusk');
check('nothing at all leaves the box as it was',
  composePrompt('1girl', {}) === '1girl');
check('a trailing comma in the box is not doubled',
  composePrompt('1girl, ', { tags: ['solo'] }) === '1girl, solo');

// ------------------------------------------------------------------ files
check('a PNG is describable', isDescribable({ name: 'a.png', type: 'image/png' }));
check('a JPEG with no type is describable', isDescribable({ name: 'a.jpg', type: '' }));
// The tagger loads a still; an SVG is not raster and a GIF is a video to it.
check('an SVG is not', !isDescribable({ name: 'a.svg', type: 'image/svg+xml' }));
check('a PDF is not', !isDescribable({ name: 'a.pdf', type: 'application/pdf' }));
check('nothing is not', !isDescribable(null));

const clip = (items, files = []) => ({ items, files });
const png = { name: 'x.png', type: 'image/png' };
check('an image on the clipboard is found',
  imageOnClipboard(clip([{ kind: 'file', getAsFile: () => png }])) === png);
// A copied file in a file manager arrives as a file with text beside it.
check('text beside the image does not hide it',
  imageOnClipboard(clip([{ kind: 'string' }, { kind: 'file', getAsFile: () => png }])) === png);
check('a clipboard with only text has none',
  imageOnClipboard(clip([{ kind: 'string' }])) === null);
check('an empty clipboard is safe', imageOnClipboard(null) === null);
check('files are looked at when items are not given',
  imageOnClipboard({ files: [png] }) === png);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
