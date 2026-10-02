// Read the host's resolved palette, including explicit theme, system theme,
// and accent preferences. A different origin is never inspected.
export function syncHostTheme() {
  const root = document.documentElement;
  try {
    const host = window.parent.document.documentElement;
    const palette = window.parent.getComputedStyle(host);
    const names = ['bg-main', 'bg-primary', 'surface', 'text-primary', 'text-secondary', 'border-color', 'hover-bg', 'btn-active', 'btn-active-text', 'input-bg', 'user-bubble', 'font-sans'];
    for (const name of names) {
      const value = palette.getPropertyValue('--' + name).trim();
      if (value) root.style.setProperty('--webui-' + name, value);
    }
    root.dataset.webui = 'true';
  } catch { /* Standalone or an unavailable parent uses the CSS defaults. */ }
}
export function watchHostTheme() {
  syncHostTheme();
  if (window.parent === window) return;
  const observer = new MutationObserver(syncHostTheme);
  observer.observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  const media = window.parent.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', syncHostTheme);
  window.addEventListener('pagehide', () => { observer.disconnect(); media.removeEventListener('change', syncHostTheme); }, { once: true });
}
