/**
 * Zooming and moving a picture with the wheel, a drag, or two fingers.
 *
 * ## Why this is not `transform: scale()` and a drag handler
 *
 * Because zooming is about a *point*. Turning the wheel over somebody's face
 * has to keep that face under the cursor -- scaling about the centre instead
 * sends whatever they were looking at off the edge, and they spend the next
 * second dragging it back. The same is true of a pinch about the midpoint of
 * two fingers. That is one line of arithmetic and it is the whole reason this
 * file exists separately: it is the line that is wrong in most implementations,
 * and it is invisible in a screenshot.
 *
 * ## The rules the offset obeys
 *
 * At fit (`scale === 1`) the offset is always zero, so a drag means the
 * gesture the viewer already had -- across to the next picture, down to close.
 * A zoomed picture is held so that it never shows a gap: the visible window is
 * always inside the picture, so there is no empty margin to drag into and
 * nothing to spring back from. That is `clampOffset`, and it is what makes
 * this feel like a photo viewer rather than a free-floating layer.
 *
 * Pure, because gesture arithmetic is exactly the kind of thing that is easier
 * to check with numbers than with a finger.
 */

/* Fit, and as far in as it is worth going. Eight is past the point where an
   upscaled picture has any more detail to show; further than that is looking
   at the interpolation. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

/** What a double press goes to, when it is not already in. */
export const STEP_SCALE = 2.5;

export const FIT = { scale: 1, x: 0, y: 0 };

export const clampScale = (scale) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale) || MIN_SCALE));

/** Is this view zoomed in far enough to be worth treating as zoomed? */
export const isZoomed = (view) => (view?.scale || 1) > 1.001;

/**
 * How far the picture may be moved before it would show a gap.
 *
 * A picture is centred in its box and scaled about that centre, so at scale
 * `s` it overhangs by `(s - 1) * size / 2` on each side. Moving further than
 * that pulls the far edge into view with nothing behind it.
 */
export const panLimit = (scale, size) => Math.max(0, ((Number(scale) || 1) - 1) * (Number(size) || 0)) / 2;

/** A view with its offset brought back inside what the box can show. */
export const clampOffset = (view, box) => {
  const scale = clampScale(view?.scale);
  if (scale <= MIN_SCALE) return { scale, x: 0, y: 0 };
  const maxX = panLimit(scale, box?.width);
  const maxY = panLimit(scale, box?.height);
  return {
    scale,
    x: Math.min(maxX, Math.max(-maxX, Number(view?.x) || 0)),
    y: Math.min(maxY, Math.max(-maxY, Number(view?.y) || 0)),
  };
};

/**
 * Zoom to `scale`, keeping whatever is under `point` where it is.
 *
 * `point` is in the box's own coordinates, measured from its centre -- so the
 * middle of the box is `{ x: 0, y: 0 }`. See `pointIn`.
 *
 * The arithmetic: a picture point sits on screen at `offset + scale * p`. To
 * leave the screen position alone while the scale changes, the offset has to
 * take up the difference, which falls out as
 *
 *     offset' = point - (point - offset) * (scale' / scale)
 */
export const zoomAt = (view, scale, point, box) => {
  const from = clampScale(view?.scale);
  const to = clampScale(scale);
  const ratio = to / from;
  const px = Number(point?.x) || 0;
  const py = Number(point?.y) || 0;
  return clampOffset({
    scale: to,
    x: px - (px - (Number(view?.x) || 0)) * ratio,
    y: py - (py - (Number(view?.y) || 0)) * ratio,
  }, box);
};

/** A page coordinate as an offset from the centre of a box. */
export const pointIn = (box, clientX, clientY) => ({
  x: clientX - ((box?.left || 0) + (box?.width || 0) / 2),
  y: clientY - ((box?.top || 0) + (box?.height || 0) / 2),
});

/**
 * What one notch of the wheel does.
 *
 * Exponential rather than additive: every notch is the same *proportional*
 * step, so going in and back out again lands exactly where it started, and a
 * notch feels the same at 1× as at 6×. An additive step is coarse at the
 * bottom and imperceptible at the top.
 *
 * The deltas browsers report are not comparable -- a line is not a pixel and a
 * page is neither -- so they are normalised before they are used.
 */
export const wheelScale = (view, deltaY, mode = 0) => {
  const lines = mode === 1 ? 16 : mode === 2 ? 400 : 1;
  const steps = (Number(deltaY) || 0) * lines / 100;
  return clampScale((view?.scale || 1) * Math.exp(-steps * 0.55));
};

/** The distance between two touches, and the point between them. */
export const pinchOf = (a, b) => {
  const dx = b.clientX - a.clientX;
  const dy = b.clientY - a.clientY;
  return {
    distance: Math.hypot(dx, dy),
    mid: { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 },
  };
};

/** Fit, or one step in about this point -- what a double press toggles between. */
export const toggleZoom = (view, point, box) => (
  isZoomed(view) ? { ...FIT } : zoomAt(view, STEP_SCALE, point, box)
);

/**
 * Whether a one-finger drag belongs to the picture or to the viewer around it.
 *
 * Zoomed in, a drag moves the picture -- there is somewhere to move it to.
 * At fit there is not, so the drag is the viewer's own gesture: across for the
 * next picture, down to close. Handing both to the same handler and guessing
 * by direction is how a photo viewer ends up closing itself while somebody is
 * looking at the bottom of a picture.
 */
export const dragOwner = (view) => (isZoomed(view) ? 'picture' : 'viewer');

/** The CSS for a view. Translate first, then scale, about the centre. */
export const transformOf = (view) => {
  const scale = clampScale(view?.scale);
  const x = Math.round((Number(view?.x) || 0) * 1000) / 1000;
  const y = Math.round((Number(view?.y) || 0) * 1000) / 1000;
  return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
};
