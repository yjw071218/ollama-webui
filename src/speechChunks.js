/**
 * Deciding when enough of an answer has arrived to start reading it out.
 *
 * The reply is spoken after it finishes. On a local 31B at four tokens a
 * second that is a minute or two of silence before anything happens, and in
 * hands-free mode — where the whole point is not looking at the screen — a
 * minute of silence is indistinguishable from the app having died.
 *
 * Speaking it as it arrives means cutting the stream into pieces that are safe
 * to say on their own, which is the entire difficulty. A piece that ends
 * mid-sentence sounds wrong no matter how good the voice is: the intonation
 * falls where a comma was, and the next piece starts as if it were a new
 * thought. So the cut goes at a sentence end, and nowhere else.
 */

/* Sentence ends, in the languages this app is translated into.
 *
 * Both the ASCII marks and their full-width counterparts, because a Korean or
 * Japanese answer uses `。` and `？` and a rule written only for `.` would
 * never fire once — the reply would arrive as one enormous "sentence" and this
 * would be back to speaking at the end. */
const SENTENCE_END = /[.!?。！？…]["'"'\)\]】」』]*\s/;

/** Below this a piece is too short to be worth a request of its own. */
export const MIN_PIECE = 60;

/** Above this, wait no longer: a sentence this long is not going to end soon. */
export const MAX_PIECE = 400;

/**
 * The next piece that is ready, and what is left over.
 *
 * Returns `{ piece, rest }`; `piece` is empty when nothing is ready yet, which
 * is the normal answer while a sentence is still being written.
 *
 * `final` says the stream has ended, so whatever remains is all there will
 * ever be and goes out as it is, sentence or not.
 */
export const takeSpeakable = (buffer, { final = false, min = MIN_PIECE, max = MAX_PIECE } = {}) => {
  const text = String(buffer ?? '');
  if (!text.trim()) return { piece: '', rest: '' };
  if (final) return { piece: text.trim(), rest: '' };

  // The last sentence end at or after the minimum. The *last*, not the first:
  // three short sentences are better said in one breath than in three
  // requests, and the pause between requests is audible.
  let cut = -1;
  const search = new RegExp(SENTENCE_END, 'g');
  let match;
  while ((match = search.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= min) cut = end;
    if (end >= max) break;
  }

  if (cut === -1) {
    // No sentence has ended. Wait — unless the buffer has grown past the
    // ceiling, in which case this is a wall of text with no punctuation and
    // waiting for a full stop means waiting for ever.
    if (text.length < max) return { piece: '', rest: text };
    const space = text.lastIndexOf(' ', max);
    cut = space > min ? space + 1 : max;
  }

  return { piece: text.slice(0, cut).trim(), rest: text.slice(cut) };
};

/**
 * Every piece of a finished answer, for reading one that is already complete.
 *
 * The same rule applied repeatedly, so a message read from the speaker button
 * is cut exactly the way a streamed one is — one implementation, so the two
 * cannot drift into sounding different.
 */
export const splitForSpeech = (text, options = {}) => {
  const out = [];
  let rest = String(text ?? '');
  // Bounded: a rule that failed to consume anything would otherwise spin here.
  for (let guard = 0; guard < 10000 && rest.trim(); guard++) {
    const { piece, rest: next } = takeSpeakable(rest, options);
    if (!piece) {
      const last = takeSpeakable(rest, { ...options, final: true });
      if (last.piece) out.push(last.piece);
      break;
    }
    out.push(piece);
    if (next === rest) break;
    rest = next;
  }
  return out;
};
