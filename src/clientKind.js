/**
 * Which client this page is running in, for what each one keeps on its own.
 *
 * The Windows app (native/desktop/client-preload.cjs) and the Android app
 * (native/android/.../native.js) both put `window.ollamaNative` on the page
 * before it loads, with a `platform`. Anything else is a browser.
 */
export const clientKind = (win = typeof window === 'undefined' ? undefined : window) => {
  const platform = win?.ollamaNative?.platform;
  return platform === 'desktop' || platform === 'android' ? platform : 'browser';
};

/** A layout setting's storage key, kept apart per client: `artifactWidth@desktop`. */
export const panelKey = (name, win) => `${name}@${clientKind(win)}`;

/**
 * The width saved before widths were kept per client (the bare key), so an
 * existing layout is not lost on the first launch of this version.
 */
export const legacyWidth = (name, fallback, storage = typeof localStorage === 'undefined' ? undefined : localStorage) => {
  try {
    const raw = storage?.getItem(name);
    const value = raw === null || raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch { return fallback; }
};
