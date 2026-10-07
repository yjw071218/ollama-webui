/**
 * Working on a long answer instead of regenerating it.
 *
 * The artifact panel handles code: it previews it, runs it, and lets you edit
 * it. Everything that is *not* code — a translation, a report, a covering
 * letter, a chapter — has exactly one editing operation available, which is to
 * ask again and hope. On a local model that costs four minutes and rewrites
 * the nine paragraphs that were fine in order to fix the one that was not, and
 * the nine come back subtly different, so the fix has to be checked against
 * work that was already finished.
 *
 * That is the whole problem. This module is the part of the answer to it that
 * can be tested without a browser.
 *
 * ## A block, not a selection
 *
 * The obvious design is "select any text and rewrite it". It is wrong, and the
 * reason is the seam. A selection that starts mid-sentence gives the model
 * half a clause to rewrite; whatever comes back is grammatical on its own and
 * meets the untouched half at an angle — `The report, which` + `it was
 * submitted on Friday.` Nobody reads their way out of that, and every instance
 * of it is a small loss of trust in the feature.
 *
 * So a selection *snaps* to the blocks it touches: paragraphs, headings, list
 * items, a fenced code block entire. Those are the units a document is made
 * of, they begin and end where a reader thinks they do, and replacing one
 * whole leaves no seam to get wrong. Selecting three words of a paragraph
 * rewrites that paragraph, which is what was meant anyway.
 *
 * ## The whole document goes, one block comes back
 *
 * Both halves matter. Sending only the block produces a rewrite in a different
 * register from the rest of the piece, using terms the document defined
 * earlier and a name it already introduced. Asking for the whole document back
 * costs a full regeneration for a one-paragraph change, and — worse — lets the
 * model quietly revise paragraphs nobody asked about, which is the failure
 * this feature exists to remove.
 *
 * So the document is context and the block is the task, marked in place so
 * there is no ambiguity about which paragraph "this one" is.
 *
 * ## What comes back is not what is inserted
 *
 * A model asked for one paragraph returns one paragraph roughly half the time.
 * The rest of the time it returns "Sure! Here's the revised paragraph:" and
 * then the paragraph, or wraps it in a fence, or repeats the marker it was
 * shown, or quotes it. Inserting that verbatim puts "Sure!" into the middle of
 * somebody's report.
 *
 * `cleanRewrite` strips those, and every rule in it is there because models
 * produce that shape constantly. It is deliberately conservative: a fence is
 * unwrapped only when it encloses the entire reply, because a code sample
 * legitimately inside a rewritten paragraph must survive.
 */

/**
 * The document, cut into replaceable units.
 *
 * Offsets rather than just text, because the splice has to put the replacement
 * back exactly where the original was — a block located by searching for its
 * text replaces the wrong one whenever a document repeats itself, and a
 * document with "## Summary" twice is not unusual.
 *
 * A fenced code block is one unit however many blank lines are inside it. This
 * is the only rule here that needs state, and without it a snippet with a gap
 * in the middle becomes two blocks, the second of which begins with a closing
 * fence.
 */
export const splitBlocks = (text) => {
  const source = String(text ?? '');
  const blocks = [];

  let at = 0;              // where the current block starts
  let cursor = 0;          // where we are in the source
  let fence = null;        // the fence marker we are inside, if any
  let sawContent = false;

  const push = (end) => {
    const raw = source.slice(at, end);
    if (raw.trim()) blocks.push({ start: at, end, text: raw });
    at = end;
  };

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = cursor;
    cursor += line.length + (i < lines.length - 1 ? 1 : 0);

    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      // Closed by a marker of the same kind, at least as long as the opener.
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      // A fence starting after other content begins a block of its own.
      if (sawContent) push(lineStart);
      fence = fenceMatch[1];
      sawContent = true;
      continue;
    }

    if (line.trim() === '') {
      if (sawContent) { push(cursor); sawContent = false; }
      else at = cursor;               // swallow leading blank lines
      continue;
    }

    /* A heading, and a list item, each stand alone. A five-item list is five
       things somebody might want to rewrite one of, and treating the list as
       one block means rewriting all five to fix the third. */
    const standalone = /^[ \t]{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/.test(line);
    if (standalone && sawContent) push(lineStart);

    sawContent = true;
  }

  if (sawContent) push(source.length);
  return blocks;
};

/**
 * The blocks a selection touches.
 *
 * Any overlap counts, including a zero-width caret sitting inside a block: a
 * click with no drag is somebody pointing at a paragraph, and refusing it
 * because nothing was selected would be technically right and useless.
 */
export const blocksInRange = (blocks, from, to) => {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return blocks.filter(block => (
    lo === hi
      ? lo >= block.start && lo <= block.end
      : block.start < hi && block.end > lo
  ));
};

/** One span covering every block a selection touched, snapped to their edges. */
export const snapToBlocks = (blocks, from, to) => {
  const touched = blocksInRange(blocks, from, to);
  if (touched.length === 0) return null;
  return {
    start: touched[0].start,
    end: touched[touched.length - 1].end,
    text: touched.map(block => block.text).join(''),
    count: touched.length,
  };
};

/* The marker the block is wrapped in. Chosen to be something no prose contains
   and no Markdown means: a model shown `>>> this one <<<` sometimes decides
   the angle brackets are part of the text and keeps them. */
const MARK_OPEN = '[[SELECTED]]';
const MARK_CLOSE = '[[/SELECTED]]';

