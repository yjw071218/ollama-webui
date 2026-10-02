/**
 * Black and white, as a switch rather than as tags somebody has to know.
 *
 * Typing `monochrome, greyscale` was not enough, and it was measured why. The
 * same seed and settings were redrawn with one thing changed at a time, and
 * how much colour came out read as the mean spread between each pixel's
 * channels (0 is pure grey; the coloured pictures were 8 to 11):
 *
 *   the settings as they were                         8.8
 *   colour words taken out, mono tags moved to front  8.8
 *   every LoRA switched off, nothing else changed      1.6
 *   a short mono prompt with the eight LoRAs on        9.0
 *   the long prompt with any one of them on           1 to 3, except one at 10.4
 *
 * So it is the style LoRAs, together. Each was trained on coloured pictures,
 * and stacked they outvote two tags; the artist names and the negative prompt
 * moved the number by a few tenths. The prompt's own colour words matter only
 * with the LoRAs on, and are taken out anyway because they are asking for the
 * opposite of what the switch says.
 *
 * What the switch keeps: a character's LoRA, which is a likeness rather than a
 * palette and is the reason the picture is of her at all, and a LoRA whose
 * name says it is for line art or monochrome, which is on the switch's side.
 *
 * Applied to the request and not to the form: switching it off gives back
 * exactly what was there, which is the whole difference between a switch and
 * an edit.
 */

/** What goes in front. Front, because these models read a prompt by position. */
export const MONO_TAGS = ['monochrome', 'greyscale'];

/* Asked for by name in quality rows and tag lists, and all of them are colour.
   Compared after the same cleaning the tag list gets: lower case, spaces for
   underscores, escapes and a weight taken off. */
const COLOUR_TAGS = new Set([
  'anime coloring', 'flat color', 'colorful', 'vibrant colors', 'vivid colors',
  'muted color', 'pastel colors', 'color', 'full color', 'colored eyelashes',
  'watercolor (medium)', 'gradient', 'rainbow', 'spot color', 'partially colored',
  'limited palette', 'cel shading', 'soft shading',
]);

/* A LoRA that is on the switch's side. By file name, because that is all there
   is to go on, and these are the words such files are named with. Whole words
   of the name, or `ink` is also `pink` and `mono` is also `monotone_pastel`. */
const MONO_WORDS = new Set([
  'lineart', 'monochrome', 'mono', 'greyscale', 'grayscale', 'sketch', 'ink', 'manga', 'bw',
]);
const isMonoLora = (name) => {
  const words = String(name || '').toLowerCase().replace(/\.[a-z]+$/, '').split(/[^a-z0-9]+/);
  return words.some((word, i) => MONO_WORDS.has(word) || (word === 'line' && words[i + 1] === 'art'));
};

/* A tag as the tag list spells it: lower case, spaces for underscores, the
   escapes and a weight taken off. Brackets that group are not here -- a piece
   that opens with one is a group and is taken apart before it gets this far. */
const cleanTag = (raw) => String(raw || '')
  .trim()
  .replace(/:[\d.]+$/, '')
  .replace(/\\([()])/g, '$1')
  .replace(/_/g, ' ')
  .trim()
  .toLowerCase();

/* A colour word in front of a thing: `blue eyes`, `pink bow`, `light brown
   hair`. Danbooru leaves colours off a monochrome picture's tags, so these are
   words the model has only ever seen on coloured ones. Black, white and grey
   are not here: they are what a black-and-white picture is made of. */
const COLOUR_WORD = /^(?:(?:light|dark|pale|bright|deep)\s+)?(?:red|blue|green|yellow|orange|purple|pink|brown|blonde|aqua|cyan|teal|violet|lavender|magenta|gold|golden|silver|beige|crimson|scarlet|navy|platinum blonde|multicolored|two-tone|gradient|streaked|colored)\s+(.+)$/;

/* What is left of `blue eyes` once the colour is gone says nothing a
   black-and-white picture needs said, so the whole tag goes. `pink bow`
   keeps its bow. */
const ONLY_A_COLOUR_OF = new Set(['eyes', 'hair', 'skin', 'lips', 'nails', 'eyeshadow', 'background', 'theme', 'sky']);

/* Prose, where a sentence asks for a medium or a palette. Rewritten rather than
   dropped: the rest of the sentence -- composition, focus, the look of the
   thing -- is still wanted. */
const PROSE = [
  [/\b(?:digital |oil |acrylic |watercolou?r )?painting\b/gi, 'line drawing'],
  [/\b(?:vibrant|vivid|muted|pastel|rich|warm|cool|soft|bright|saturated)\s+colou?rs?\b/gi, 'greyscale tones'],
  [/\bfull[- ]colou?r\b/gi, 'monochrome'],
  [/\bcolou?rful\b/gi, 'monochrome'],
];
const isProse = (piece) => piece.trim().split(/\s+/).length >= 4;

