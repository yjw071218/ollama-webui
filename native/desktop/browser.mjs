/*
 * Links from the page open here, inside the app, instead of in the system
 * browser -- and not in a window of their own either: the page slides in
 * over the chat, under the app's own title bar.
 *
 * The bar (browser.html) has three rows: tabs; back / forward / reload /
 * address / bookmark / zoom / find / menu; and the AI row -- a question about
 * the page and one-press actions (summarise, translate, key points, explain).
 * Asking docks the page to the left with the chat beside it, and hands the
 * chat the page's whole text, a screenshot and its pictures (see `capture`).
 * The chat shows only that a page was attached (src/attachMarkers.js).
 *
 * The site runs in its own session (persist:inapp-browser), sandboxed, with
 * no preload and every permission refused -- it is somebody else's page, and
 * it gets nothing of the app's or the server's. Reading it for a question is
 * done in an isolated world, so the page's own scripts cannot see or alter it.
 */
import { app, BrowserWindow, Menu, WebContentsView, clipboard, ipcMain, nativeImage, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromeColors } from './theme.mjs';
import { tr } from './i18n.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const barURL = pathToFileURL(path.join(root, 'browser.html')).href;
const TITLE = 44;    // the app's own title bar (chrome.mjs), which stays on top
const BAR = 112;     // tabs 32 + toolbar 42 + AI row 38
const FIND = 36;     // the find row, when open
const web = (url) => { try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; } };
const START = 'https://www.google.com/';

let browserSession = null;
const siteSession = () => {
  if (browserSession) return browserSession;
  browserSession = session.fromPartition('persist:inapp-browser');
  browserSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  browserSession.setPermissionCheckHandler(() => false);
  return browserSession;
};

/* What was typed in the address bar, as a URL: an address as it is, a host
   with a dot as https (localhost and bare IPs as http), anything else a search. */
export const addressToUrl = (value) => {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (/^(localhost|127\.\d+\.\d+\.\d+|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/|$)/i.test(v)) return 'http://' + v;
  if (/^[^\s]+\.[^\s]+$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
};

/* ------------------------------------------------ bookmarks and history */

const MAX_HISTORY = 300;
let store = null;
const storeFile = () => path.join(app.getPath('userData'), 'inapp-browser.json');
const readStore = () => {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { store = {}; }
  store.bookmarks = Array.isArray(store.bookmarks) ? store.bookmarks.filter(b => web(b?.url)) : [];
  store.history = Array.isArray(store.history) ? store.history.filter(h => web(h?.url)) : [];
  return store;
};
let saveTimer = null;
const saveStore = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(storeFile(), JSON.stringify(store)); } catch { /* read-only profile */ }
  }, 400);
};
/** One visit, newest first; the same address again moves to the top. */
export const addVisit = (history, { url, title }, at = Date.now()) => {
  if (!web(url)) return history;
  return [{ url, title: String(title || url).slice(0, 300), at }, ...history.filter(h => h.url !== url)].slice(0, MAX_HISTORY);
};
export const toggleBookmark = (bookmarks, { url, title }) => (
  bookmarks.some(b => b.url === url)
    ? bookmarks.filter(b => b.url !== url)
    : web(url) ? [{ url, title: String(title || url).slice(0, 300), at: Date.now() }, ...bookmarks] : bookmarks
);

/* ------------------------------------------------------- quick actions */

export const QUICK = {
  summary: () => tr('이 페이지의 내용을 핵심 위주로 요약해 줘.', 'Summarise this page.'),
  translate: () => tr('이 페이지의 내용을 자연스러운 한국어로 번역해 줘. 길면 중요한 부분부터 번역해 줘.', 'Translate this page into natural English.'),
  points: () => tr('이 페이지의 핵심 내용을 중요도 순서대로 목록으로 정리해 줘.', 'List the key points of this page in order of importance.'),
  explain: () => tr('이 페이지의 내용을 배경지식이 없는 사람도 이해할 수 있게 쉽게 설명해 줘.', 'Explain this page simply, for someone with no background.'),
};

