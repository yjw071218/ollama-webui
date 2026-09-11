/**
 * A comma-separated prompt, read as a list of tags.
 *
 * Autocomplete needs to know which tag the caret is inside, and "the text
 * between the last comma before the caret and the first comma after it" is the
 * whole rule. Pure, and separate from the component, because every off-by-one
 * in here is a suggestion list that completes the wrong word — visible only by
 * typing a comma in exactly the wrong place, which is not something a rendering
 * test finds.
 */

/**
 * The tag the caret is in.
 *
 * Returns where it starts and ends in the original string as well as its text,
 * because replacing it is the only thing the caller ever does with it.
 * Leading whitespace is left out of the span so that accepting a suggestion
 * does not eat the space after the previous comma.
 */
export const tokenAt = (text, caret) => {
  const value = String(text ?? '');
  const at = Math.max(0, Math.min(Number(caret) || 0, value.length));

  let start = value.lastIndexOf(',', at - 1) + 1;
  let end = value.indexOf(',', at);
  if (end === -1) end = value.length;

  // A newline separates tags as firmly as a comma does: people write prompts in
  // paragraphs and a completion that swallowed the line above would be a
  // completion nobody could undo.
  const lineStart = value.lastIndexOf('\n', at - 1) + 1;
  if (lineStart > start) start = lineStart;
  const lineEnd = value.indexOf('\n', at);
  if (lineEnd !== -1 && lineEnd < end) end = lineEnd;

  while (start < end && /\s/.test(value[start])) start += 1;

  return { start, end, text: value.slice(start, end) };
};

/**
 * The prompt with the caret's tag replaced by `tag`.
 *
 * Adds `, ` after it unless something already follows, so a run of accepted
 * suggestions comes out as a prompt rather than as words jammed together —
 * and returns the new caret position, because leaving it where it was would
 * put it in the middle of the word that was just completed.
 */
export const replaceToken = (text, caret, tag) => {
  const value = String(text ?? '');
  const { start, end } = tokenAt(value, caret);
  const after = value.slice(end);
  // `, ` only when there is nothing sensible there already. Typing into the
  // middle of a prompt should not push a comma into the middle of it too.
  const needsComma = !/^\s*,/.test(after) && after.trim() !== '';
  const insert = needsComma ? `${tag}, ` : (after.trim() === '' ? `${tag}, ` : tag);
  return { value: value.slice(0, start) + insert + after, caret: start + insert.length };
};

/**
 * Is this a booru post link rather than something to draw?
 *
 * Deliberately loose: the server decides whether a URL is really a post, and
 * this only has to answer "was that a paste of a link". Anything with more than
 * a URL in it is prose that happens to contain one, and pasting a paragraph
 * into the prompt box should paste a paragraph.
 */
export const looksLikeBooruLink = (text) => {
  const value = String(text ?? '').trim();
  if (/\s/.test(value)) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  return /donmai\.us|safebooru\.org|gelbooru\.com|yande\.re|konachan\.(com|net)/i.test(value);
};

/**
 * The four boxes, as the one string a workflow takes.
 *
 * Split for editing and joined for sending: quality tags at the front, the
 * subject in the middle, the modifiers that go last at the end. Artists are
 * folded in here only when the workflow has nowhere better to put them — Anima
 * has a dedicated artist encoder and gets them separately.
 *
 * The order is the point. These models read a prompt positionally: what comes
 * first weighs more, and "masterpiece, best quality" belongs in front of the
 * subject while "depth of field, film grain" belongs behind it.
 */
export const joinPrompt = ({ lead, artist, prompt, tail } = {}, { foldArtist = true } = {}) => {
  const parts = [lead, foldArtist ? artist : '', prompt, tail]
    .map(part => String(part ?? '').trim().replace(/^[,\s]+|[,\s]+$/g, ''))
    .filter(Boolean);
  return parts.join(', ');
};

/** Is there anything to generate from? */
export const hasPrompt = (form, options) => joinPrompt(form, options).length > 0;