/**
 * A prompt's comma-separated pieces, with a bracketed group kept whole.
 *
 * `(low-contrast, muted color:0.75)` is one weighted group, and cutting it at
 * its commas leaves two unbalanced halves that the encoder reads as emphasis
 * on everything after them. Escaped brackets are text, not grouping.
 */
export const splitTopLevel = (text) => {
  const pieces = [];
  let depth = 0;
  let current = '';
  const value = String(text || '');
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) { current += ch + value[++i]; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (ch === ',' && depth === 0) { pieces.push(current); current = ''; continue; }
    current += ch;
  }
  pieces.push(current);
  return pieces.map(p => p.trim()).filter(Boolean);
};

/* A piece that is one bracketed group from end to end -- `(a, b:0.75)` or
   `(tag)` -- as its inside and its weight. Not `(a) and (b)`, which opens and
   closes twice, and not an escaped `\(medium\)`. */
const asGroup = (piece) => {
  if (!piece.startsWith('(') || !piece.endsWith(')') || piece.endsWith('\\)')) return null;
  let depth = 0;
  for (let i = 0; i < piece.length; i++) {
    const ch = piece[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0 && i < piece.length - 1) return null; }
  }
  const inner = piece.slice(1, -1);
  const weighted = inner.match(/^([\s\S]*?):(\d+(?:\.\d+)?)$/);
  return weighted ? { inner: weighted[1], weight: weighted[2] } : { inner, weight: null };
};

/**
 * Every piece of a prompt through `each`, groups taken apart and put back.
 *
 * `each(piece, tag)` returns the piece to keep, a replacement, or null to
 * drop it. A group that loses everything goes too, rather than staying as an
 * empty `(:0.75)`.
 */
const mapPieces = (text, each) => splitTopLevel(text)
  .map((piece) => {
    const group = asGroup(piece);
    if (group) {
      const inside = mapPieces(group.inner, each);
      if (!inside) return null;
      return group.weight ? `(${inside}:${group.weight})` : `(${inside})`;
    }
    return each(piece, cleanTag(piece));
  })
  .filter(Boolean)
  .join(', ');

/** One box, black and white: colour tags out, colour words off, prose rewritten. */
export const monochromePart = (text) => mapPieces(text, (piece, tag) => {
  if (COLOUR_TAGS.has(tag) || MONO_TAGS.includes(tag)) return null;
  const coloured = tag.match(COLOUR_WORD);
  if (coloured && !piece.includes(' (')) {
    return ONLY_A_COLOUR_OF.has(coloured[1]) ? null : coloured[1];
  }
  if (isProse(piece)) return PROSE.reduce((out, [from, to]) => out.replace(from, to), piece);
  return piece;
});

/** The prompt, black and white: mono tags first, then what `monochromePart` leaves. */
export const monochromePrompt = (prompt) => {
  const rest = monochromePart(prompt);
  return [MONO_TAGS.join(', '), rest].filter(Boolean).join(', ');
};

/**
 * The four boxes, black and white, each on its own terms.
 *
 * The lead gets the mono tags, because it is what is read first. The artist
 * box loses only what is not an artist: on Anima it goes, name by name, to an
 * encoder of its own, where `monochrome` would be encoded as somebody's style.
 */
export const monochromeParts = ({ lead = '', artist = '', prompt = '', tail = '' } = {}) => ({
  lead: monochromePrompt(lead),
  artist: monochromePart(artist),
  prompt: monochromePart(prompt),
  tail: monochromePart(tail),
});

/* The negative the other way round: a `monochrome` there, often left in from a
   workflow author's list, is the switch arguing with itself. */
export const monochromeNegative = (negative) => mapPieces(negative,
  (piece, tag) => (MONO_TAGS.includes(tag) ? null : piece));

/** The LoRAs that may stay on: characters, and anything for line art. */
export const monochromeLoras = (loras = [], keepNames = []) => {
  const keep = new Set(keepNames.filter(Boolean));
  return (loras || []).filter(row => row?.name && (keep.has(row.name) || isMonoLora(row.name)));
};

/**
 * A request, black and white. `characterLoras` are the files the character
 * library knows, which stay on.
 *
 * The prompt should already have been joined from `monochromeParts`; it is put
 * through once more here, which changes nothing in one that was, and is what
 * makes a request built any other way come out right too.
 */
export const applyMonochrome = (request, { characterLoras = [] } = {}) => {
  const out = { ...request, prompt: monochromePrompt(request.prompt) };
  if (typeof request.artist === 'string') out.artist = monochromePart(request.artist);
  if (typeof request.negative === 'string') out.negative = monochromeNegative(request.negative);
  if (Array.isArray(request.loras)) {
    const loras = monochromeLoras(request.loras, characterLoras);
    if (loras.length) out.loras = loras;
    else delete out.loras;
  }
  return out;
};
