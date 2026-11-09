/**
 * A textarea as tall as its text, up to `max` pixels; one row when empty.
 * The message box (App.jsx, `fitComposer`) calls it whenever its text or its
 * width changes. Tested in a browser (scripts/viewanchor.browser.test.mjs).
 */
export const fitTextarea = (box, max = 200) => {
  if (!box) return;
  /* Empty is one row, and that needs no measuring. Reading `clientWidth`
     first forced a layout of the whole page even here -- and an empty box is
     exactly what every sent message leaves behind (profiled: ~0.4 s of the
     work per message on a phone-speed CPU). */
  if (!box.value) {
    if (box.style.height !== 'auto') box.style.height = 'auto';
    return;
  }
  if (!box.clientWidth) return;
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, max)}px`;
};
