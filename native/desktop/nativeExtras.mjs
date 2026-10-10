/*
 * What the Windows app does beyond showing the page:
 *
 *  1. Ask about the selection, from any program. Select text anywhere, press
 *     Ctrl+Shift+Q, and a small window opens beside the pointer: summarise,
 *     translate, explain, or type a question. The answer is written in the app.
 *     The selection is read by pressing Ctrl+C for the user (a WSH script, which
 *     starts in a few dozen milliseconds), and the clipboard is put back as it
 *     was afterwards.
 *  2. Clipboard watch (off until switched on): a copied picture, or a long
 *     piece of text, copied while the app is not in front offers itself as an
 *     attachment in a Windows notification. Clicking it attaches it.
 *  3. Done, said while away: when an answer (pictures and music are answers
 *     too) finishes while the window is not in front, a Windows notification
 *     says which chat it was, clicking it opens that chat, and the taskbar
 *     button carries a dot until the window is looked at again.
 *  4. Explorer: "Ollama WebUI에 첨부" in the right-click menu of files and
 *     folders, and the same in Send To (which takes many files at once). The
 *     files go to the message box of the app. Windows has no drop target on a
 *     tray icon (Electron's `drop-files` is macOS only), so this is the way in
 *     from Explorer besides dropping onto the window itself.
 */
import { BrowserWindow, Notification, clipboard, ipcMain, nativeImage, screen, shell, app, globalShortcut } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { tr } from './i18n.mjs';
import { chromeColors } from './theme.mjs';

export const SELECTION_KEY = 'CommandOrControl+Shift+Q';
const FILE_MAX = 20 * 1024 * 1024;
const FILES_MAX = 10;
const TEXT_WORTH_OFFERING = 200;

/* ------------------------------------------------------------ tiny PNG */
/** A filled circle as PNG bytes, for the taskbar's overlay dot. */
export function dotPng(size = 16, rgb = [217, 119, 87]) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = (size - 1) / 2, r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, r - d + 0.5));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = Math.round(a * 255);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------- prompts for a selection */
export function selectionPrompt(kind, text, question = '') {
  const quoted = String(text || '').trim();
  const body = quoted ? `\n\n"""\n${quoted}\n"""` : '';
  switch (kind) {
    case 'summarize': return tr('다음 내용을 핵심만 간결하게 요약해 줘.', 'Summarise the following briefly, keeping only what matters.') + body;
    case 'translate': return tr('다음 내용을 번역해 줘. 한국어면 영어로, 그 밖의 언어면 한국어로 옮겨 줘.', 'Translate the following. Into English if it is Korean, otherwise into Korean.') + body;
    case 'explain': return tr('다음 내용을 쉽게 풀어서 설명해 줘.', 'Explain the following in plain words.') + body;
    case 'fix': return tr('다음 글의 맞춤법과 문장을 자연스럽게 다듬어 줘. 고친 글만 보여 줘.', 'Proofread and smooth the following. Show only the corrected text.') + body;
    default: return (String(question || '').trim() || tr('다음 내용에 대해 알려 줘.', 'Tell me about the following.')) + body;
  }
}

