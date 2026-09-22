/**
 * A picture, turned back into a prompt.
 *
 * "Make me one like this" is the commonest thing anybody wants from a
 * reference, and until now the Studio had no way to hear it. The reference
 * picker hands ComfyUI a file for a workflow to load — img2img, a region edit,
 * a video's first frame — every one of which *redraws the picture it was
 * given*. None of them answer "what words would have produced this", which is
 * what you need in order to make a different picture in the same vein: the
 * same outfit on another character, the same light in another place.
 *
 * Two things already in this install know the answer between them, and neither
 * knows it alone.
 *
 * ## The tagger names, the vision model describes
 *
 * WD14 was trained on exactly the danbooru vocabulary these prompts are
 * written in, so `thighhighs` from the tagger is the word the picture model
 * learned that garment under. A language model looking at the same picture
 * writes "long socks", which is not a tag and does not draw one. For the tags,
 * the tagger is not merely better — it is the only one of the two that is
 * speaking the right language.
 *
 * It is also the only one that cannot say anything else. A tag list is a set
 * of nouns with no relations in it: `1girl, sword, rain, night` does not say
 * she is holding the sword, or that the rain is lit from behind her. That is
 * what the vision model is for, and it is the same division `server/animaPrompt.js`
 * already makes for Anima — tags first for what is in the picture, then a
 * sentence for what tags cannot say.
 *
 * So the sentence is written from the *picture*, not from the tags. Asking a
 * model to turn `1girl, sword, rain` into prose produces "a girl with a sword
 * in the rain", which is the tag list with joining words in it and adds
 * nothing at all.
 *
 * ## What is dropped, and why
 *
 * WD14's rating tags (`general`, `sensitive`, `questionable`, `explicit`) are
 * the safeguard's vocabulary — see `src/safeguard.js` — and not prompt words:
 * putting `explicit` in a prompt does not ask for anything, it just sits
 * there. The image-property tags (`highres`, `absurdres`, `official art`) are
 * about the *file* rather than its subject, and this app already keeps those
 * in the quality rows above and below the subject, where they were set once
 * and left alone. Neither belongs in the box this writes into.
 */

/**
 * What the vision model is asked.
 *
 * Written against the four ways this reply comes back wrong. It opens with
 * "This image shows", so it is told not to. It lists what is in the picture,
 * duplicating the tags, so it is told what the tags already cover. It writes a
 * paragraph, so it is given a length. And it writes in the language of the
 * conversation, which for a picture model is useless — every one of these is
 * trained on English captions.
 */
export const DESCRIBE_PROMPT = [
  'Describe this picture as a prompt for an image generator.',
  '',
  'Write one or two sentences in English, and only the sentences.',
  'No preamble, no "this image shows", no list, no markdown.',
  '',
  'A separate tagger already names the subject, the clothing and the pose.',
  'Do not list those. Write what a tag list cannot say: the mood, the light,',
  'the camera, the setting, and how the things in the picture relate to one',
  'another.',
].join('\n');

/* The openings models put in front of the answer.
   Anchored to the start, and the verb is required rather than optional, which
   is what tells an opening from a subject: "the image shows" is a preamble and
   "the image of her is reflected in the window" is the description. Without
   that, `the image of ` matched and the sentence began "her is reflected". */
