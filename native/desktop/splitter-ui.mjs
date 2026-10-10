// The bar between the docked page and the chat (browser.mjs). While it is
// dragged this view covers the whole window, so the pointer is never lost.
const grip = document.getElementById('grip');
const api = window.appSplitter;
let dragging = false;
api.onColors?.((c) => { for (const k of ['line', 'muted', 'accent']) if (/^#[0-9a-f]{6}$/i.test(c?.[k] || '')) document.documentElement.style.setProperty('--' + k, c[k]); });
api.onPlace?.((x) => { if (!dragging) grip.style.left = x + 'px'; });
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true; document.body.classList.add('drag');
  grip.setPointerCapture(e.pointerId);
  api.send('start', e.screenX);
});
grip.addEventListener('pointermove', (e) => { if (dragging) { grip.style.left = e.clientX + 'px'; api.send('move', e.clientX); } });
const end = (e) => { if (!dragging) return; dragging = false; document.body.classList.remove('drag'); api.send('end', e.clientX); };
grip.addEventListener('pointerup', end);
grip.addEventListener('pointercancel', end);
grip.addEventListener('dblclick', () => api.send('reset'));
