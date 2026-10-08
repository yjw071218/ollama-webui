import { localize, tr } from './page-i18n.mjs';
localize();
const $ = id => document.getElementById(id);
let selected = -1;
const tiles = [];

const select = (index) => {
  selected = index;
  for (const t of tiles) t.el.setAttribute('aria-selected', String(t.index === index));
  $('share').disabled = index < 0;
  tiles.find(t => t.index === index)?.el.focus();
};
const finish = (index) => window.capturePicker.reply(index);

window.capturePicker.ready(({ items, detail }) => {
  $('detail').textContent = detail
    ? tr('선택한 화면이 이 서버로 전송됩니다: ', 'The picture is sent to this server: ') + detail
    : '';
  for (const item of items) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'tile'; el.setAttribute('role', 'option'); el.setAttribute('aria-selected', 'false');
    el.title = item.name;
    const frame = document.createElement('span'); frame.className = 'thumb';
    if (item.thumb) { const img = document.createElement('img'); img.src = item.thumb; img.alt = ''; frame.append(img); }
    else frame.textContent = item.screen ? '🖥' : '▢';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.name;
    el.append(frame, name);
    el.onclick = () => select(item.index);
    el.ondblclick = () => finish(item.index);
    (item.screen ? $('screens') : $('windows')).append(el);
    tiles.push({ index: item.index, el });
  }
  for (const [list, title] of [['screens', 'screensTitle'], ['windows', 'windowsTitle']]) {
    if (!$(list).children.length) { $(list).hidden = true; $(title).hidden = true; }
  }
  if (tiles.length) select(tiles[0].index);
});

$('share').onclick = () => { if (selected >= 0) finish(selected); };
$('cancel').onclick = () => finish(-1);
$('close').onclick = () => finish(-1);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); finish(-1); return; }
  if (e.key === 'Enter' && selected >= 0 && document.activeElement?.classList.contains('tile')) { e.preventDefault(); finish(selected); return; }
  const arrows = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (arrows[e.key] && tiles.length) {
    e.preventDefault();
    const at = Math.max(0, tiles.findIndex(t => t.index === selected));
    select(tiles[(at + arrows[e.key] + tiles.length) % tiles.length].index);
  }
});
