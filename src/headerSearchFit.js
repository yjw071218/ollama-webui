/**
 * Whether the header has room for the open "대화 내 검색" field.
 *
 * The field is shown only when it can be at least SEARCH_MIN wide; below that
 * the header shows the magnifier button instead. Which one fits depends on
 * everything else on the row -- the meters, the model's name, a usage badge --
 * so it is measured, not guessed from the column width: the row's width, less
 * what every other visible item needs at its natural size.
 *
 * Sets `search-roomy` on `.main-header`; src/extras.css does the rest.
 */
export const SEARCH_MIN = 250;

const natural = (el) => {
  // The model picker is stretched to fill when the search is closed; what it
  // needs is its name plus the trigger's padding and chevron.
  if (el.classList.contains('model-selector-container') && !el.classList.contains('header-secondary')) {
    const name = el.querySelector('.model-name');
    const trigger = el.querySelector('.dropdown-trigger');
    if (name && trigger) {
      const cs = getComputedStyle(trigger);
      const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 28;
      // The text's own width: a Range measures the glyphs, not the stretched box.
      const range = document.createRange();
      range.selectNodeContents(name);
      const text = Math.ceil(range.getBoundingClientRect().width);
      return Math.min(320, Math.min(260, text) + chrome);
    }
  }
  return el.getBoundingClientRect().width;
};

export const fitHeaderSearch = (header) => {
  const tools = header?.querySelector('.header-tools');
  if (!tools) return;
  const gap = parseFloat(getComputedStyle(tools).columnGap) || 0;
  let used = 0, count = 0;
  for (const child of tools.children) {
    if (child.classList.contains('header-search') || child.classList.contains('header-compact-only')) continue;
    if (getComputedStyle(child).display === 'none') continue;
    used += natural(child); count++;
  }
  const free = tools.clientWidth - used - gap * count;
  const roomy = free >= SEARCH_MIN;
  if (header.classList.contains('search-roomy') !== roomy) header.classList.toggle('search-roomy', roomy);
};

/** Keeps it right: on resize, on any change in the row, on font load. Returns a cleanup. */
export const watchHeaderSearch = (header) => {
  if (!header || typeof window === 'undefined') return () => {};
  let frame = 0;
  const run = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitHeaderSearch(header)); };
  run();
  window.addEventListener('resize', run);
  const mo = new MutationObserver(run);
  mo.observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
  let ro = null;
  try { ro = new ResizeObserver(run); ro.observe(header); } catch { /* old engine */ }
  document.fonts?.ready?.then(run).catch(() => {});
  const late = setTimeout(run, 600);
  return () => { cancelAnimationFrame(frame); clearTimeout(late); window.removeEventListener('resize', run); mo.disconnect(); ro?.disconnect(); };
};
