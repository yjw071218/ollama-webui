/**
 * The title bar in the page's own colours.
 *
 * The bar was always dark (#211f1c), so with the page in its light theme the
 * window had a black strip across the top. The page's background is watched
 * (client-preload.cjs) and the bar -- the shell page and Windows' own
 * minimise/maximise/close buttons -- is painted to match.
 */
export const DEFAULT_BACKGROUND = '#211f1c';

const hex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : null);
const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = (parts) => '#' + parts.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, amount) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * amount));

export const luminance = (h) => { const [r, g, b] = rgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

/** `{ bg, fg, muted, line, hover, light }` for a page background, or the default's. */
export const chromeColors = (background) => {
  const bg = hex(background) || DEFAULT_BACKGROUND;
  const light = luminance(bg) > 0.6;
  const fg = light ? '#24211d' : '#ede8df';
  return { bg, fg, muted: mix(bg, fg, 0.6), line: mix(bg, fg, 0.14), hover: mix(bg, fg, 0.1), light };
};

export const validColor = hex;
