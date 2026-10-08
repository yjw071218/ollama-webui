/**
 * A textarea as tall as its text, up to `max` pixels; one row when empty.
 * The message box (App.jsx, `fitComposer`) calls it whenever its text or its
 * width changes. Tested in a browser (scripts/viewanchor.browser.test.mjs).
 */
export const fitTextarea = (box, max = 200) => {
  if (!box || !box.clientWidth) return;
  box.style.height = 'auto';
  if (box.value) box.style.height = `${Math.min(box.scrollHeight, max)}px`;
};