const PREAMBLE = /^\s*(?:(?:sure|certainly|of course|okay|ok)[,!.]?\s*)?(?:here(?:'s| is| are)[^\n:]{0,40}:\s*|(?:this|the)\s+(?:image|picture|photo|illustration|artwork)\s+(?:is|shows?|depicts?|features?|portrays?)\s+(?:of\s+)?)/i;

/* What the tagger says about the file rather than about its subject. These are
   the Studio's quality rows' business, set once and left alone, and repeating
   them in the subject box is noise that also outvotes what was typed. */
const PROPERTY_TAGS = new Set([
  'highres', 'absurdres', 'lowres', 'incredibly absurdres', 'huge filesize',
  'official art', 'official alternate costume', 'official alternate hairstyle',
  'scan', 'artist name', 'signature', 'watermark', 'web address', 'username',
  'commentary', 'commentary request', 'english commentary', 'bad id', 'bad pixiv id',
  'md5 mismatch', 'resolution mismatch', 'source larger', 'source smaller',
  'translated', 'translation request', 'check translation',
]);

/* The safeguard's vocabulary, not the prompt's. `explicit` in a prompt asks
   for nothing; it is WD14 answering a different question. See src/safeguard.js. */
const RATING_TAGS = new Set(['general', 'sensitive', 'questionable', 'explicit']);

/** One tag, as the prompt box spells tags. */
const cleanTag = (raw) => String(raw || '')
  .trim()
  .replace(/_/g, ' ')
  // A weight the tagger never writes, but a frame list may have been edited.
  .replace(/^\((.*):[\d.]+\)$/, '$1')
  .trim()
  .toLowerCase();

/**
 * The tags in what the tagger returned.
 *
 * `frames` is the shape the tagging routes answer in — a list of comma-joined
 * strings, one per frame, of which a still has exactly one. Taking all of them
 * and de-duplicating means this reads a video's tags correctly too, without
 * knowing it has one.
 */
export const tagsFromFrames = (frames) => {
  const seen = new Set();
  const out = [];
  for (const frame of frames || []) {
    for (const piece of String(frame || '').split(',')) {
      const tag = cleanTag(piece);
      if (!tag || seen.has(tag)) continue;
      if (RATING_TAGS.has(tag) || PROPERTY_TAGS.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
};

/** The tags in a prompt somebody has already written, for comparison. */
export const tagsIn = (prompt) => new Set(
  String(prompt || '')
    .split(/[,\n]/)
    .map(part => cleanTag(part.replace(/[()[\]]/g, '').replace(/:[\d.]+$/, '')))
    .filter(Boolean),
);

/**
 * The tags worth adding to what is there.
 *
 * A tag the prompt already has is not added again — which matters more than it
 * sounds, because the commonest use of this is on a picture made from a prompt
 * that is still in the box. Without it, `1girl, solo, long hair` becomes
 * `1girl, solo, long hair, 1girl, solo, long hair` and every one of those
 * doubles its weight.
 */
export const newTags = (tags, existing) => {
  const already = tagsIn(existing);
  return (tags || []).filter(tag => !already.has(tag));
};

/**
 * The model's reply, as the sentence to use.
 *
 * Returns '' when nothing usable came back, which the caller treats as "tags
 * only" rather than as a failure: the tags are the more valuable half, and a
 * vision model that is absent, slow or confused must not cost them.
 */
export const readDescription = (raw, { maxChars = 400 } = {}) => {
  let text = String(raw ?? '');

  // Reasoning, if the model emitted it inline rather than in its own field.
  text = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  // Markdown emphasis and headings, which no prompt wants.
  text = text.replace(/^#{1,6}\s+/gm, '').replace(/\*\*|__|\*|`/g, '');
  text = text.trim();

  const beforePreamble = text;
  text = text.replace(PREAMBLE, '').trim();
  // A reply that was only a preamble said nothing.
  if (!text && beforePreamble) return '';

  // A list, where sentences were asked for: the bullets become the sentence.
  text = text.replace(/^\s*[-*•]\s+/gm, '').replace(/^\s*\d+[.)]\s+/gm, '');
  // Surrounding quotes, when the model presented the answer rather than wrote it.
  const quoted = text.match(/^"([\s\S]+)"$/) || text.match(/^“([\s\S]+)”$/);
  if (quoted) text = quoted[1].trim();

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';

  /* Two sentences, because that is what was asked for and what Anima reads.
     A model that wrote six has written a caption, and the last four are
     usually restatement. */
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  let kept = sentences.slice(0, 2).join('').trim();

  if (kept.length > maxChars) {
    /* Cut at a sentence if there is one to cut at, rather than mid-word: a
       prompt ending in half a clause reads as a mistake to whoever opens the
       box next. */
    const cut = kept.slice(0, maxChars);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
    kept = (stop > maxChars * 0.5 ? cut.slice(0, stop) : cut).trim();
  }

  // A prompt is not a sentence and does not want the full stop.
  return kept.replace(/[.\s]+$/, '').trim();
};

/**
 * What the box says afterwards.
 *
 * Tags first and the sentence last, which is the order both Anima and the
 * SDXL-family models read best — and the order the rest of this app already
 * writes in.
 *
 * Appended by default, for the same reason a pasted booru link is: describing
 * a second reference should add to what is there, and somebody who did not
 * want that cannot un-destroy the prompt they had written. `replace` is asked
 * for rather than guessed at.
 */
export const composePrompt = (existing, { tags = [], sentence = '' } = {}, { replace = false } = {}) => {
  const base = replace ? '' : String(existing || '').trim().replace(/[,\s]+$/, '');
  const fresh = replace ? (tags || []) : newTags(tags, existing);

  return [base, fresh.join(', '), sentence]
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .join(', ');
};

/** Is this something the tagger can be pointed at? */
export const isDescribable = (file) => {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (type.startsWith('image/')) return !/svg|gif/.test(type);
  return /\.(png|jpe?g|webp|bmp)$/i.test(String(file.name || ''));
};

/** The image on a clipboard, if there is one. */
export const imageOnClipboard = (data) => {
  for (const item of data?.items || []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (isDescribable(file)) return file;
  }
  for (const file of data?.files || []) {
    if (isDescribable(file)) return file;
  }
  return null;
};
