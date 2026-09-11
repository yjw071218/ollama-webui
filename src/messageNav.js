/**
 * Moving between messages without the scrollbar.
 *
 * A long conversation is a long page, and the only way through it was to drag
 * or to flick. Every reader of long text — a mail client, a feed, `less`, vim
 * — gives you a key that means "next thing", because scrolling by pixels to
 * find something that is measured in messages is the wrong unit.
 *
 * The rules are small and the corners are where it goes wrong, so they live
 * here rather than inside a key handler in a nine-thousand-line component.
 */

/** The keys that mean move, and which way. */
export const NAV_KEYS = {
  j: 1,
  k: -1,
  ArrowDown: 1,
  ArrowUp: -1,
};

/**
 * Should this key event move between messages?
 *
 * Not while typing. `j` is a letter before it is a command, and a shortcut
 * that eats it inside the composer, a search box or a renamed chat title would
 * make those unusable — which is the failure that gets single-key shortcuts
 * removed again.
 *
 * The arrows need a modifier for the same reason from the other side: they
 * already mean something everywhere, so they only mean this with Alt held.
 */
export const wantsNavigation = (event, { editing = false } = {}) => {
  if (!event || event.ctrlKey || event.metaKey) return false;
  if (editing) return false;

  const target = event.target;
  const tag = (target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
  if (target?.isContentEditable) return false;

  if (event.key === 'j' || event.key === 'k') return !event.altKey && !event.shiftKey;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return event.altKey;
  return false;
};

/**
 * Where the next step lands.
 *
 * `current` is null when nothing is focused yet, and the first press should
 * then land somewhere useful rather than at index 0: going down starts at the
 * top, going up starts at the *bottom*, because "up from nowhere" means the
 * most recent message and that is almost always the one being looked for.
 *
 * Stops at the ends instead of wrapping. Wrapping in a transcript means a
 * press at the last message silently jumps a hundred messages backwards, and
 * you have lost your place with no way to tell.
 */
export const nextIndex = (current, count, direction) => {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (current === null || current === undefined || !Number.isFinite(current)) {
    return direction > 0 ? 0 : count - 1;
  }
  const next = current + direction;
  if (next < 0) return 0;
  if (next >= count) return count - 1;
  return next;
};

/**
 * Only the messages worth stopping on.
 *
 * A tool result is a message in the list and not a thing anybody wants to step
 * through; nor is an empty placeholder that a reply has not arrived into yet.
 * Returns the indices in the original array, since that is what the DOM is
 * keyed by.
 */
export const navigableIndices = (messages) => {
  const out = [];
  (messages || []).forEach((message, index) => {
    if (!message) return;
    const content = typeof message.content === 'string' ? message.content : '';
    if (message.role !== 'user' && message.role !== 'assistant') return;
    if (String(content).trimStart().startsWith('<TOOL_RESULT>')) return;
    if (!content.trim() && !(message.images || []).length) return;
    out.push(index);
  });
  return out;
};

/**
 * The step, over the navigable subset.
 *
 * Takes and returns a *message* index, converting in and out, so the caller
 * never has to hold two kinds of index at once — which is where an off-by-one
 * would otherwise live.
 */
export const step = (messages, currentMessageIndex, direction) => {
  const usable = navigableIndices(messages);
  if (usable.length === 0) return null;

  const at = usable.indexOf(currentMessageIndex);
  // Focused on something not in the list — a tool result, or a message that
  // has since been deleted. Treat it as starting fresh rather than as an
  // error: the next press should still go somewhere sensible.
  if (at === -1) return usable[direction > 0 ? 0 : usable.length - 1];

  const nextAt = nextIndex(at, usable.length, direction);
  return nextAt === null ? null : usable[nextAt];
};
