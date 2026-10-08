/**
 * The app's own pages (title bar, server address, dialogs, update, screen
 * picker) in Korean or English, as the app itself (i18n.mjs).
 *
 * Written in Korean; an element with `data-en` takes that text instead on a
 * system that is not Korean, `data-en-placeholder`, `data-en-title` and
 * `data-en-label` (aria-label) likewise.
 */
export const korean = /^ko\b/i.test(navigator.language || '');
export const tr = (ko, en) => (korean ? ko : en);

export function localize(root = document) {
  document.documentElement.lang = korean ? 'ko' : 'en';
  if (korean) return;
  for (const el of root.querySelectorAll('[data-en]')) el.textContent = el.dataset.en;
  for (const el of root.querySelectorAll('[data-en-placeholder]')) el.placeholder = el.dataset.enPlaceholder;
  for (const el of root.querySelectorAll('[data-en-title]')) el.title = el.dataset.enTitle;
  for (const el of root.querySelectorAll('[data-en-label]')) el.setAttribute('aria-label', el.dataset.enLabel);
  const title = document.querySelector('title[data-en]');
  if (title) document.title = title.dataset.en;
}
