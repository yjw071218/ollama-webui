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

/* ---- address bar autocomplete ----
   Suggestions come from the bookmarks and history the main process already
   sends for the panel (browser:lists). The best URL match is also completed
   inline, Chrome-style: the rest of it is typed in and left selected, so
   carrying on typing replaces it and Backspace removes it. */
const suggestBox = $('#suggest');
let suggestions = [];
let suggestAt = -1;
let typed = '';          // what the user actually typed, without the inline completion
let suppressInline = false;
const strip = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
const looksLikeUrl = (v) => /^[a-z][\w+.-]*:\/\//i.test(v)
  || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(v)
  || /^[^\s]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(v);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ESC[c]);
const highlight = (text, q) => {
  const src = String(text || '');
  const i = q ? src.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return escapeHtml(src);
  return escapeHtml(src.slice(0, i)) + '<mark>' + escapeHtml(src.slice(i, i + q.length)) + '</mark>' + escapeHtml(src.slice(i + q.length));
};
const buildSuggestions = (q) => {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const seen = new Map();
  const add = (x, kind, base) => {
    if (!x?.url) return;
    const url = x.url;
    const s = strip(url).toLowerCase();
    const title = String(x.title || '').toLowerCase();
    let score;
    if (s.startsWith(query)) score = 100;
    else if (host(url).replace(/^www\./, '').toLowerCase().startsWith(query)) score = 90;
    else if (s.split(/[./?#=&_-]/).some(w => w.startsWith(query))) score = 60;
    else if (title.split(/\s+/).some(w => w.startsWith(query))) score = 50;
    else if (s.includes(query)) score = 35;
    else if (title.includes(query)) score = 25;
    else return;
    score += base;
    if (x.at) score += Math.max(0, 10 - (Date.now() - x.at) / 86400000); // recent visits first
    score -= Math.min(10, s.length / 20); // shorter, more general addresses first
    const prev = seen.get(url);
    if (!prev || prev.score < score) seen.set(url, { url, title: x.title || '', kind, score });
  };
  for (const b of lists.bookmarks || []) add(b, 'bookmark', 15);
  for (const h of lists.history || []) add(h, 'history', 0);
  if (seen.size < 3) for (const h of POPULAR) add({ url: `https://${h}/`, title: h }, 'popular', -20);
  const out = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  // What was typed, as itself: open it if it is an address, search for it otherwise.
  const raw = q.trim();
  const isUrl = looksLikeUrl(raw);
  const own = { url: raw, title: isUrl ? tr('주소로 이동', 'Go to address') : tr('검색', 'Search'), kind: isUrl ? 'go' : 'search' };
  const rest = out.filter(x => strip(x.url).toLowerCase() !== strip(raw).toLowerCase());
  return isUrl || !out.length || out[0].score < 100 ? [own, ...rest] : [...rest, own];
};
const setExpanded = (open) => {
  address.setAttribute('aria-expanded', String(open));
  if (suggestBox.hidden === !open) return;
  suggestBox.hidden = !open;
  api.action('suggest', open); // the bar grows over the page so the list is not cut off
};
const closeSuggest = () => {
  suggestions = [];
  suggestAt = -1;
  setExpanded(false);
  address.removeAttribute('aria-activedescendant');
};
const markActive = () => {
  suggestBox.querySelectorAll('li').forEach((li, idx) => {
    li.classList.toggle('on', idx === suggestAt);
    li.setAttribute('aria-selected', String(idx === suggestAt));
  });
  if (suggestAt >= 0) {
    address.setAttribute('aria-activedescendant', `sg-${suggestAt}`);
    suggestBox.children[suggestAt]?.scrollIntoView({ block: 'nearest' });
  }
};
const pick = (x, opts) => {
  closeSuggest();
  if (opts?.newTab && (x.kind === 'history' || x.kind === 'bookmark')) api.action('open', x.url, { newTab: true });
  else api.action('go', x.url);
  address.blur();
};
const renderSuggest = () => {
  if (!suggestions.length || !editing) { closeSuggest(); return; }
  suggestBox.replaceChildren(...suggestions.map((x, idx) => {
    const li = document.createElement('li');
    li.id = `sg-${idx}`;
    li.setAttribute('role', 'option');
    const icon = x.kind === 'search' ? '🔍' : x.kind === 'go' ? '🌐' : x.kind === 'bookmark' ? '★' : '🕘';
    const main = x.kind === 'search' || x.kind === 'go'
      ? `<span class="sg-title">${highlight(x.url, typed)}</span><span class="sg-url">${escapeHtml(x.title)}</span>`
      : `<span class="sg-title">${highlight(x.title || strip(x.url), typed)}</span><span class="sg-url">${highlight(strip(x.url), typed)}</span>`;
    li.innerHTML = `<span class="sg-icon">${icon}</span><span class="sg-main">${main}</span>`;
    // mousedown, not click: by the time a click arrives the input has blurred and closed the list.
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(x, { newTab: e.ctrlKey || e.metaKey || e.button === 1 }); });
    li.addEventListener('mousemove', () => { if (suggestAt !== idx) { suggestAt = idx; markActive(); } });
    return li;
  }));
  setExpanded(true);
  markActive();
};
/* Completes to the site first ("you" -> "youtube.com"), the way Chrome does:
   a deep link such as a watch page is almost never what is meant. A full path
   is used only once the typed text already goes past the host. */
const POPULAR = ['youtube.com', 'google.com', 'naver.com', 'github.com', 'chatgpt.com', 'claude.ai', 'namu.wiki', 'daum.net', 'wikipedia.org', 'reddit.com', 'x.com', 'instagram.com', 'coupang.com', 'netflix.com', 'huggingface.co', 'civitai.com', 'stackoverflow.com', 'gmail.com', 'chzzk.naver.com', 'twitch.tv'];
const completionFor = (q) => {
  const hosts = new Map(); // host -> visit count
  const paths = [];
  for (const x of [...(lists.bookmarks || []), ...(lists.history || [])]) {
    if (!x?.url) continue;
    const h = host(x.url).replace(/^www\./i, '').toLowerCase();
    if (h.startsWith(q)) hosts.set(h, (hosts.get(h) || 0) + 1);
    const full = strip(x.url);
    if (full.toLowerCase().startsWith(q)) paths.push(full);
  }
  if (!q.includes('/')) {
    if (hosts.size) return [...hosts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    const pop = POPULAR.find(h => h.startsWith(q));
    if (pop) return pop;
  }
  return paths.sort((a, b) => a.length - b.length)[0] || '';
};
const inlineComplete = () => {
  if (suppressInline || !typed || /\s/.test(typed) || /^[a-z][\w+.-]*:\/\//i.test(typed)) return;
  const full = completionFor(typed.toLowerCase().replace(/^www\./, ''));
  if (!full || full.length <= typed.length || !full.toLowerCase().startsWith(typed.toLowerCase())) return;
  address.value = typed + full.slice(typed.length);
  address.setSelectionRange(typed.length, address.value.length);
};
const updateSuggest = () => {
  typed = address.value;
  suggestions = buildSuggestions(typed);
  suggestAt = suggestions.length ? 0 : -1;
  renderSuggest();
  inlineComplete();
};
// Deleting must not be undone by completing the same text straight back in.
address.addEventListener('beforeinput', (e) => { suppressInline = /^delete/.test(e.inputType || ''); });
address.addEventListener('input', updateSuggest);
address.addEventListener('keydown', (e) => {
  const open = !suggestBox.hidden && suggestions.length > 0;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) { if (address.value.trim()) { suppressInline = true; updateSuggest(); } return; }
    suggestAt = (suggestAt + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    address.value = suggestions[suggestAt].url;
    markActive();
  } else if (e.key === 'Tab' && open && address.selectionStart !== address.selectionEnd) {
    // Accept the inline completion and keep editing.
    e.preventDefault();
    address.setSelectionRange(address.value.length, address.value.length);
    typed = address.value;
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    e.stopPropagation();
    address.value = typed;
    closeSuggest();
  } else if (e.key === 'Delete' && e.shiftKey && open && suggestions[suggestAt]?.kind === 'history') {
    // Shift+Delete forgets the highlighted history entry, as in Chrome.
    e.preventDefault();
    const gone = suggestions[suggestAt].url;
    api.action('removeHistory', gone);
    lists.history = (lists.history || []).filter(h => h.url !== gone);
    address.value = typed;
    suppressInline = true;
    updateSuggest();
  }
});

address.addEventListener('focus', () => { editing = true; address.select(); });
address.addEventListener('blur', () => { editing = false; closeSuggest(); });
$('#go').addEventListener('submit', (e) => {
  e.preventDefault();
  // Whatever is in the box -- the inline completion or the row picked with the arrows -- is where to go.
  const value = address.value;
  closeSuggest();
  api.action('go', value);
  address.blur();
});

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
// Clicking the chip again cancels the selection/image mode.
askmode.title = tr('다시 클릭하면 선택 취소', 'Click again to cancel');
askmode.addEventListener('mousedown', (e) => e.preventDefault());
askmode.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setMode(null); question.focus(); });
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