/** The right-click menu for the site, as `{ label, action, arg }` and separators. Pure, for the tests. */
export function siteMenuItems(p = {}, { canBack = false, canForward = false } = {}) {
  const items = [];
  const group = (list) => { if (list.length) { if (items.length) items.push({ type: 'separator' }); items.push(...list); } };
  const sel = String(p.selectionText || '').trim();
  if (sel) group([
    { label: tr('선택한 부분을 AI에게 질문…', 'Ask AI about the selection…'), action: 'askSelection' },
    { label: tr('선택한 부분 설명해 줘', 'Explain the selection'), action: 'quickSelection', arg: 'explain' },
    { label: tr('선택한 부분 번역해 줘', 'Translate the selection'), action: 'quickSelection', arg: 'translate' },
    { label: tr('복사', 'Copy'), action: 'copy' },
  ]);
  if (p.mediaType === 'image' && web(p.srcURL)) group([
    { label: tr('이 이미지를 AI에게 질문…', 'Ask AI about this image…'), action: 'askImage', arg: p.srcURL },
    { label: tr('이 이미지 설명해 줘', 'Describe this image'), action: 'describeImage', arg: p.srcURL },
    { label: tr('이미지 주소 복사', 'Copy image address'), action: 'copyText', arg: p.srcURL },
  ]);
  if (web(p.linkURL)) group([
    { label: tr('새 탭에서 열기', 'Open in new tab'), action: 'newTab', arg: p.linkURL },
    { label: tr('링크 주소 복사', 'Copy link address'), action: 'copyText', arg: p.linkURL },
    { label: tr('기본 브라우저로 열기', 'Open in your browser'), action: 'external', arg: p.linkURL },
  ]);
  if (p.isEditable) group([
    { label: tr('잘라내기', 'Cut'), action: 'cut' },
    { label: tr('복사', 'Copy'), action: 'copy' },
    { label: tr('붙여넣기', 'Paste'), action: 'paste' },
    { label: tr('모두 선택', 'Select all'), action: 'selectAll' },
  ]);
  if (!sel && !p.isEditable) group([
    { label: tr('뒤로', 'Back'), action: 'back', enabled: canBack },
    { label: tr('앞으로', 'Forward'), action: 'forward', enabled: canForward },
    { label: tr('새로고침', 'Reload'), action: 'reload' },
    { type: 'separator' },
    { label: tr('이 페이지 요약해 줘', 'Summarise this page'), action: 'quick', arg: 'summary' },
    { label: tr('이 페이지 번역해 줘', 'Translate this page'), action: 'quick', arg: 'translate' },
    { label: tr('페이지에서 찾기', 'Find in page'), action: 'find' },
  ]);
  return items;
}

/* ---------------------------------------------------- reading the page */

const MAX_TEXT = 100_000;
const MAX_IMAGES = 20;
const READ_PAGE = `(() => {
  const sel = String(getSelection?.() || '').trim();
  const text = String(document.body?.innerText || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const seen = new Set(), images = [];
  for (const img of document.images) {
    const src = img.currentSrc || img.src;
    if (!src || seen.has(src) || !/^(https?:|data:image\\/)/.test(src)) continue;
    if ((img.naturalWidth || 0) < 96 || (img.naturalHeight || 0) < 96) continue;
    seen.add(src);
    images.push({ src, alt: String(img.alt || '').slice(0, 200) });
  }
  const meta = document.querySelector('meta[name=description],meta[property="og:description"]')?.content || '';
  return { sel: sel.slice(0, ${MAX_TEXT}), text: text.slice(0, ${MAX_TEXT}), images: images.slice(0, ${MAX_IMAGES * 2}), meta: String(meta).slice(0, 500) };
})()`;

/** A picture as JPEG base64, at most 1280px on its long side; '' when it cannot be read. */
const toJpeg = (image) => {
  if (!image || image.isEmpty()) return '';
  const { width, height } = image.getSize();
  if (width < 32 || height < 32) return '';
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image;
  return sized.toJPEG(80).toString('base64');
};