/**
 * A tag's weight, one step up or down — Ctrl+↑ and Ctrl+↓, as in every other
 * front end these prompts are written in.
 *
 * `(tag:1.2)` is the syntax ComfyUI's text encoders read. The step is 0.1, and
 * a weight that comes back to 1 unwraps entirely, so nudging up and back down
 * leaves the prompt exactly as it was rather than littered with `(tag:1)`.
 *
 * Works on the selection when there is one, and on the tag under the caret
 * when there is not; the result keeps the tag selected, so the key can simply
 * be pressed again.
 */
const WEIGHTED = /^\(([\s\S]+):(-?\d+(?:\.\d+)?)\)$/;

export const nudgeWeight = (text, selStart, selEnd, delta = 0.1) => {
  const value = String(text ?? '');
  let start;
  let end;
  if (selEnd > selStart) {
    start = selStart;
    end = selEnd;
  } else {
    ({ start, end } = tokenAt(value, selStart));
  }
  while (start < end && /\s/.test(value[start])) start += 1;
  while (end > start && /\s/.test(value[end - 1])) end -= 1;
  if (end <= start) return null;

  let inner = value.slice(start, end);
  let weight = 1;
  let from = start;
  let to = end;
  const whole = WEIGHTED.exec(inner);
  if (whole) {
    [, inner] = whole;
    weight = Number(whole[2]);
  } else {
    // The selection is the tag *inside* `(tag:1.2)`.
    const after = /^:(-?\d+(?:\.\d+)?)\)/.exec(value.slice(end));
    if (value[start - 1] === '(' && after) {
      from = start - 1;
      to = end + after[0].length;
      weight = Number(after[1]);
    }
  }

  const next = Math.max(0, Math.round((weight + delta) * 100) / 100);
  const unwrapped = Math.abs(next - 1) < 1e-9;
  const replacement = unwrapped ? inner : `(${inner}:${Number(next.toFixed(2))})`;
  const out = value.slice(0, from) + replacement + value.slice(to);
  const innerStart = from + (unwrapped ? 0 : 1);
  return { value: out, selStart: innerStart, selEnd: innerStart + inner.length };
};

/**
 * The key handler for it, shared by every prompt box. Returns whether it
 * handled the key, so a box with its own shortcuts can stop there.
 */
export const onWeightKey = (event, apply) => {
  if (!(event.ctrlKey || event.metaKey) || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return false;
  const box = event.currentTarget;
  const out = nudgeWeight(box.value, box.selectionStart, box.selectionEnd, event.key === 'ArrowUp' ? 0.1 : -0.1);
  if (!out) return false;
  event.preventDefault();
  apply(out.value);
  restoreSelection(box, out.value, out.selStart, out.selEnd);
  return true;
};

/**
 * Put the selection back after the value has been replaced.
 *
 * A controlled textarea's caret goes to the end when React writes a new value
 * into it, and that write lands *after* the handler that caused it — so a
 * single restore, scheduled once, is either too early to survive the commit or
 * too early to find the new text. Left at the end, the second press of Ctrl+↑
 * weighed whichever tag the end happened to fall in rather than the one just
 * weighed.
 *
 * So it is tried a few times over about 130ms, and stops once the text is
 * there and the range has been set twice — idempotent and invisible. Timers
 * rather than `requestAnimationFrame`: measured in a headless browser under
 * this app, the frame callback did not run at all, and a caret that depends on
 * the page being painted is a caret that is wrong in exactly the cases hardest
 * to notice. It gives up as soon as the person moves the caret themselves.
 */
export const restoreSelection = (box, value, selStart, selEnd, frames = 8) => {
  let left = frames;
  let done = 0;
  const tick = () => {
    if (!box || !box.isConnected || document.activeElement !== box) return;
    if (box.value === value) {
      const moved = box.selectionStart !== selStart || box.selectionEnd !== selEnd;
      // Set once, then once more to beat a late commit -- but not over a
      // caret the person has since moved on purpose.
      if (moved && done > 1) return;
      if (moved) { try { box.setSelectionRange(selStart, selEnd); } catch (e) { return; } }
      done += 1;
      if (done > 1) return;
    }
    if (--left > 0) setTimeout(tick, 16);
  };
  setTimeout(tick, 0);
};
