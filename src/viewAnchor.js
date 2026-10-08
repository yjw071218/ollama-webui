/**
 * Where the reader is, kept by what they are looking at rather than by a
 * scroll offset.
 *
 * Opening the code panel narrows the conversation, every paragraph re-wraps
 * taller, and the same `scrollTop` then shows something further up. So the
 * block at the top of the view is noted, with its distance from the top, and
 * put back at that distance after the width changes (App.jsx,
 * `keepViewAnchor`). Plain DOM, so it is tested in a browser on its own
 * (scripts/viewanchor.browser.test.mjs).
 */

/** What counts as a place in the conversation: a block of an answer, or a whole message. */
export const ANCHOR_BLOCKS = 'p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, table, figure, .message-row';

/**
 * The block at the top of `area`'s view: `{ el, offset }`, or null.
 * Looked for a little way in, past whatever (a header) lies over the top edge.
 */
export const noteAnchor = (area, doc = area?.ownerDocument) => {
  if (!area || !area.clientWidth || !doc) return null;
  const box = area.getBoundingClientRect();
  const x = box.left + box.width / 2;
  for (const dy of [16, 48, 96, 160, 240]) {
    if (dy >= box.height) break;
    const hit = doc.elementFromPoint(x, box.top + dy);
    if (!hit || hit === area || !area.contains(hit)) continue;
    const block = hit.closest(ANCHOR_BLOCKS);
    if (!block || !area.contains(block)) continue;
    return { el: block, offset: block.getBoundingClientRect().top - box.top };
  }
  return null;
};

/**
 * Scroll `area` so the anchor is back where it was noted. Returns how far it
 * moved (0 when it had not, or the anchor is gone).
 */
export const restoreAnchor = (area, anchor) => {
  if (!area || !anchor?.el?.isConnected || !area.contains(anchor.el)) return 0;
  const moved = anchor.el.getBoundingClientRect().top - area.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(moved) < 1) return 0;
  const before = area.scrollTop;
  area.scrollTop = before + moved;
  return area.scrollTop - before;
};
