import { localize, tr } from './page-i18n.mjs';
localize();
const $ = (s) => document.querySelector(s);
const api = window.appBrowser;
const address = $('#address');
const question = $('#question');
const askmode = $('#askmode');
const findtext = $('#findtext');
let editing = false;
let state = {};
let lists = { bookmarks: [], history: [] };
let askExtra = null; // a question about the selection or one picture, from the right-click menu

address.addEventListener('focus', () => { editing = true; address.select(); });
address.addEventListener('blur', () => { editing = false; });
$('#go').addEventListener('submit', (e) => { e.preventDefault(); api.action('go', address.value); address.blur(); });

const setMode = (extra) => {
  askExtra = extra;
  askmode.hidden = !extra;
  askmode.textContent = extra?.mode === 'image' ? tr('🖼 이미지에 대해', '🖼 About the image') : extra?.mode === 'selection' ? tr('✂ 선택한 부분', '✂ Selection') : '';
};
$('#ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = question.value.trim();
  if (!q || state.asking) return;
  api.action('ask', q, askExtra || undefined);
  question.value = '';
  setMode(null);
  question.blur();
});
question.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMode(null); question.blur(); } });
document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => { if (!state.asking) api.action('quick', b.dataset.quick); }));

document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => {
  const a = b.dataset.action;
  api.action(a === 'reload' && b.dataset.loading === '1' ? 'stop' : a);
}));

/* ---- find ---- */
let findTimer = null;
findtext.addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => api.action('find', findtext.value), 120); });
findtext.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (findtext.value) api.action('find', findtext.value, { next: true, forward: !e.shiftKey }); }
  else if (e.key === 'Escape') api.action('findClose');
});
$('#findnext').addEventListener('click', () => findtext.value && api.action('find', findtext.value, { next: true, forward: true }));
$('#findprev').addEventListener('click', () => findtext.value && api.action('find', findtext.value, { next: true, forward: false }));

/* ---- bookmarks and history panel ---- */
const panel = $('#panel');
const filter = $('#panel-filter');
const when = (at) => {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
};
const host = (url) => { try { return new URL(url).host; } catch { return url; } };
const renderPanel = () => {
  const kind = state.panel;
  panel.hidden = !kind;
  $('#scrim').hidden = !kind;
  document.querySelectorAll('[data-panel]').forEach(b => b.classList.toggle('on', b.dataset.panel === kind));
  if (!kind) return;
  $('#panel-title').textContent = kind === 'bookmarks' ? tr('북마크', 'Bookmarks') : tr('방문 기록', 'History');
  $('#clearhistory').hidden = kind !== 'history';
  const q = filter.value.trim().toLowerCase();
  const items = (lists[kind] || []).filter(x => !q || x.title.toLowerCase().includes(q) || x.url.toLowerCase().includes(q));
  const list = $('#panel-list');
  list.replaceChildren(...(items.length ? items.map((x) => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'entry';
    open.title = x.url + tr(' (Ctrl+클릭: 새 탭)', ' (Ctrl+click: new tab)');
    const t = document.createElement('span'); t.className = 'entry-title'; t.textContent = x.title || x.url;
    const u = document.createElement('span'); u.className = 'entry-url'; u.textContent = `${host(x.url)} · ${when(x.at)}`;
    open.append(t, u);
    open.addEventListener('click', (e) => api.action('open', x.url, { newTab: e.ctrlKey || e.metaKey }));
    open.addEventListener('auxclick', (e) => { if (e.button === 1) api.action('open', x.url, { newTab: true }); });
    const del = document.createElement('button');
    del.className = 'entry-del'; del.textContent = '✕'; del.title = tr('삭제', 'Remove');
    del.addEventListener('click', () => api.action(kind === 'bookmarks' ? 'removeBookmark' : 'removeHistory', x.url));
    li.append(open, del);
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: kind === 'bookmarks' ? tr('북마크가 없습니다. ☆를 눌러 추가하세요.', 'No bookmarks yet. Press ☆ to add one.') : tr('방문 기록이 없습니다.', 'No history yet.') })]));
};
document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => {
  filter.value = '';
  api.action('panel', state.panel === b.dataset.panel ? '' : b.dataset.panel);
}));
$('#panel-close').addEventListener('click', () => api.action('panel', ''));
$('#scrim').addEventListener('click', () => api.action('panel', ''));
$('#clearhistory').addEventListener('click', () => { if (confirm(tr('방문 기록을 모두 지울까요?', 'Clear all history?'))) api.action('clearHistory'); });
filter.addEventListener('input', renderPanel);

