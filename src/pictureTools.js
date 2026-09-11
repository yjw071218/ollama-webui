/**
 * The browser's half of doing things to a picture: measuring it, and building
 * the padded canvas and mask that extending one needs.
 *
 * Extending is done here rather than in ComfyUI because the result has to be
 * *exactly* the old picture with more around it, and the one place that can
 * guarantee that is the one holding the original bytes. The canvas is built
 * with the old picture pasted in untouched, the margin filled with a blurred
 * stretch of its own edges (a better starting point for the sampler than grey),
 * and a mask that is white over the new margin and a short band into the old
 * picture -- so the seam is redrawn to meet the new part rather than left as a
 * hard line. The server then redraws only under that mask and lays the result
 * back over this canvas.
 *
 * The arithmetic is pure and exported for tests; the canvas work needs a
 * browser.
 */

/** Which edges an extension grows, as fractions of the picture's own size. */
export const extensionMargins = (direction = 'horizontal', amount = 0.5) => {
  const a = Math.min(Math.max(Number(amount) || 0.5, 0.1), 1);
  const m = { left: 0, right: 0, top: 0, bottom: 0 };
  switch (direction) {
    case 'left': m.left = a; break;
    case 'right': m.right = a; break;
    case 'up': m.top = a; break;
    case 'down': m.bottom = a; break;
    case 'vertical': m.top = a / 2; m.bottom = a / 2; break;
    case 'all': m.left = a / 2; m.right = a / 2; m.top = a / 2; m.bottom = a / 2; break;
    default: m.left = a / 2; m.right = a / 2;  // horizontal
  }
  return m;
};

/* Past this, the canvas is not a picture a chat can hold, and the sampler is
   being asked to invent more than it keeps. */
const MAX_SIDE = 8192;

/** The padded canvas's size, in pixels, and where the original sits in it. */
export const extensionLayout = ({ width, height }, margins) => {
  let left = Math.round(width * margins.left);
  let right = Math.round(width * margins.right);
  let top = Math.round(height * margins.top);
  let bottom = Math.round(height * margins.bottom);
  let total = { width: width + left + right, height: height + top + bottom };
  const shrink = Math.min(1, MAX_SIDE / total.width, MAX_SIDE / total.height);
  if (shrink < 1) {
    // Keep the original whole and give up margin instead.
    const spare = (limit, size) => Math.max(0, Math.floor(limit) - size);
    const w = spare(MAX_SIDE, width) / Math.max(1, left + right);
    const h = spare(MAX_SIDE, height) / Math.max(1, top + bottom);
    left = Math.floor(left * Math.min(1, w)); right = Math.floor(right * Math.min(1, w));
    top = Math.floor(top * Math.min(1, h)); bottom = Math.floor(bottom * Math.min(1, h));
    total = { width: width + left + right, height: height + top + bottom };
  }
  return { ...total, x: left, y: top, margins: { left, right, top, bottom } };
};

/**
 * The size to sample a picture of this shape at: the workflow's own area, in
 * this aspect ratio, in multiples of 16 -- which is what every latent here
 * divides by.
 */
export const samplingSize = ({ width, height }, area = 1024 * 1024) => {
  const aspect = width / Math.max(1, height);
  const h = Math.sqrt(area / aspect);
  const round = (n) => Math.max(256, Math.round(n / 16) * 16);
  return { width: round(h * aspect), height: round(h) };
};

/* ------------------------------------------------------------- the shape

   "16:9로", "세로로", "정사각형" -- a request for a shape, as a ratio. The
   model is asked for `aspect` as a ratio string, and a word that means one is
   accepted too, because that is what gets written. */

const NAMED_ASPECTS = [
  [/^(?:square|정사각형?|정방형|1:1)$/i, { w: 1, h: 1 }],
  [/^(?:landscape|horizontal|wide|widescreen|가로(?:형|로)?|와이드)$/i, { w: 16, h: 9 }],
  [/^(?:portrait|vertical|tall|세로(?:형|로)?|쇼츠|릴스)$/i, { w: 9, h: 16 }],
  [/^(?:cinema(?:tic|scope)?|시네마(?:스코프)?)$/i, { w: 21, h: 9 }],
];

