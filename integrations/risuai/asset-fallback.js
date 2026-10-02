// A card asking for an expression it does not ship -- `{{raw::Mizuho_Normal_Casual_indifferent.webp}}`
// in a card whose assets are `mizuho_normal_casual_default.webp` and friends --
// gets the default of the nearest set it does ship rather than a broken image.
// RisuAI's own fuzzy match compares whole names, and "indifferent" is too far
// from "default" for it: 25 of the 30 portraits in one card's contact list
// showed only their alt text.
//
// Segments are dropped from the end one at a time (expression, then outfit,
// then state), and at each step `<rest>_default` is looked for, then anything
// starting with `<rest>_`. The character's own name -- the first segment -- is
// never dropped, so a missing picture is never replaced by someone else's.
export function defaultVariant(assetPaths, name) {
  if (!assetPaths || !name) return null;
  const lower = String(name).toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 && lower.length - dot <= 5 ? lower.slice(dot) : '';
  const parts = (ext ? lower.slice(0, dot) : lower).split('_');
  if (parts.length < 2) return null;
  const keys = Object.keys(assetPaths);
  const stem = key => key.replace(/\.[a-z0-9]{1,4}$/, '');
  for (let keep = parts.length - 1; keep >= 1; keep--) {
    const base = parts.slice(0, keep).join('_');
    const exact = [`${base}_default${ext}`, `${base}_default`].find(key => assetPaths[key])
      || keys.find(key => stem(key) === `${base}_default`);
    if (exact) return assetPaths[exact];
    const near = keys.filter(key => key.startsWith(`${base}_`));
    const pick = near.find(key => stem(key).endsWith('_default')) || near[0];
    if (pick) return assetPaths[pick];
  }
  return null;
}