/** Which of argv are files to attach: after --attach, or after a lone path from Send To. */
export function attachArgs(argv) {
  const at = argv.indexOf('--attach');
  if (at < 0) return [];
  return argv.slice(at + 1).filter(v => v && !v.startsWith('--'));
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';

export function createExtras({ liveClient, reveal, getSettings, save, directory, smoke }) {
  const settings = () => getSettings();
  /* ---------------------------------------- talking to the page, or waiting */
  const pending = [];
  const ready = () => {
    const win = liveClient();
    return win && win.clientContents && !win.clientContents.isDestroyed() && !win.clientContents.isLoading() ? win : null;
  };
  const flush = () => {
    const win = ready();
    if (!win) return;
    while (pending.length) win.clientContents.send('client:action', pending.shift());
  };
  const toPage = (request) => { pending.push(request); reveal(); flush(); if (pending.length) setTimeout(flush, 1500); };
  const openChat = (chat) => {
    const win = ready();
    if (!win || !chat) return;
    const id = JSON.stringify(String(chat));
    win.clientContents.executeJavaScript(`window.__ollamaOpenChat=${id};window.dispatchEvent(new CustomEvent('ollama-native-open-chat',{detail:{chat:${id}}}))`).catch(() => {});
  };

  /* -------------------------------------------- 1. the selection, anywhere */
  let selectionBusy = false;
  let ownClipboardChange = 0;
  const wsh = path.join(app.getPath('userData'), 'copy-selection.js');
  const pressCopy = async () => {
    await writeFile(wsh, 'WScript.CreateObject("WScript.Shell").SendKeys("^c");', 'utf8').catch(() => {});
    await new Promise((resolve) => execFile('cscript.exe', ['//nologo', '//B', wsh], { windowsHide: true, timeout: 3000 }, () => resolve()));
  };
  const readSelection = async () => {
    const before = { text: clipboard.readText(), html: clipboard.readHTML(), image: clipboard.readImage(), formats: clipboard.availableFormats() };
    const marker = `__ollama_sel_${Date.now()}__`;
    ownClipboardChange = Date.now();
    clipboard.writeText(marker);
    // The keys of the shortcut itself must be up, or ^c arrives as Ctrl+Shift+C.
    await new Promise(r => setTimeout(r, 280));
    await pressCopy();
    let text = '';
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 50));
      const now = clipboard.readText();
      if (now !== marker) { text = now; break; }
    }
    // Put back what was there.
    ownClipboardChange = Date.now();
    try {
      if (!before.image.isEmpty() && !before.text) clipboard.writeImage(before.image);
      else if (before.html) clipboard.write({ text: before.text, html: before.html });
      else if (before.text || before.formats.length) clipboard.writeText(before.text);
      else clipboard.clear();
    } catch { /* */ }
    return text.trim();
  };
  let popup = null;
  const openPopup = (text) => {
    if (popup && !popup.isDestroyed()) popup.close();
    const point = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const width = 400, height = text ? 250 : 170;
    const x = Math.max(area.x + 8, Math.min(point.x + 12, area.x + area.width - width - 8));
    const y = Math.max(area.y + 8, Math.min(point.y + 16, area.y + area.height - height - 8));
    popup = new BrowserWindow({
      x, y, width, height, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
      webPreferences: { preload: path.join(directory, 'quickask-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const win = popup;
    win.setMenu(null);
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('blur', () => { if (!win.isDestroyed()) win.close(); });
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.webContents.once('did-finish-load', () => win.webContents.send('quickask:data', { text, colors: (() => { try { return chromeColors(settings().pageBackground); } catch { return null; } })() }));
    win.loadFile(path.join(directory, 'quickask.html'));
  };
  ipcMain.on('quickask:choose', (event, kind, text, question) => {
    if (!popup || popup.isDestroyed() || event.sender !== popup.webContents) return;
    popup.close();
    const prompt = selectionPrompt(String(kind || ''), String(text || '').slice(0, 60000), String(question || '').slice(0, 4000));
    if (prompt.trim()) toPage({ type: 'ask', text: prompt });
  });
  ipcMain.on('quickask:close', (event) => { if (popup && !popup.isDestroyed() && event.sender === popup.webContents) popup.close(); });
  const askAboutSelection = async () => {
    if (selectionBusy) return;
    selectionBusy = true;
    try { openPopup(await readSelection()); }
    catch { openPopup(''); }
    finally { selectionBusy = false; }
  };
  const applySelectionKey = () => {
    try { globalShortcut.unregister(SELECTION_KEY); } catch { /* */ }
    if (smoke || settings().selectionShortcut === false) return true;
    return globalShortcut.register(SELECTION_KEY, () => { void askAboutSelection(); });
  };

  /* ----------------------------------------------------- 2. clipboard watch */
  let clipTimer = null;
  let lastClip = '';
  const clipSignature = () => {
    const formats = clipboard.availableFormats();
    if (formats.some(f => f.startsWith('image/'))) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) { const s = img.getSize(); const bmp = img.toBitmap(); return `img:${s.width}x${s.height}:${bmp.length}:${bmp.subarray(0, 64).toString('hex')}:${bmp.subarray(-64).toString('hex')}`; }
    }
    const text = clipboard.readText();
    return text ? `txt:${text.length}:${text.slice(0, 80)}:${text.slice(-80)}` : '';
  };
  const offerClipboard = () => {
    const formats = clipboard.availableFormats();
    const img = formats.some(f => f.startsWith('image/')) ? clipboard.readImage() : null;
    const text = clipboard.readText();
    let payload = null, body = '';
    if (img && !img.isEmpty()) {
      const png = img.toPNG();
      if (png.length > FILE_MAX) return;
      payload = { type: 'share', text: '', files: [{ name: `clipboard-${Date.now()}.png`, type: 'image/png', data: png.toString('base64') }] };
      const s = img.getSize(); body = tr(`복사한 이미지 (${s.width}×${s.height})`, `Copied picture (${s.width}×${s.height})`);
    } else if (text && text.trim().length >= TEXT_WORTH_OFFERING && !text.startsWith('__ollama_sel_')) {
      payload = { type: 'share', text: text.slice(0, 100000), files: [] };
      body = text.trim().replace(/\s+/g, ' ').slice(0, 120) + (text.length > 120 ? '…' : '');
    }
    if (!payload || !Notification.isSupported()) return;
    const n = new Notification({ title: tr('클립보드 내용을 채팅에 첨부할까요?', 'Attach the clipboard to a chat?'), body: body + tr('\n클릭하면 입력창에 첨부합니다.', '\nClick to attach it to the message box.'), silent: true });
    n.on('click', () => toPage(payload));
    n.show();
  };
  const applyClipboardWatch = () => {
    clearInterval(clipTimer); clipTimer = null;
    if (smoke || !settings().clipboardWatch) return;
    try { lastClip = clipSignature(); } catch { lastClip = ''; }
    clipTimer = setInterval(() => {
      let sig = '';
      try { sig = clipSignature(); } catch { return; }
      if (sig === lastClip) return;
      lastClip = sig;
      if (!sig || Date.now() - ownClipboardChange < 2500) return;
      const win = liveClient();
      if (win && win.isFocused()) return; // copying inside the app is not news
      try { offerClipboard(); } catch { /* */ }
    }, 1200);
  };

  /* ------------------------------------------ 3. finished while you were away */
  let dot = null;
  let unseen = false;
  const clearDot = () => {
    if (!unseen) return;
    unseen = false;
    const win = liveClient();
    try { win?.setOverlayIcon(null, ''); } catch { /* */ }
  };
  const watchFocus = (win) => { win.on('focus', clearDot); };
  const finished = ({ chat = '', title = '' } = {}) => {
    const win = liveClient();
    if (!win || smoke) return;
    if (win.isFocused() && win.isVisible() && !win.isMinimized()) return;
    unseen = true;
    try { dot ??= nativeImage.createFromBuffer(dotPng(16)); win.setOverlayIcon(dot, tr('새 답변', 'New answer')); } catch { /* */ }
    if (settings().doneNotify === false || !Notification.isSupported()) return;
    const n = new Notification({
      title: tr('답변이 준비됐어요', 'Your answer is ready'),
      body: title ? tr(`「${title}」`, `"${title}"`) : tr('Ollama WebUI에서 확인하세요.', 'Open Ollama WebUI to read it.'),
      icon: path.join(directory, 'icons/app.png'),
    });
    n.on('click', () => { reveal(); openChat(chat); });
    n.show();
  };

  /* ------------------------------------------------------------ 4. Explorer */
  const attachFiles = async (paths) => {
    const files = [], folders = [];
    let skipped = 0;
    for (const p of paths.slice(0, 50)) {
      try {
        const s = await stat(p);
        if (s.isDirectory()) { folders.push(p); continue; }
        if (files.length >= FILES_MAX || s.size > FILE_MAX) { skipped++; continue; }
        files.push({ name: path.basename(p), type: mimeOf(p), data: (await readFile(p)).toString('base64') });
      } catch { skipped++; }
    }
    const text = folders.length ? folders.map(f => `📁 ${f}`).join('\n') : '';
    if (files.length || text) toPage({ type: 'share', text, files });
    if (skipped && Notification.isSupported()) new Notification({ title: 'Ollama WebUI', body: tr(`파일 ${skipped}개는 너무 크거나(20MB) 너무 많아서 빠졌습니다.`, `${skipped} file(s) were too large (20 MB) or too many and were left out.`) }).show();
  };
  // Several files from the right-click menu arrive as several launches, a moment apart.
  let batch = [], batchTimer = null;
  const takeAttach = (paths) => {
    if (!paths.length) return false;
    batch.push(...paths);
    clearTimeout(batchTimer);
    batchTimer = setTimeout(() => { const all = [...new Set(batch)]; batch = []; void attachFiles(all); }, 350);
    return true;
  };
  const exe = process.execPath;
  const launchArgs = (app.isPackaged ? '' : `"${app.getAppPath()}" `) + '--attach';
  const reg = (args) => new Promise((resolve) => execFile('reg.exe', args, { windowsHide: true }, (err) => resolve(!err)));
  const KEYS = ['HKCU\\Software\\Classes\\*\\shell\\OllamaWebUI', 'HKCU\\Software\\Classes\\Directory\\shell\\OllamaWebUI'];
  const sendTo = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'Ollama WebUI.lnk');
  const applyExplorer = async () => {
    if (process.platform !== 'win32' || smoke) return;
    const on = settings().explorerMenu !== false;
    for (const key of KEYS) {
      if (on) {
        await reg(['add', key, '/ve', '/d', tr('Ollama WebUI에 첨부', 'Attach to Ollama WebUI'), '/f']);
        await reg(['add', key, '/v', 'Icon', '/d', `"${exe}",0`, '/f']);
        await reg(['add', key, '/v', 'MultiSelectModel', '/d', 'Player', '/f']);
        await reg(['add', `${key}\\command`, '/ve', '/d', `"${exe}" ${launchArgs} "%1"`, '/f']);
      } else await reg(['delete', key, '/f']);
    }
    try {
      if (on) {
        await mkdir(path.dirname(sendTo()), { recursive: true });
        shell.writeShortcutLink(sendTo(), { target: exe, args: launchArgs, icon: exe, iconIndex: 0, description: tr('Ollama WebUI 입력창에 첨부', 'Attach to the Ollama WebUI message box') });
      } else { const fs = await import('node:fs/promises'); await fs.rm(sendTo(), { force: true }); }
    } catch { /* */ }
  };

  return {
    flush,
    toPage,
    applySelectionKey,
    applyClipboardWatch,
    applyExplorer,
    askAboutSelection,
    finished,
    clearDot,
    watchFocus,
    takeAttach,
    attachArgs,
  };
}