/**
 * What to send, for a rewrite of one span.
 *
 * The document is included with the span marked in place, because "the third
 * paragraph" is a phrase a model miscounts and a marker is not. Above a
 * certain length the document is trimmed to the span's neighbourhood: a
 * fifteen-thousand-word chapter in the prompt is minutes of prefill on a local
 * model, and the context a rewrite actually uses is the pages around it.
 */
export const buildRewritePrompt = (document, span, instruction, {
  windowChars = 6000,
  language = null,
} = {}) => {
  const source = String(document ?? '');
  const before = source.slice(0, span.start);
  const after = source.slice(span.end);

  const room = Math.max(0, windowChars - span.text.length);
  const head = before.length > room / 2 ? `…\n${before.slice(-Math.floor(room / 2))}` : before;
  const tail = after.length > room / 2 ? `${after.slice(0, Math.floor(room / 2))}\n…` : after;

  const marked = `${head}${MARK_OPEN}${span.text}${MARK_CLOSE}${tail}`;

  const rules = [
    'You are editing one part of a document someone else is writing.',
    '',
    `The document is below. The part to change is between ${MARK_OPEN} and ${MARK_CLOSE}.`,
    '',
    'Rules:',
    `1. Return ONLY the replacement for the marked part. No preamble, no explanation, no "Here is".`,
    `2. Do not include the ${MARK_OPEN} or ${MARK_CLOSE} markers.`,
    '3. Do not touch, repeat or comment on any other part of the document.',
    '4. Keep the same kind of thing: a paragraph stays a paragraph, a heading stays a heading, a list item keeps its bullet.',
    '5. Match the surrounding voice, tense and terminology.',
    language ? `6. Write in ${language}.` : null,
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: rules },
    {
      role: 'user',
      content: `DOCUMENT:\n${marked}\n\nWHAT TO DO WITH THE MARKED PART:\n${instruction}`,
    },
  ];
};

/* The openings models use before getting to the point. Matched at the start of
   the reply only, and only when a colon or a newline ends them, so a paragraph
   that legitimately begins "Here is the thing about Rome" survives. */
const PREAMBLE = /^\s*(?:(?:sure|certainly|of course|okay|ok|alright)[,!.]?\s*)?(?:here(?:'s| is| are)|below is|this is)\b[^\n:]{0,60}[:\n]/i;

/**
 * The reply, with everything that is not the replacement taken off.
 *
 * `original` is what was there before, used for one judgement only: if the
 * cleaning leaves nothing, the original is returned rather than an empty
 * block. A rewrite that silently deletes a paragraph is worse than one that
 * does nothing, because the second is visible.
 */
export const cleanRewrite = (raw, original = '') => {
  let text = String(raw ?? '');

  // Reasoning, if the model emitted it inline.
  text = text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');

  // The markers, whether or not it was told to leave them out.
  text = text.split(MARK_OPEN).join('').split(MARK_CLOSE).join('');

  text = text.trim();

  const beforePreamble = text;
  text = text.replace(PREAMBLE, '').trim();
  // A reply that was *only* a preamble is a refusal, not a replacement.
  if (!text && beforePreamble) return String(original);

  /* A fence around the whole reply is the model presenting the paragraph
     rather than writing it. One that starts partway through is a code sample
     inside the rewrite and has to stay, which is why this is anchored. */
  const wrapped = text.match(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/);
  if (wrapped) text = wrapped[2].trim();

  /* Quotes around the whole thing, for the same reason. Only when both ends
     have them and the inside has none, so dialogue survives. */
  const quoted = text.match(/^"([^"]+)"$/) || text.match(/^“([^”]+)”$/);
  if (quoted) text = quoted[1].trim();

  return text || String(original);
};

/**
 * The document with one span replaced.
 *
 * The surrounding whitespace is the original's, not the model's: a reply
 * arrives trimmed, and pasting it in where a paragraph used to sit — complete
 * with the blank line that separated it from the next one — is what keeps the
 * document's shape. Getting this wrong glues two paragraphs together, which
 * looks like the model failing rather than the splice.
 */
export const spliceSpan = (document, span, replacement) => {
  const source = String(document ?? '');
  const original = source.slice(span.start, span.end);
  const leading = original.match(/^\s*/)[0];
  const trailing = original.match(/\s*$/)[0];
  return source.slice(0, span.start) + leading + String(replacement).trim() + trailing + source.slice(span.end);
};

/** A span's first words, for a label. */
export const spanLabel = (text, limit = 60) => {
  const line = String(text ?? '').trim().replace(/\s+/g, ' ');
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

/**
 * Is this answer worth opening as a document?
 *
 * The button should not be on every "yes". The test is prose length rather
 * than total length, because a reply that is four hundred words of code with a
 * sentence around it is the artifact panel's job, and offering both for the
 * same message is two buttons that do different things with the same name.
 */
/* Asked of every answer in the chat on every render, and the answers do not
   change: remembered by text (see estimateTokens in App.jsx for the measurement). */
const documentCache = new Map();
export const looksLikeDocument = (text, { minWords = 120 } = {}) => {
  const source = String(text ?? '');
  const key = minWords === 120 ? source : null;
  if (key !== null && documentCache.has(key)) return documentCache.get(key);
  const prose = source
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[\s\S]*?^[ \t]{0,3}\1[^\n]*$/gm, '');
  const answer = prose.trim().split(/\s+/).filter(Boolean).length >= minWords;
  if (key !== null) {
    if (documentCache.size > 2000) documentCache.clear();
    documentCache.set(key, answer);
  }
  return answer;
};
