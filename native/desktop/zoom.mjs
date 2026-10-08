/**
 * The page's zoom, in the steps a browser uses, kept per server (main.mjs).
 * It used to reset on every launch, and the menu's zoom acted on the title
 * bar rather than the page.
 */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const clampZoom = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(ZOOM_STEPS.at(-1), Math.max(ZOOM_STEPS[0], n)) : 1;
};

/** The next step up (+1) or down (-1) from `current`. */
export const zoomStep = (current, direction) => {
  const at = clampZoom(current);
  if (direction > 0) return ZOOM_STEPS.find(s => s > at + 0.001) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find(s => s < at - 0.001) ?? ZOOM_STEPS[0];
};