/** A ratio `{ w, h }` from "16:9", "9x16", "1.5" or a word; null for anything else. */
export const parseAspect = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  for (const [pattern, ratio] of NAMED_ASPECTS) if (pattern.test(text)) return ratio;
  const pair = /^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (pair) {
    const w = Number(pair[1]);
    const h = Number(pair[2]);
    if (w > 0 && h > 0) return { w, h };
  }
  const single = Number(text);
  if (Number.isFinite(single) && single > 0) return { w: single, h: 1 };
  return null;
};

/* Past about 3:1 the models draw a strip of repeated scenery, not a picture. */
const MAX_STRETCH = 3;

/** A size for a ratio at a workflow's usual area, on the latent grid. */
export const sizeForAspect = (ratio, area, step = 16) => {
  if (!ratio) return null;
  const r = Math.min(Math.max(ratio.w / ratio.h, 1 / MAX_STRETCH), MAX_STRETCH);
  const h = Math.sqrt(area / r);
  const round = (n) => Math.max(256, Math.round(n / step) * step);
  return { width: round(h * r), height: round(h) };
};

/* What a base64 image is, from its first bytes -- the chat keeps an attached
   picture as bare base64, the way Ollama wants it, with no type beside it. */
const MAGIC = [['iVBORw0KGgo', 'image/png'], ['/9j/', 'image/jpeg'], ['R0lGOD', 'image/gif'], ['UklGR', 'image/webp']];
export const sniffImageMime = (base64) => {
  const head = String(base64 || '').slice(0, 16);
  return (MAGIC.find(([prefix]) => head.startsWith(prefix)) || [null, 'image/png'])[1];
};

/** A picture as a data URL, whether it was kept as one or as bare base64. */
export const asImageDataUrl = (image) => {
  const text = String(image || '');
  return text.startsWith('data:') ? text : `data:${sniffImageMime(text)};base64,${text}`;
};

/* -------------------------------------------------------------- the browser */

export const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('the picture could not be read'));
  img.src = src;
});

export const pictureSize = async (src) => {
  const img = await loadImage(src);
  return { width: img.naturalWidth, height: img.naturalHeight };
};

export const canvasBlob = (canvas, type = 'image/png') => new Promise((resolve, reject) => {
  canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('the canvas could not be encoded'))), type);
});

export const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

/**
 * The padded picture and its mask, as PNG blobs, for `extend_image`.
 */
export const padForExtension = async (src, { direction, amount } = {}) => {
  const img = await loadImage(src);
  const size = { width: img.naturalWidth, height: img.naturalHeight };
  const layout = extensionLayout(size, extensionMargins(direction, amount));

  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  // The margin: the picture itself, stretched over everything and blurred to
  // colour, so the sampler starts from the right palette.
  ctx.filter = `blur(${Math.round(Math.max(layout.width, layout.height) / 40)}px)`;
  ctx.drawImage(img, 0, 0, layout.width, layout.height);
  ctx.filter = 'none';
  ctx.drawImage(img, layout.x, layout.y);

  /* The mask: white over the margin and a band into the picture, softened.
     The band is what lets the new part meet the old one; without it the edge
     of the original is a straight line through the finished picture. At 4%
     that line was still visible in a test run -- the old edge's pillars stood
     beside new flower beds -- so the band takes a little more of the edge. */
  const band = Math.round(Math.min(size.width, size.height) * 0.06);
  const mask = document.createElement('canvas');
  mask.width = layout.width;
  mask.height = layout.height;
  const m = mask.getContext('2d');
  m.fillStyle = '#fff';
  m.fillRect(0, 0, layout.width, layout.height);
  m.fillStyle = '#000';
  const keep = {
    x: layout.x + (layout.margins.left ? band : 0),
    y: layout.y + (layout.margins.top ? band : 0),
    right: layout.x + size.width - (layout.margins.right ? band : 0),
    bottom: layout.y + size.height - (layout.margins.bottom ? band : 0),
  };
  m.fillRect(keep.x, keep.y, keep.right - keep.x, keep.bottom - keep.y);
  const softened = document.createElement('canvas');
  softened.width = layout.width;
  softened.height = layout.height;
  const s = softened.getContext('2d');
  s.filter = `blur(${Math.max(2, Math.round(band / 3))}px)`;
  s.drawImage(mask, 0, 0);

  return {
    padded: await canvasBlob(canvas),
    mask: await canvasBlob(softened),
    width: layout.width,
    height: layout.height,
  };
};
