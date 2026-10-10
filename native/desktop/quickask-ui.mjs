import { localize, tr } from './page-i18n.mjs';
localize();
const $ = (s) => document.querySelector(s);
let text = '';
window.quickAsk.ready((data) => {
  text = String(data?.text || '');
  const ex = $('#excerpt');
  if (text) { ex.hidden = false; ex.textContent = text.length > 400 ? text.slice(0, 400) + '…' : text; }
  else { $('#empty').hidden = false; $('#actions').hidden = true; }
  const c = data?.colors;
  if (c) for (const n of ['bg', 'fg', 'muted', 'line', 'hover']) if (/^#[0-9a-f]{6}$/i.test(c[n] || '')) document.documentElement.style.setProperty('--' + n, c[n]);
  (text ? $('#actions button') : $('#question')).focus();
});
document.querySelectorAll('#actions button').forEach((b, i, all) => {
  b.addEventListener('click', () => window.quickAsk.choose(b.dataset.kind, text));
  b.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
  });
});
// 1-4 pick an action straight away.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.quickAsk.close();
  if (document.activeElement !== $('#question') && /^[1-4]$/.test(e.key) && text) document.querySelectorAll('#actions button')[Number(e.key) - 1].click();
});
$('#ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#question').value.trim();
  if (!q && !text) return;
  window.quickAsk.choose('ask', text, q);
});
document.title = tr('선택한 내용에 대해 묻기', 'Ask about the selection');
