// A local model hits its num_predict budget mid-sentence far more often than a
// hosted one does, and the reply just stops. Ollama says so in the final frame,
// which is enough to offer — or take — the obvious next step.
//
// There are two ways to ask for the rest, and which one works depends on the
// model's chat template:
//
//   prefill  — send the unfinished answer as the last message and let the model
//              carry on the same token stream. Seamless where it works
//              (qwen3.8), because the next token brings its own leading space.
//   instruct — ask for the continuation in a new turn. Works everywhere, but
//              the answer starts a fresh sentence, so the seam needs a space.
//
// Templates that close the assistant turn (gemma4) ignore a prefill and restart
// the answer instead, so the result is checked and the other path used.

export const wasTruncated = (frame) =>
  !!frame && frame.done === true && frame.done_reason === 'length';

export const CONTINUE_PROMPT = [
  'Your previous message was cut off because it hit the token limit.',
  'Continue it from exactly where it stopped.',
  'Do not repeat anything you already wrote, do not summarise it, and do not',
  'start over — carry straight on from the last word.',
].join(' ');

// How far back to look for a repeat. Long enough to catch a restated sentence,
// short enough that scanning it costs nothing.
const OVERLAP_WINDOW = 400;
const MIN_OVERLAP = 12;

// Told not to repeat, models repeat anyway. Drop the longest tail of what we
// already have that the continuation opens with.
export const trimOverlap = (previous, next) => {
  if (!previous || !next) return next || '';
  const tail = previous.slice(-OVERLAP_WINDOW);
  const limit = Math.min(tail.length, next.length);
  for (let size = limit; size >= MIN_OVERLAP; size--) {
    if (next.startsWith(tail.slice(tail.length - size))) return next.slice(size);
  }
  return next;
};

const words = (text, count) =>
  String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(Boolean).slice(0, count);

// A template that closes the assistant turn answers a prefill by writing the
// whole reply again. Its opening then reads like the opening we already have.
export const looksRestarted = (previous, next) => {
  const opening = words(previous, 12);
  const candidate = words(next, 12);
  if (opening.length < 4 || candidate.length < 4) return false;
  const shared = candidate.filter(w => opening.includes(w)).length;
  return shared / Math.min(opening.length, candidate.length) >= 0.6;
};

// The model carried on the same token stream, so its own spacing is right and
// nothing should be inserted between the halves.
export const joinPrefill = (previous, next) => {
  const addition = trimOverlap(previous, next);
  if (!previous) return addition.replace(/^\s+/, '');
  if (!addition.trim()) return previous;
  return previous + addition;
};

// The continuation is a fresh generation, so it begins a word rather than
// finishing one. Bare boundaries get a space; whitespace ones are normalised so
// the two sides do not stack into extra blank lines.
export const joinInstructed = (previous, next) => {
  const addition = trimOverlap(previous, next);
  if (!previous) return addition.replace(/^\s+/, '');
  if (!addition.trim()) return previous;

  const head = previous.replace(/\s+$/, '');
  const body = addition.replace(/^\s+/, '');
  const seam = previous.slice(head.length) + addition.slice(0, addition.length - body.length);

  if (!seam) return head + ' ' + body;

  const newlines = (seam.match(/\n/g) || []).length;
  return head + (newlines >= 2 ? '\n\n' : newlines === 1 ? '\n' : ' ') + body;
};

export const joinContinuation = (previous, next, mode = 'instruct') =>
  (mode === 'prefill' ? joinPrefill : joinInstructed)(previous, next);