async function fetchImage(ses, src) {
  try {
    if (src.startsWith('data:')) return toJpeg(nativeImage.createFromDataURL(src));
    const response = await ses.fetch(src, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return '';
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return '';
    return toJpeg(nativeImage.createFromBuffer(buf));
  } catch { return ''; }
}

const embedded = new WeakMap(); // app window -> its browser

/* The open pages, kept so that closing the browser -- or the app -- and
   coming back finds them where they were. Written at once rather than on the
   save timer: the app may be quitting. */
export const sessionOf = (s) => {
  const v = s?.session && typeof s.session === 'object' ? s.session : {};
  const tabs = (Array.isArray(v.tabs) ? v.tabs : []).filter(web).slice(0, 30);
  return { open: !!v.open && tabs.length > 0, tabs, active: Math.min(Math.max(0, Number(v.active) || 0), Math.max(0, tabs.length - 1)) };
};
const writeSession = (session) => {
  const s = readStore();
  s.session = session;
  clearTimeout(saveTimer);
  try { fs.writeFileSync(storeFile(), JSON.stringify(s)); } catch { /* read-only profile */ }
};

/* The chat's models, for the bar's picker (client-preload.cjs browserModels). */
const modelsFor = new WeakMap();
export function setBrowserModels(host, value) {
  const models = (Array.isArray(value?.models) ? value.models : []).map(String).filter(Boolean).slice(0, 300);
  modelsFor.set(host, { models, selected: String(value?.selected || '') });
  const open = embedded.get(host);
  if (open && !open.closed) open.refresh();
}

/** Brings back the pages that were open when the app was last closed. */
export function restoreInAppBrowser(host, { background } = {}) {
  if (!host || host.isDestroyed()) return null;
  const open = embedded.get(host);
  if (open && !open.closed) return open;
  const saved = sessionOf(readStore());
  if (!saved.open) return null;
  const b = embed(host, background);
  embedded.set(host, b);
  b.restore(saved);
  return b;
}

/** Opens `url` over the chat in `parent`, in a new tab of the browser already open there. */
export function openInAppBrowser(url, { parent, background } = {}) {
  if (!web(url)) return null;
  const host = parent && !parent.isDestroyed() ? parent : BrowserWindow.getFocusedWindow();
  if (!host || host.isDestroyed()) { void shell.openExternal(url); return null; }
  const open = embedded.get(host);
  if (open && !open.closed) { open.openTab(url); open.reveal(); return open; }
  const b = embed(host, background);
  embedded.set(host, b);
  // The pages from last time come back beside the new one.
  const saved = sessionOf(readStore());
  if (saved.tabs.length) b.restore(saved);
  const same = b.tabs.find(t => t.url === url);
  if (same) b.command('selectTab', same.id); else b.openTab(url);
  return b;
}

function embed(host, background) {
  const colors = chromeColors(background);
  const bar = new WebContentsView({ webPreferences: { preload: path.join(root, 'browser-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  // Transparent, so a panel (bookmarks, history) can hang over the page.
  bar.setBackgroundColor('#00000000');
  host.contentView.addChildView(bar);
  const b = { closed: false };
  const tabs = [];
  let active = null;
  let nextId = 1;
  let docked = false;
  let findOpen = false;
  let panel = false;
  let findResult = null;
  let asking = false;
  let modelMenu = false;

  const site = () => active?.view.webContents;
  let restoring = false;
  const saveSession = (open = true) => {
    if (restoring) return;
    const urls = tabs.map(t => t.view.webContents.getURL() || t.url).filter(web);
    writeSession({ open: open && urls.length > 0, tabs: urls, active: Math.max(0, tabs.indexOf(active)) });
  };
  b.restore = (saved) => {
    restoring = true;
    try { for (const url of saved.tabs) b.openTab(url); } finally { restoring = false; }
    if (tabs[saved.active]) select(tabs[saved.active]);
    saveSession();
  };
  const navOf = (wc) => wc.navigationHistory;
  const canBack = (wc) => !!wc && navOf(wc).canGoBack();
  const canForward = (wc) => !!wc && navOf(wc).canGoForward();

  /* Laid out under the title bar, over exactly the area the chat has. `shift`
     slides it in from a little below, the way the app's own panels arrive. */
  let shift = 0;
  const pageWidth = (w) => (docked ? Math.max(320, Math.min(Math.round(w * 0.58), w - 360)) : w);
  const barHeight = () => BAR + (findOpen ? FIND : 0);
  const layout = () => {
    if (b.closed || host.isDestroyed()) return;
    const [w, h] = host.getContentSize();
    const top = (host.isFullScreen() ? 0 : TITLE) + shift;
    const pw = pageWidth(w);
    const bh = barHeight();
    bar.setBounds({ x: 0, y: top, width: pw, height: panel || modelMenu ? Math.max(bh, h - top) : bh });
    for (const t of tabs) {
      if (t === active) t.view.setBounds({ x: 0, y: top + bh, width: pw, height: Math.max(0, h - top - bh) });
      else t.view.setBounds({ x: 0, y: top + bh, width: 0, height: 0 });
    }
    const left = docked && pw < w ? pw : 0;
    if (host.clientLeft !== left) {
      host.clientLeft = left; host.layoutClient?.();
      // The chat beside the page has no room for its own side panel.
      const client = host.clientContents;
      if (client && !client.isDestroyed()) client.send('client:action', { type: 'browser-dock', docked: left > 0 });
    }
  };
  let anim = null;
  b.reveal = () => {
    clearInterval(anim);
    shift = 18; layout();
    const began = Date.now();
    anim = setInterval(() => {
      const t = Math.min(1, (Date.now() - began) / 150);
      shift = Math.round(18 * (1 - t) ** 3);
      layout();
      if (t >= 1) clearInterval(anim);
    }, 16);
    site()?.focus();
  };
  const events = ['resize', 'enter-full-screen', 'leave-full-screen'];
  for (const ev of events) host.on(ev, layout);

  const sendState = () => {
    if (b.closed || bar.webContents.isDestroyed()) return;
    const wc = site();
    const url = wc?.getURL() || '';
    const s = readStore();
    bar.webContents.send('browser:state', {
      url, title: wc?.getTitle() || '', loading: !!wc?.isLoading(),
      back: canBack(wc), forward: canForward(wc),
      zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
      bookmarked: s.bookmarks.some(x => x.url === url),
      tabs: tabs.map(t => ({ id: t.id, title: t.view.webContents.getTitle() || t.view.webContents.getURL() || tr('새 탭', 'New tab'), loading: t.view.webContents.isLoading(), favicon: t.favicon || '' })),
      active: active?.id || 0,
      colors, embedded: true, docked, findOpen, findResult, panel, asking,
      models: modelsFor.get(host)?.models || [], model: modelsFor.get(host)?.selected || '',
    });
  };
  const sendLists = () => {
    if (b.closed || bar.webContents.isDestroyed()) return;
    const s = readStore();
    bar.webContents.send('browser:lists', { bookmarks: s.bookmarks.slice(0, 200), history: s.history.slice(0, 150) });
  };

  const load = (tab, target) => { if (tab && web(target)) void tab.view.webContents.loadURL(target).catch(() => {}); };

  const select = (tab) => {
    if (!tab || b.closed) return;
    if (active && active !== tab) active.view.webContents.stopFindInPage('clearSelection');
    active = tab;
    saveSession();
    findResult = null;
    // The active page on top of the hidden ones, the bar on top of all.
    host.contentView.addChildView(tab.view);
    host.contentView.addChildView(bar);
    layout(); sendState();
    tab.view.webContents.focus();
  };

  const closeTab = (tab) => {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tabs.splice(i, 1);
    try { host.contentView.removeChildView(tab.view); } catch { /* gone */ }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (!tabs.length) { saveSession(false); b.close(); return; }
    saveSession();
    if (active === tab) select(tabs[Math.min(i, tabs.length - 1)]);
    else sendState();
  };

  const goBack = () => {
    const wc = site();
    // Back from a tab's first page closes it; from the last tab, back to the chat.
    if (canBack(wc)) navOf(wc).goBack(); else if (active) closeTab(active);
  };

  /* --------------------------------------------- asking about the page */

  const capture = async (tab, { only = null } = {}) => {
    const wc = tab.view.webContents;
    let read = {};
    try { read = await wc.executeJavaScriptInIsolatedWorld(1997, [{ code: READ_PAGE }]); } catch (err) { if (process.env.BROWSER_DEBUG) console.error('read', err); }
    read ||= {};
    const images = [];
    // What is on screen first: it shows the layout, and pictures the page
    // draws without <img> (canvas, CSS backgrounds).
    try { const shot = toJpeg(await wc.capturePage()); if (shot) images.push(shot); } catch { /* minimised */ }
    const ses = wc.session;
    const sources = only ? [{ src: only }] : (read.images || []);
    const fetched = await Promise.all(sources.slice(0, only ? 1 : MAX_IMAGES * 2).map(x => fetchImage(ses, x.src)));
    for (const data of fetched) { if (data && images.length < MAX_IMAGES + 1) images.push(data); }
    if (only && images.length > 1) images.unshift(images.splice(1, 1)[0]); // the asked-about picture first
    const alts = (read.images || []).map(x => x.alt).filter(Boolean).slice(0, 30);
    let text = String(read.text || '');
    if (read.meta) text = `${tr('페이지 설명', 'Page description')}: ${read.meta}\n\n${text}`;
    if (alts.length) text += `\n\n${tr('이미지 설명(alt)', 'Image alt texts')}: ${alts.join(' / ')}`;
    return { url: wc.getURL(), title: wc.getTitle(), text, sel: String(read.sel || ''), images };
  };

  const ask = async (question, { selection = false, image = null } = {}) => {
    const q = String(question || '').trim().slice(0, 4000);
    const client = host.clientContents;
    if (!q || !active || !client || client.isDestroyed() || asking) return;
    asking = true; sendState();
    try {
      const page = await capture(active, { only: image });
      let text = q;
      if (selection && page.sel) text = `${q}\n\n> ${page.sel.slice(0, 4000).replace(/\n/g, '\n> ')}`;
      if (image) text = `${q}\n\n(${tr('질문 대상 이미지: 첨부 이미지 중 첫 번째', 'The image asked about is the first attached image')})`;
      docked = true; layout();
      client.send('client:action', { type: 'ask', text, page: { url: page.url, title: page.title, text: page.text, images: page.images, focusImage: !!image } });
    } finally {
      asking = false; sendState();
    }
  };

  /* ---------------------------------------------------------- the tabs */

  b.openTab = (url = START) => {
    const view = new WebContentsView({ webPreferences: { session: siteSession(), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.setBackgroundColor(colors.bg);
    const tab = { id: nextId++, view, favicon: '', url };
    tabs.push(tab);
    host.contentView.addChildView(view);
    const wc = view.webContents;
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate-in-page']) wc.on(ev, sendState);
    const visited = () => {
      const s = readStore();
      s.history = addVisit(s.history, { url: wc.getURL(), title: wc.getTitle() });
      saveStore(); sendState();
    };
    wc.on('did-navigate', () => { tab.favicon = ''; tab.url = wc.getURL(); visited(); saveSession(); });
    wc.on('page-title-updated', visited);
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = (icons || []).find(web) || ''; sendState(); });
    // A pop-up opens as a new tab; anything not http(s) is refused.
    wc.setWindowOpenHandler(({ url: next }) => { if (web(next)) { b.openTab(next); } return { action: 'deny' }; });
    wc.on('will-navigate', (e, next) => { if (!web(next)) e.preventDefault(); });
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('found-in-page', (_e, r) => { if (tab === active) { findResult = { at: r.activeMatchOrdinal, of: r.matches }; sendState(); } });
    wc.on('zoom-changed', (_e, dir) => { zoomBy(dir === 'in' ? 1 : -1); });
    wc.on('before-input-event', keys);
    wc.on('context-menu', (_e, params) => showMenu(tab, params));
    load(tab, url);
    select(tab);
    return tab;
  };

  const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const zoomBy = (step) => {
    const wc = site();
    if (!wc) return;
    if (!step) { wc.setZoomFactor(1); sendState(); return; }
    const z = wc.getZoomFactor();
    let at = 0;
    ZOOMS.forEach((v, i) => { if (Math.abs(v - z) < Math.abs(ZOOMS[at] - z)) at = i; });
    wc.setZoomFactor(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + Math.sign(step)))]);
    sendState();
  };

  const toBar = (channel, value) => { if (!bar.webContents.isDestroyed()) { bar.webContents.focus(); bar.webContents.send(channel, value); } };
  const openFind = () => { findOpen = true; layout(); sendState(); toBar('browser:focusFind'); };
  const closeFind = () => { findOpen = false; findResult = null; site()?.stopFindInPage('clearSelection'); layout(); sendState(); site()?.focus(); };

  function keys(e, input) {
    if (input.type !== 'keyDown') return;
    const key = input.key;
    const k = key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (input.alt && key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    else if (input.alt && key === 'ArrowRight') { e.preventDefault(); navOf(site()).goForward(); }
    else if (key === 'F5') { e.preventDefault(); site()?.reload(); }
    else if (ctrl && k === 'w') { e.preventDefault(); if (active) closeTab(active); }
    else if (ctrl && k === 't') { e.preventDefault(); b.openTab(); toBar('browser:focusAddress'); }
    else if (ctrl && key === 'Tab') { e.preventDefault(); const i = tabs.indexOf(active); select(tabs[(i + (input.shift ? -1 : 1) + tabs.length) % tabs.length]); }
    else if (ctrl && k === 'l') { e.preventDefault(); toBar('browser:focusAddress'); }
    else if (ctrl && k === 'f') { e.preventDefault(); openFind(); }
    else if (ctrl && k === 'd') { e.preventDefault(); command(null, 'bookmark'); }
    else if (ctrl && k === 'h') { e.preventDefault(); command(null, 'panel', 'history'); }
    else if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); zoomBy(1); }
    else if (ctrl && key === '-') { e.preventDefault(); zoomBy(-1); }
    else if (ctrl && key === '0') { e.preventDefault(); zoomBy(0); }
    else if (key === 'Escape' && findOpen) closeFind();
    else if (key === 'Escape' && site()?.isLoading()) site().stop();
  }

  function showMenu(tab, params) {
    const wc = tab.view.webContents;
    const items = siteMenuItems(params, { canBack: canBack(wc), canForward: canForward(wc) });
    if (!items.length) return;
    const run = (action, arg) => {
      if (action === 'askSelection') toBar('browser:askPrompt', { mode: 'selection' });
      else if (action === 'quickSelection') void ask(arg === 'translate' ? tr('다음 선택한 부분을 자연스러운 한국어로 번역해 줘.', 'Translate the selected passage.') : tr('다음 선택한 부분을 쉽게 설명해 줘.', 'Explain the selected passage simply.'), { selection: true });
      else if (action === 'askImage') toBar('browser:askPrompt', { mode: 'image', src: arg });
      else if (action === 'describeImage') void ask(tr('이 이미지에 무엇이 있는지 자세히 설명해 줘.', 'Describe this image in detail.'), { image: arg });
      else if (action === 'newTab') b.openTab(arg);
      else if (action === 'copyText') clipboard.writeText(String(arg || ''));
      else if (action === 'external') { if (web(arg)) void shell.openExternal(arg); }
      else if (action === 'quick') void ask(QUICK[arg]?.() || '');
      else if (action === 'find') openFind();
      else if (action === 'back') navOf(wc).goBack();
      else if (action === 'forward') navOf(wc).goForward();
      else if (action === 'reload') wc.reload();
      else if (['copy', 'cut', 'paste', 'selectAll'].includes(action)) wc[action]();
    };
    Menu.buildFromTemplate(items.map(it => (it.type === 'separator' ? it : { label: it.label, enabled: it.enabled !== false, click: () => run(it.action, it.arg) })))
      .popup({ window: host });
  }

  /* ----------------------------------------------- what the bar asks for */

  bar.webContents.on('will-navigate', (e) => e.preventDefault());
  bar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const fromBar = (e) => e === null || (e.sender === bar.webContents && e.senderFrame?.url === barURL);
  function command(e, action, value, extra) {
    if (!fromBar(e) || b.closed) return;
    const wc = site();
    const s = readStore();
    if (action === 'back') goBack();
    else if (action === 'forward') navOf(wc).goForward();
    else if (action === 'reload') wc?.reload();
    else if (action === 'stop') wc?.stop();
    else if (action === 'close') b.close();
    else if (action === 'external') { const u = wc?.getURL(); if (web(u)) void shell.openExternal(u); }
    else if (action === 'go' && typeof value === 'string') { load(active, addressToUrl(value)); panel = false; layout(); }
    else if (action === 'ask' && typeof value === 'string') {
      const opts = extra && typeof extra === 'object' ? extra : {};
      void ask(value, { selection: opts.mode === 'selection', image: opts.mode === 'image' && web(opts.src) ? opts.src : null });
    }
    else if (action === 'quick' && typeof value === 'string' && QUICK[value]) void ask(QUICK[value]());
    else if (action === 'modelMenu') { modelMenu = !!value; layout(); }
    else if (action === 'model' && typeof value === 'string') {
      const client = host.clientContents;
      if ((modelsFor.get(host)?.models || []).includes(value) && client && !client.isDestroyed()) {
        client.send('client:action', { type: 'browser-model', model: value });
        modelsFor.set(host, { ...modelsFor.get(host), selected: value });
        sendState();
      }
    }
    else if (action === 'dock') { docked = !docked; layout(); sendState(); }
    else if (action === 'newTab') { b.openTab(); toBar('browser:focusAddress'); }
    else if (action === 'selectTab') select(tabs.find(t => t.id === Number(value)));
    else if (action === 'closeTab') { const t = tabs.find(x => x.id === Number(value)); if (t) closeTab(t); }
    else if (action === 'zoomIn') zoomBy(1);
    else if (action === 'zoomOut') zoomBy(-1);
    else if (action === 'zoomReset') zoomBy(0);
    else if (action === 'findOpen') openFind();
    else if (action === 'findClose') closeFind();
    else if (action === 'find' && typeof value === 'string') {
      if (!value) { wc?.stopFindInPage('keepSelection'); findResult = null; sendState(); return; }
      const opts = extra && typeof extra === 'object' ? extra : {};
      wc?.findInPage(value.slice(0, 500), { forward: opts.forward !== false, findNext: !opts.next } /* findNext: true starts a new search */);
    }
    else if (action === 'bookmark' && wc) { s.bookmarks = toggleBookmark(s.bookmarks, { url: wc.getURL(), title: wc.getTitle() }); saveStore(); sendState(); sendLists(); }
    else if (action === 'panel') { panel = value === 'bookmarks' || value === 'history' ? value : false; layout(); sendState(); if (panel) sendLists(); }
    else if (action === 'open' && typeof value === 'string' && web(value)) { panel = false; layout(); if (extra?.newTab) b.openTab(value); else load(active, value); }
    else if (action === 'removeBookmark' && typeof value === 'string') { s.bookmarks = s.bookmarks.filter(x => x.url !== value); saveStore(); sendState(); sendLists(); }
    else if (action === 'removeHistory' && typeof value === 'string') { s.history = s.history.filter(x => x.url !== value); saveStore(); sendLists(); }
    else if (action === 'clearHistory') { s.history = []; saveStore(); sendLists(); }
  }
  const ready = (e) => { if (fromBar(e)) { sendState(); sendLists(); } };
  ipcMain.on('browser:action', command);
  ipcMain.on('browser:ready', ready);

  b.close = ({ keepOpen = false } = {}) => {
    if (b.closed) return;
    // Closed by the reader: the pages are kept for next time, but it does not
    // reopen by itself. Closed with the app: it does.
    if (tabs.length) saveSession(keepOpen === true);
    b.closed = true;
    clearInterval(anim);
    ipcMain.removeListener('browser:action', command);
    ipcMain.removeListener('browser:ready', ready);
    if (!host.isDestroyed()) {
      if (host.clientLeft) {
        host.clientLeft = 0; host.layoutClient?.();
        if (host.clientContents && !host.clientContents.isDestroyed()) host.clientContents.send('client:action', { type: 'browser-dock', docked: false });
      }
      for (const ev of events) host.removeListener(ev, layout);
      host.removeListener('close', keepForNext);
      try { host.contentView.removeChildView(bar); } catch { /* gone */ }
      for (const t of tabs) { try { host.contentView.removeChildView(t.view); } catch { /* gone */ } }
      host.clientContents?.focus?.();
    }
    for (const t of tabs.splice(0)) if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
    if (embedded.get(host) === b) embedded.delete(host);
  };
  const keepForNext = () => { if (!b.closed && tabs.length) saveSession(true); };
  host.on('close', keepForNext);
  host.once('closed', () => b.close({ keepOpen: true }));
  b.refresh = () => sendState();
  // For the main process (and its smoke test): the bar's commands, by name.
  b.command = (action, value, extra) => command(null, action, value, extra);
  b.tabs = tabs;
  b.bar = bar;

  void bar.webContents.loadURL(barURL);
  b.reveal();
  return b;
}