/* ---- model picker ---- */
const modelBtn = $('#model');
const modelMenu = $('#model-menu');
let menuOpen = false;
const shortName = (m) => String(m || '').replace(/^.*\//, '');
const closeModels = () => { menuOpen = false; modelMenu.hidden = true; modelBtn.setAttribute('aria-expanded', 'false'); api.action('modelMenu', false); };
const renderModels = () => {
  const models = state.models || [];
  modelBtn.hidden = !models.length;
  $('#model-name').textContent = shortName(state.model) || tr('모델 선택', 'Pick a model');
  modelBtn.title = state.model || tr('사용할 AI 모델', 'AI model');
  if (!menuOpen) return;
  modelMenu.replaceChildren(...models.map((m) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(m === state.model));
    li.className = m === state.model ? 'on' : '';
    li.textContent = m;
    li.tabIndex = -1;
    li.addEventListener('click', () => { api.action('model', m); closeModels(); });
    return li;
  }));
  const r = modelBtn.getBoundingClientRect();
  modelMenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 300))}px`;
  modelMenu.style.top = `${r.bottom + 4}px`;
};
modelBtn.addEventListener('click', () => {
  if (menuOpen) { closeModels(); return; }
  menuOpen = true; modelMenu.hidden = false; modelBtn.setAttribute('aria-expanded', 'true');
  api.action('modelMenu', true); // the bar grows over the page so the list is not cut off
  renderModels();
  modelMenu.querySelector('.on')?.scrollIntoView({ block: 'center' });
});
modelMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModels(); });
document.addEventListener('pointerdown', (e) => { if (menuOpen && !modelMenu.contains(e.target) && !modelBtn.contains(e.target)) closeModels(); });

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
  renderModels();
  const style = document.documentElement.style;
  for (const n of ['bg', 'fg', 'muted', 'line', 'hover']) if (/^#[0-9a-f]{6}$/i.test(state.colors?.[n] || '')) style.setProperty('--' + n, state.colors[n]);
});
