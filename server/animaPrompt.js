/**
 * A prompt for Anima, as tags and a sentence.
 *
 * Anima was trained on danbooru tags *and* on natural-language captions, and
 * reads a prompt best as both: the tags first, which pin down exactly what is
 * in the picture in the vocabulary it learned it in, then a sentence for what
 * tags cannot say -- mood, light, how things relate.
 *
 * A language model asked for a picture writes prose. Some of that prose is
 * tags already ("sparkling eyes", "school uniform"), some of it nearly is ("a
 * short bob haircut" is `bob cut`), and some of it is description no tag
 * covers. So the prompt is read phrase by phrase against the tag list this app
 * already ships for the Studio's autocomplete:
 *
 *   - a phrase that *is* a tag becomes that tag, spelled the way the list
 *     spells it;
 *   - a phrase that is not keeps its words, as the sentence, and any tags
 *     inside it are also pulled out to the front -- "large sparkling eyes"
 *     stays in the sentence and puts `sparkling eyes` among the tags;
 *   - nothing is invented. A tag appears only if its words were in the prompt.
 *
 * Pure: the index is passed in, so this is testable against a handful of rows.
 */

import { findTag } from './booruTags.js';

const GENERAL = 0;

/* How common a tag inside a sentence has to be before it is lifted out.
   Single words are held to a much higher bar: prose is full of words that also
   happen to be tags ("red", "open"), and a rare tag that happens to be an
   English word is the one most likely to be a coincidence. */
const MIN_PHRASE = 2000;
const MIN_WORD = 50000;

/* Single words that are tags with huge counts and are also ordinary prose, so
   finding them in a sentence says nothing about the picture. */
const PROSE = new Set([
  'no', 'on', 'one', 'solo', 'looking', 'holding', 'open', 'from', 'side', 'white', 'black',
  'long', 'short', 'up', 'down', 'back', 'multiple', 'simple', 'full', 'upper', 'lower',
]);

/* "A girl" is `1girl` to a booru and nothing at all to the tag list, which is
   the single most common gap between how people describe a picture and how
   the model was taught to read one. */
const PEOPLE = [
  [/^(?:an? |one |1 )?(?:(?:cute|little|young|small|adorable|beautiful|pretty) )*(?:girl|woman|lady)$/, '1girl'],
  [/^(?:an? |one |1 )?(?:(?:cute|little|young|small|handsome) )*(?:boy|man|guy)$/, '1boy'],
  [/^(?:two|2) (?:girls|women)$/, '2girls'],
  [/^(?:two|2) (?:boys|men)$/, '2boys'],
];

const ARTICLE = /^(?:a|an|the|some|with|and|in|wearing|has|having)\s+/i;

/** The phrase, stripped of the words that make it prose rather than a tag. */
const bare = (phrase) => {
  let out = String(phrase || '').trim().replace(/[.!;:]+$/g, '').trim();
  for (let i = 0; i < 3 && ARTICLE.test(out); i += 1) out = out.replace(ARTICLE, '');
  return out.trim();
};

/** Tags said inside a sentence, longest first, without overlap. */
const tagsInside = (index, words) => {
  const found = [];
  const used = new Array(words.length).fill(false);
  for (let size = Math.min(4, words.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (used.slice(start, start + size).some(Boolean)) continue;
      const phrase = words.slice(start, start + size).join(' ');
      if (size === 1 && PROSE.has(phrase)) continue;
      // "bob haircut" is how people say `bob cut`.
      let i = findTag(index, phrase);
      if (i === -1 && /\bhaircut\b/.test(phrase)) i = findTag(index, phrase.replace(/\bhaircut\b/, 'cut'));
      if (i === -1 || index.categories?.[i] !== GENERAL) continue;
      if (index.counts[i] < (size === 1 ? MIN_WORD : MIN_PHRASE)) continue;
      found.push({ at: start, name: index.names[i] });
      for (let k = start; k < start + size; k += 1) used[k] = true;
    }
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.name);
};

/**
 * Shape a prompt for Anima. Returns the prompt and what was found in it, so the
 * caller can say what happened.
 */
export const shapeAnimaPrompt = (prompt, index) => {
  const source = String(prompt || '').trim();
  if (!source || !index?.size) return { prompt: source, tags: [], sentence: source, changed: false };

  const tags = [];
  const seen = new Set();
  const addTag = (name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(name);
  };
  const sentence = [];

  for (const raw of source.split(/[,\n]+/)) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const plain = bare(phrase).toLowerCase();

    const person = PEOPLE.find(([pattern]) => pattern.test(plain));
    if (person) { addTag(person[1]); continue; }

    let i = plain ? findTag(index, plain) : -1;
    if (i === -1 && /\bhaircut\b/.test(plain)) i = findTag(index, plain.replace(/\bhaircut\b/, 'cut'));
    // Any category but meta: `highres` and `commentary request` describe a post.
    if (i !== -1 && index.categories?.[i] !== 5) { addTag(index.names[i]); continue; }

    sentence.push(phrase);
    // "girl" inside a sentence is still one girl -- and who is in the picture
    // leads, as it does in every booru caption.
    if (/\b(?:girl|woman)\b/.test(plain) && !/\b(?:girls|women)\b/.test(plain) && !seen.has('2girls')) addTag('1girl');
    const words = plain.replace(/[^\p{L}\p{N}'\- ]+/gu, ' ').split(/\s+/).filter(Boolean);
    for (const name of tagsInside(index, words)) addTag(name);
  }

  const text = sentence.join(', ').trim();
  const shaped = [tags.join(', '), text && (/[.!?]$/.test(text) ? text : `${text}.`)]
    .filter(Boolean)
    .join(', ');
  return { prompt: shaped, tags, sentence: text, changed: shaped !== source };
};
