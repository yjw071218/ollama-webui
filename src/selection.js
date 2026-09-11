/**
 * Turning a selected passage into a question.
 *
 * The commonest follow-up to a long answer is about one part of it, and until
 * now the only way to ask was to describe that part in words and hope the
 * model worked out which one — or select it, copy it, scroll down, paste it,
 * and type `>` in front of every line.
 *
 * The rules below are the ones that decide whether the result reads as a
 * question about a passage or as a mess, so they live here where they can be
 * asserted rather than inline in a 9000-line component.
 */

/** Longer than this and the passage is the conversation, not a quote in it. */
export const SELECTION_LIMIT = 2000;

/** Shorter than this and it is a stray tap, not a passage someone chose. */
export const SELECTION_MIN = 3;

/** What the four buttons ask for. Order is the order they appear in. */
export const SELECTION_ACTIONS = ['explain', 'expand', 'simplify', 'translate'];

/**
 * Markdown-quote a passage, truncating a very long one.
 *
 * Every line needs its own `>`: a blockquote that only marks the first line
 * ends at the first blank line, so half of a long passage would arrive as the
 * question rather than as the thing being asked about.
 */
export const quotePassage = (text, limit = SELECTION_LIMIT) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const body = trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed;
  return body
    // Windows line endings would leave a stray CR inside each quoted line.
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
};

/**
 * The whole message: passage first, instruction after.
 *
 * That order is what survives a long selection. An instruction buried above
 * eight hundred words is one the model has to remember; one directly after
 * them is one it has just read.
 */
export const buildSelectionPrompt = (text, instruction, limit = SELECTION_LIMIT) => {
  const quoted = quotePassage(text, limit);
  if (!quoted) return '';
  return `${quoted}\n\n${instruction}`;
};

/**
 * Is this selection one we should offer to act on?
 *
 * Only inside an answer. A drag across the composer, the chat list or a code
 * block is not a passage to ask about, and a bar appearing over the sidebar
 * would be nonsense. `closest` is given the element for a text node, since a
 * selection anchor is usually a text node and text nodes have no `closest`.
 */
export const selectionTarget = (selection) => {
  const text = (selection?.toString() || '').trim();
  if (text.length < SELECTION_MIN) return null;
  const anchor = selection.anchorNode;
  if (!anchor) return null;
  const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (!el?.closest) return null;
  return el.closest('.message-row.assistant .markdown-body') ? text : null;
};
