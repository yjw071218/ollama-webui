import { localize } from './page-i18n.mjs';
localize();
const $ = (s) => document.querySelector(s);
const address = $('#address');
let editing = false;
address.addEventListener('focus', () => { editing = true; address.select(); });
address.addEventListener('blur', () => { editing = false; });
$('#go').addEventListener('submit', (e) => { e.preventDefault(); window.appBrowser.action('go', address.value); address.blur(); });
document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
  const a = b.dataset.action;
  window.appBrowser.action(a === 'reload' && b.dataset.loading === '1' ? 'stop' : a);
}));
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft') window.appBrowser.action('back');
  else if (e.altKey && e.key === 'ArrowRight') window.appBrowser.action('forward');
  else if (e.key === 'F5') window.appBrowser.action('reload');
  else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); address.focus(); }
});
window.appBrowser.onFocusAddress(() => address.focus());
window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'w') { e.preventDefault(); window.appBrowser.action('close'); } });
window.appBrowser.onState((state) => {
  if (!editing) address.value = state.url || '';
  $('[data-action="back"]').disabled = !state.back;
  $('[data-action="forward"]').disabled = !state.forward;
  const r = $('#reload');
  r.dataset.loading = state.loading ? '1' : '';
  r.textContent = state.loading ? '✕' : '↻';
  const style = document.documentElement.style;
  for (const n of ['bg', 'fg', 'muted', 'line', 'hover']) if (/^#[0-9a-f]{6}$/i.test(state.colors?.[n] || '')) style.setProperty('--' + n, state.colors[n]);
});