/* ---- tabs ---- */
const tablist = $('#tablist');
const renderTabs = () => {
  tablist.replaceChildren(...(state.tabs || []).map((t) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (t.id === state.active ? ' on' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(t.id === state.active));
    tab.title = t.title;
    tab.tabIndex = 0;
    if (t.loading) { const s = document.createElement('span'); s.className = 'spin'; tab.append(s); }
    else if (t.favicon) { const img = document.createElement('img'); img.src = t.favicon; img.alt = ''; img.addEventListener('error', () => img.remove()); tab.append(img); }
    const label = document.createElement('span'); label.className = 'tab-title'; label.textContent = t.title; tab.append(label);
    const x = document.createElement('button'); x.className = 'tab-x'; x.textContent = '✕'; x.title = tr('탭 닫기 (Ctrl+W)', 'Close tab (Ctrl+W)');
    x.addEventListener('click', (e) => { e.stopPropagation(); api.action('closeTab', t.id); });
    tab.append(x);
    tab.addEventListener('click', () => api.action('selectTab', t.id));
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) api.action('closeTab', t.id); });
    tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') api.action('selectTab', t.id); });
    return tab;
  }));
};

/* ---- keys inside the bar ---- */
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey && e.key === 'ArrowLeft') api.action('back');
  else if (e.altKey && e.key === 'ArrowRight') api.action('forward');
  else if (e.key === 'F5') api.action('reload');
  else if (ctrl && k === 'l') { e.preventDefault(); address.focus(); }
  else if (ctrl && k === 'w') { e.preventDefault(); api.action('closeTab', state.active); }
  else if (ctrl && k === 't') { e.preventDefault(); api.action('newTab'); }
  else if (ctrl && k === 'f') { e.preventDefault(); api.action('findOpen'); }
  else if (ctrl && k === 'h') { e.preventDefault(); api.action('panel', state.panel === 'history' ? '' : 'history'); }
  else if (e.key === 'Escape' && state.panel) api.action('panel', '');
});

api.onFocusAddress(() => address.focus());
api.onFocusFind(() => { findtext.focus(); findtext.select(); });
api.onAskPrompt((extra) => { setMode(extra && typeof extra === 'object' ? extra : null); question.focus(); });
api.onLists((value) => { lists = value || lists; renderPanel(); });
api.onState((next) => {
  state = next || {};
  if (!editing) address.value = state.url || '';
  $('[data-action="back"]').disabled = !state.back;
  $('[data-action="forward"]').disabled = !state.forward;
  const r = $('#reload');
  r.dataset.loading = state.loading ? '1' : '';
  r.textContent = state.loading ? '✕' : '↻';
  const star = $('#star');
  star.textContent = state.bookmarked ? '★' : '☆';
  star.classList.toggle('on', !!state.bookmarked);
  $('#zoom').textContent = `${state.zoom || 100}%`;
  const d = $('#dock');
  d.classList.toggle('on', !!state.docked);
  d.textContent = tr('채팅 ', 'Chat ') + (state.docked ? '◂' : '▸');
  document.body.classList.toggle('asking', !!state.asking);
  question.disabled = !!state.asking;
  question.placeholder = state.asking ? tr('페이지 내용과 이미지를 모으는 중…', 'Reading the page and its images…') : (question.dataset.placeholder ||= question.placeholder);
  document.querySelectorAll('[data-quick]').forEach(b => { b.disabled = !!state.asking; });
  const findrow = $('#findrow');
  findrow.hidden = !state.findOpen;
  $('#findcount').textContent = state.findResult && findtext.value ? `${state.findResult.at}/${state.findResult.of}` : '';
  renderTabs();
  renderPanel();
  const style = document.documentElement.style;
  for (const n of ['bg', 'fg', 'muted', 'line', 'hover']) if (/^#[0-9a-f]{6}$/i.test(state.colors?.[n] || '')) style.setProperty('--' + n, state.colors[n]);
});
