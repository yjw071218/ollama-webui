import { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, session, shell, desktopCapturer, screen, clipboard } from 'electron';
import { menuItems } from './contextMenu.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeServer, legacyServer, probeServer, startProxy } from './proxy.mjs';
import { createUpdater } from './updater.mjs';
import { loadTrustedPage } from './navigation.mjs';
import { createClientWindow, chromeOptions } from './chrome.mjs';
import { appDialog } from './dialog.mjs';
import { pickSource } from './capture.mjs';
import { loadGrants, rememberGrant } from './permissions.mjs';
import { parseGoogleHandoff, googleAuthorizeUrl, startGoogleLoopback } from './googleLoopback.mjs';
import { setLanguage, tr } from './i18n.mjs';
import { addRecent, forgetRecent } from './recent.mjs';
import { validColor } from './theme.mjs';
import { clampZoom, zoomStep } from './zoom.mjs';
import { openInAppBrowser } from './browser.mjs';
import { createRunner } from './runner.mjs';
const showError = (title, message) => appDialog(clientWindow && !clientWindow.isDestroyed() ? clientWindow : setupWindow, { title, message });

const directory = path.dirname(fileURLToPath(import.meta.url));
const setupURL = pathToFileURL(path.join(directory, 'setup.html')).href;
const smoke = process.argv.includes('--native-smoke');
const smokeProfile = process.argv.find(value => value.startsWith('--smoke-profile='));
if (smoke && smokeProfile) app.setPath('userData', smokeProfile.slice(16));
/* The taskbar groups a window with a pinned shortcut by their AppUserModelID.
   The installer's shortcuts carry the appId (package.json build.appId); the
   app set none, so a pinned app opened as a second, separate icon. */
if (process.platform === 'win32') app.setAppUserModelId('io.github.yjw071218.ollamawebui.client');
let setupWindow, clientWindow, gateway, tray = null, quitting = false, lastFailure = null, wantNewChat = process.argv.includes('--new-chat');
let settings = { server: '', ports: {}, recent: [], zoom: {}, alwaysOnTop: false, closeToTray: false, globalShortcut: true }, connecting = false;
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
/* Settings are written a moment after the last change: a theme switch or a
   zoom with the wheel is a burst of them. */
let saveTimer = null;
const save = (now = false) => {
  clearTimeout(saveTimer);
  const write = () => writeFile(configPath(), JSON.stringify(settings, null, 2), { mode: 0o600 }).catch(() => {});
  if (now) return write();
  saveTimer = setTimeout(write, 400);
  return undefined;
};
/* The window opens where it was left, at the size it was left -- unless that
   place is no longer on any screen (a monitor unplugged since). */
const savedBounds = () => {
  const w = settings.window;
  const ok = w && [w.x, w.y, w.width, w.height].every(Number.isFinite) && w.width >= 420 && w.height >= 500;
  if (!ok) return { width: 1360, height: 900 };
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    w.x < a.x + a.width - 80 && w.x + w.width > a.x + 80 && w.y >= a.y - 10 && w.y < a.y + a.height - 80);
  return visible ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height };
};
const rememberBounds = win => {
  try { settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() }; save(); } catch {}
};
const sameOrigin = (value, origin) => { try { return new URL(value).origin === origin; } catch { return false; } };
const hashOf = server => createHash('sha256').update(server).digest('hex');
/* A server's storage (its port, partition, permissions and zoom). One saved
   before addresses had to be nip.io ones keeps what it had under its old
   address, so moving to the new form does not sign anyone out. */
const serverKey = server => {
  const key = hashOf(server);
  if (settings.ports?.[key]) return key;
  const old = hashOf(legacyServer(server));
  return settings.ports?.[old] ? old : key;
};
/* A link from the page opens in the app's own browser window (browser.mjs);
   the system browser is one button away there. */
async function external(url, owner) {
  if (!/^https?:\/\//i.test(url)) return;
  openInAppBrowser(url, { parent: owner, background: settings.pageBackground });
}
let updater = null;
let runner = null;
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
/** In-app update: check, download with progress, verify and install (updater.mjs). */
function notifyUpdate(manual = false) {
  if (smoke) return;
  updater ??= createUpdater({
    ownerWindow: () => (clientWindow && !clientWindow.isDestroyed() ? clientWindow : setupWindow),
    beforeInstall: async () => { quitting = true; await gateway?.close(); },
  });
  return updater.check({ manual });
}
const liveClient = () => (clientWindow && !clientWindow.isDestroyed() ? clientWindow : null);
/** Bring the app forward: from the tray, minimised or behind other windows. */
function reveal() {
  const win = liveClient() || (setupWindow && !setupWindow.isDestroyed() ? setupWindow : null);
  if (!win) { if (app.isReady()) openSetup(); return null; }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  app.focus({ steal: true });
  win.focus();
  return win;
}
/** A new chat in the page (src/nativeEvents.js), from the tray, the jump list, the bar or the global key. */
function newChat() {
  const win = liveClient();
  if (!win) { wantNewChat = true; reveal(); return; }
  reveal();
  if (!win.clientContents.isDestroyed()) win.clientContents.send('client:action', { type: 'new-chat' });
}
function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.show(); setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({ ...chromeOptions, icon: path.join(directory, 'icons/app.png'), show: !smoke, width: 700, height: 720, title: tr('서버 연결', 'Server'),
    webPreferences: { preload: path.join(directory, 'setup-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const win = setupWindow;
  win.once('closed', () => { if (setupWindow === win) setupWindow = undefined; });
  setupWindow.setMenu(null);
  setupWindow.webContents.on('will-navigate', event => event.preventDefault());
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.loadURL(setupURL);
}
function validSetup(event) {
  return setupWindow && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents && event.senderFrame === setupWindow.webContents.mainFrame && event.senderFrame.url === setupURL;
}
/** The page in the app window, and nothing else: its own frame, its own origin. */
function validClient(event) {
  const win = liveClient();
  return !!win && !!gateway && event.sender === win.clientContents && event.senderFrame === win.clientContents.mainFrame && sameOrigin(event.senderFrame.url, gateway.origin);
}

/* --------------------------------------------------- the taskbar while busy */
let busy = false;
function setBusy(value) {
  const win = liveClient();
  if (!win || value === busy) return;
  busy = value;
  // Indeterminate progress on the taskbar button while an answer is written.
  win.setProgressBar(busy ? 2 : -1, { mode: busy ? 'indeterminate' : 'none' });
  tray?.setToolTip(busy ? tr('Ollama WebUI · 답변 작성 중…', 'Ollama WebUI · writing an answer…') : 'Ollama WebUI');
  // It ended while the reader was elsewhere: the button flashes until they come back.
  if (!busy && (!win.isFocused() || !win.isVisible())) win.flashFrame(true);
}

/* ------------------------------------------------------------- page zoom */
const zoomKey = () => (settings.server ? serverKey(settings.server) : '');
function setZoom(next) {
  const win = liveClient();
  if (!win || win.clientContents.isDestroyed()) return;
  const factor = clampZoom(next);
  win.clientContents.setZoomFactor(factor);
  settings.zoom = { ...(settings.zoom || {}), [zoomKey()]: factor };
  save();
}
const zoomBy = direction => {
  const win = liveClient();
  if (win && !win.clientContents.isDestroyed()) setZoom(zoomStep(win.clientContents.getZoomFactor(), direction));
};

async function connect(value) {
  if (connecting) throw new Error(tr('연결 중입니다.', 'Already connecting.'));
  connecting = true;
  let server = '';
  try {
    server = normalizeServer(value);
    /* Asked before anything is closed or saved: an address that is not this
       server leaves the current connection and the saved server alone. */
    await probeServer(server);
    const key = serverKey(server);
    const savedPort = settings.ports[key] || 0;
    // Fixed per-server origins preserve IndexedDB and keep different servers isolated.
    if (clientWindow && !clientWindow.isDestroyed()) clientWindow.destroy();
    if (gateway) { await gateway.close(); gateway = undefined; }
    try { gateway = await startProxy(server, savedPort); }
    catch (error) { if (error.code === 'EADDRINUSE') throw new Error(tr('저장된 앱 포트가 사용 중입니다. 다른 앱 인스턴스를 종료한 후 다시 시도하세요.', 'The app\'s saved port is in use. Close the other copy of the app and try again.')); throw error; }
    const current = gateway;
    const ses = session.fromPartition('persist:server-' + key);
    const supportedPermissions = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'idle-detection', 'speaker-selection'];
    // What this server was told it may always have (다시 묻지 않기) starts out granted.
    const grants = loadGrants(app.getPath('userData'), key, supportedPermissions);
    const winGone = () => !clientWindow || clientWindow.isDestroyed() || clientWindow.clientContents.isDestroyed();
    const trusted = (wc, url) => wc === clientWindow?.clientContents && sameOrigin(wc?.getURL(), current.origin) && sameOrigin(url, current.origin);
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (sameOrigin(details.url.replace(/^ws/, 'http'), current.origin))
        details.requestHeaders['X-Native-Gateway'] = current.token;
      callback({ requestHeaders: details.requestHeaders });
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
      trusted(wc, requestingOrigin) && grants.has(permission));
    ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
      const supported = supportedPermissions;
      const requestingURL = details.requestingUrl || details.securityOrigin || wc?.getURL();
      if (!trusted(wc, requestingURL) || details.isMainFrame === false || !supported.includes(permission)) { callback(false); return; }
      if (grants.has(permission)) { callback(true); return; }
      const labels = { media: tr('마이크 / 카메라', 'Microphone / camera') + ' (' + (details.mediaTypes || []).join(', ') + ')', notifications: tr('알림', 'Notifications'), 'clipboard-read': tr('클립보드 읽기', 'Reading the clipboard'), 'clipboard-sanitized-write': tr('클립보드 쓰기', 'Writing to the clipboard'), fullscreen: tr('전체 화면', 'Full screen'), pointerLock: tr('마우스 제어', 'Pointer lock') };
      try {
        const result = await appDialog(clientWindow, { type: 'question', title: tr('권한 요청', 'Permission'), message: tr((labels[permission] || permission) + ' 권한을 허용하시겠습니까?', 'Allow ' + (labels[permission] || permission) + '?'), detail: server + '\n' + tr('"이번만 허용"은 앱을 다시 시작하면 다시 묻습니다. "항상 허용"을 고르면 이 서버에는 다시 묻지 않습니다.', '"Allow once" asks again after a restart. "Always allow" does not ask this server again.'), buttons: [tr('거부', 'Deny'), tr('이번만 허용', 'Allow once'), tr('항상 허용 (다시 묻지 않기)', 'Always allow')], defaultId: 0, cancelId: 0 });
        const allowed = (result.response === 1 || result.response === 2) && trusted(wc, requestingURL);
        if (allowed) grants.add(permission);
        // 다시 묻지 않기: remembered for this server across restarts.
        if (allowed && result.response === 2) rememberGrant(app.getPath('userData'), key, permission);
        callback(allowed);
      } catch { callback(false); }
    });
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (!sameOrigin(request.securityOrigin, current.origin) || request.frame !== clientWindow?.clientContents.mainFrame || !request.userGesture) { callback({}); return; }
      try {
        // Pictures of each screen and window, to choose by (capture.mjs).
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
        const chosen = await pickSource(clientWindow, sources, server);
        const stillTrusted = !winGone() && request.frame === clientWindow.clientContents.mainFrame && sameOrigin(clientWindow.clientContents.getURL(), current.origin);
        callback(stillTrusted && chosen ? { video: chosen } : {});
      } catch { callback({}); }
    });
    ses.removeAllListeners('will-download');
    ses.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: tr('파일 저장', 'Save file') }));
    clientWindow = createClientWindow({ icon: path.join(directory, 'icons/app.png'), show: !smoke, ...savedBounds(), pageBackground: settings.pageBackground, minWidth: 420, minHeight: 500, title: 'Ollama WebUI Client',
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } },
      { server: openSetup, updates: () => notifyUpdate(true), menu: win => Menu.getApplicationMenu()?.popup({window:win}), newChat });
    const win = clientWindow;
    if (settings.window?.maximized) win.maximize();
    win.setAlwaysOnTop(!!settings.alwaysOnTop);
    win.on('focus', () => win.flashFrame(false));
    /* Closing hides to the tray when the reader asked for that (app menu); the
       app keeps its connection and its notifications. */
    win.on('close', event => {
      rememberBounds(win);
      if (settings.closeToTray && tray && !quitting) { event.preventDefault(); win.hide(); }
    });
    /* The page's background, as the page changes it: the title bar takes it,
       and the next launch starts in it (theme.mjs, client-preload.cjs). */
    const onChrome = (event, color) => {
      if (event.sender !== win.clientContents || !validClient(event) || !validColor(color)) return;
      win.setChromeColors(color);
      if (settings.pageBackground !== color) { settings.pageBackground = color; save(); }
    };
    ipcMain.on('client:chrome', onChrome);
    win.once('closed', () => ipcMain.removeListener('client:chrome', onChrome));
    // The zoom this server was last read at, and Ctrl+wheel to change it.
    win.clientContents.on('did-finish-load', () => {
      const factor = settings.zoom?.[key];
      if (Number.isFinite(factor)) win.clientContents.setZoomFactor(clampZoom(factor));
    });
    win.clientContents.on('zoom-changed', (_event, direction) => zoomBy(direction === 'in' ? 1 : -1));
    /* Google's account chooser in the browser, answered on 127.0.0.1:47615
       (googleLoopback.mjs). If the port is taken, the server's page instead. */
    const googleDirect = async ({ id, clientId }) => {
      try {
        await startGoogleLoopback({
          id, finishUrl: current.origin + '/api/auth/native/finish',
          fetcher: (url, options) => ses.fetch(url, options),
          onDone: () => { if (!win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); app.focus({ steal: true }); win.focus(); } },
        });
        await shell.openExternal(googleAuthorizeUrl({ id, clientId }));
      } catch {
        await shell.openExternal(server + '/api/auth/native/page#' + id);
      }
    };
    const guard = (event, url) => {
      if (sameOrigin(url, current.origin)) {
        const u = new URL(url);
        if (u.pathname === '/__native/auth') {
          event.preventDefault();
          const google = parseGoogleHandoff(u.hash);
          if (google) void googleDirect(google).catch(() => {});
          else if (/^#[a-f0-9]{64}$/.test(u.hash))
            void shell.openExternal(server + '/api/auth/native/page' + u.hash).catch(() => {});
        }
        return;
      }
      event.preventDefault();
      if (sameOrigin(url, server)) {
        const u = new URL(url); void win.loadClientURL(current.origin + u.pathname + u.search + u.hash).catch(() => {}); // loadTrustedPage observes completion/failure.
      } else external(url, win);
    };
    win.clientContents.on('will-navigate', guard);
    win.clientContents.on('will-redirect', guard);
    win.clientContents.on('will-attach-webview', event => event.preventDefault());
    win.clientContents.setWindowOpenHandler(({ url }) => {
      if (sameOrigin(url, current.origin)) void win.loadClientURL(url).catch(() => {});
      else external(url, win);
      return { action: 'deny' };
    });
    win.on('closed', () => {
      if (clientWindow === win) clientWindow = undefined;
      busy = false;
      current.close();
      if (gateway === current) gateway = undefined;
      if (!connecting && (!setupWindow || setupWindow.isDestroyed() || !setupWindow.isVisible())) app.quit();
    });
    settings.ports[key] = current.port;
    try { await loadTrustedPage({webContents:win.clientContents,loadURL:win.loadClientURL}, current.origin + '/', current.origin); }
    catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
    settings.server = server;
    settings.recent = addRecent(settings.recent, server);
    lastFailure = null;
    await save(true);
    watchConnection(win, server);
    setupWindow?.close();
    if (wantNewChat) { wantNewChat = false; setTimeout(newChat, 1500); }
    if (smoke) {
      const result = await win.clientContents.executeJavaScript('({secure:isSecureContext,media:!!navigator.mediaDevices?.getUserMedia,clipboard:!!navigator.clipboard,node:typeof process,native:window.ollamaNative?.platform||""})');
      console.log('NATIVE_SMOKE ' + JSON.stringify(result));
      if (!result.secure || !result.media || !result.clipboard || result.node !== 'undefined' || result.native !== 'desktop') app.exit(1);
      else app.exit(0);
    }
  } catch (error) {
    /* The saved server not answering is said on the address screen, with a
       retry that also runs on its own (setup.mjs), not in a dialog over it. */
    if (server && server === settings.server) lastFailure = { server, message: error.message, invalid: !!error.notServer };
    // Never left with no window at all (the old one was closed to reconnect).
    if (!liveClient() && !smoke) openSetup();
    throw error;
  } finally { connecting = false; }
}
/* The connection lost after the page had opened (the server stopped, the PC
   went to sleep): a choice to retry or change server, not a blank window. */
function watchConnection(win, server) {
  let asking = false;
  win.clientContents.on('did-fail-load', async (_event, code, description, _url, mainFrame) => {
    if (!mainFrame || code === -3 || asking || win.isDestroyed()) return;
    asking = true;
    const result = await appDialog(win, { type: 'warning', title: tr('연결 끊김', 'Connection lost'),
      message: tr('서버에 연결할 수 없습니다.', 'The server is not answering.'), detail: server + '\n' + (description || ('code ' + code)),
      buttons: [tr('서버 변경', 'Change server'), tr('다시 시도', 'Try again')], defaultId: 1, cancelId: 1 });
    asking = false;
    if (win.isDestroyed()) return;
    if (result.response === 0) openSetup();
    else win.clientContents.reload();
  });
  /* The page's process ended (out of memory, a GPU fault): the window used to
     stay blank until F5. Reloaded on its own -- unless it keeps happening,
     when the reader is asked rather than caught in a loop. */
  let crashes = [];
  win.clientContents.on('render-process-gone', async (_event, details) => {
    if (win.isDestroyed() || details.reason === 'clean-exit') return;
    const now = Date.now();
    crashes = [...crashes.filter(t => now - t < 60000), now];
    if (crashes.length <= 2) { win.clientContents.reload(); return; }
    const result = await appDialog(win, { type: 'warning', title: tr('페이지 오류', 'The page stopped'),
      message: tr('페이지가 반복해서 종료되었습니다.', 'The page keeps stopping.'), detail: server + '\n' + details.reason,
      buttons: [tr('서버 변경', 'Change server'), tr('다시 불러오기', 'Reload')], defaultId: 1, cancelId: 1 });
    if (win.isDestroyed()) return;
    if (result.response === 0) openSetup(); else { crashes = []; win.clientContents.reload(); }
  });
  win.clientContents.on('context-menu', (_event, params) => showContextMenu(win, params));
}

/** The right-click menu (contextMenu.mjs), acted on for this page only. */
function showContextMenu(win, params) {
  const wc = win.clientContents;
  if (wc.isDestroyed() || !gateway || !sameOrigin(wc.getURL(), gateway.origin)) return;
  const act = (action, arg) => {
    if (action === 'replace') wc.replaceMisspelling(arg);
    else if (action === 'learn') wc.session.addWordToSpellCheckerDictionary(arg);
    else if (action === 'openLink') external(arg, win);
    else if (action === 'copyText') clipboard.writeText(arg);
    else if (action === 'copyImage') wc.copyImageAt(params.x, params.y);
    else if (action === 'saveImage') wc.downloadURL(arg);
    else if (['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(action)) wc[action]();
  };
  const template = menuItems(params).map(i => i.type === 'separator' ? i : { label: i.label, enabled: i.enabled !== false, click: () => act(i.action, i.arg) });
  if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
}

/* ------------------------------------------------------------- tray, menus */
function createTray() {
  if (tray || smoke) return;
  const icon = nativeImage.createFromPath(path.join(directory, 'icons/app.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Ollama WebUI');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('열기', 'Open'), click: reveal },
    { label: tr('새 대화', 'New chat'), click: newChat },
    { type: 'separator' },
    { label: tr('서버 주소 변경', 'Change server'), click: openSetup },
    { label: tr('업데이트 확인', 'Check for updates'), click: () => notifyUpdate(true) },
    { type: 'separator' },
    { label: tr('종료', 'Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', reveal);
}
const GLOBAL_KEY = 'CommandOrControl+Shift+Space';
/** Ctrl+Shift+Space from anywhere: the app comes forward, or goes back if it already is. */
function applyGlobalShortcut() {
  globalShortcut.unregister(GLOBAL_KEY);
  if (!settings.globalShortcut || smoke) return true;
  return globalShortcut.register(GLOBAL_KEY, () => {
    const win = liveClient();
    if (win && win.isVisible() && win.isFocused() && !win.isMinimized()) {
      if (settings.closeToTray && tray) win.hide(); else win.minimize();
    } else reveal();
  });
}
/** Right-click on the taskbar button: a new chat straight away. */
function setJumpList() {
  if (process.platform !== 'win32' || smoke) return;
  const args = (app.isPackaged ? '' : '"' + app.getAppPath() + '" ') + '--new-chat';
  try {
    app.setUserTasks([{ program: process.execPath, arguments: args, iconPath: process.execPath, iconIndex: 0,
      title: tr('새 대화', 'New chat'), description: tr('Ollama WebUI에서 새 대화를 시작합니다', 'Start a new chat in Ollama WebUI') }]);
  } catch { /* an older Windows shell */ }
}
function buildMenu() {
  const client = () => liveClient()?.clientContents;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: tr('앱', 'App'), submenu: [
      { label: tr('새 대화', 'New chat'), click: newChat },
      { label: tr('서버 주소 변경', 'Change server address'), click: openSetup },
      { label: tr('업데이트 확인', 'Check for updates'), click: () => notifyUpdate(true) },
      { label: tr('권한 초기화 / 다시 연결', 'Reset permissions / reconnect'), click: () => settings.server && connect(settings.server).catch(e => showError(tr('연결 실패', 'Connection failed'), e.message)) },
      { type: 'separator' },
      { label: tr('창을 닫으면 트레이로 보내기', 'Closing the window keeps it in the tray'), type: 'checkbox', checked: !!settings.closeToTray, click: item => { settings.closeToTray = item.checked; save(); } },
      { label: tr('Ctrl+Shift+Space로 어디서나 불러오기', 'Ctrl+Shift+Space brings the app from anywhere'), type: 'checkbox', checked: settings.globalShortcut !== false, click: item => {
        settings.globalShortcut = item.checked; save();
        if (item.checked && !applyGlobalShortcut()) showError(tr('단축키', 'Shortcut'), tr('다른 프로그램이 Ctrl+Shift+Space를 쓰고 있어 등록하지 못했습니다.', 'Another program is using Ctrl+Shift+Space.'));
        if (!item.checked) applyGlobalShortcut();
      } },
      { type: 'separator' },
      { label: tr('종료', 'Quit'), click: () => { quitting = true; app.quit(); } },
    ] },
    { label: tr('편집', 'Edit'), submenu: [{ role: 'undo', label: tr('실행 취소', 'Undo') }, { role: 'redo', label: tr('다시 실행', 'Redo') }, { type: 'separator' }, { role: 'cut', label: tr('잘라내기', 'Cut') }, { role: 'copy', label: tr('복사', 'Copy') }, { role: 'paste', label: tr('붙여넣기', 'Paste') }, { role: 'selectAll', label: tr('모두 선택', 'Select all') }] },
    { label: tr('보기', 'View'), submenu: [
      { label: tr('새로고침', 'Reload'), accelerator: 'F5', click: () => client()?.reload() },
      { label: tr('캐시 무시하고 새로고침', 'Reload ignoring cache'), accelerator: 'CmdOrCtrl+F5', click: () => client()?.reloadIgnoringCache() },
      { type: 'separator' },
      // The page's zoom, kept per server across restarts; Ctrl+wheel too.
      { label: tr('확대', 'Zoom in'), accelerator: 'CmdOrCtrl+=', click: () => zoomBy(1) },
      { label: tr('축소', 'Zoom out'), accelerator: 'CmdOrCtrl+-', click: () => zoomBy(-1) },
      { label: tr('원래 크기', 'Actual size'), accelerator: 'CmdOrCtrl+0', click: () => setZoom(1) },
      { type: 'separator' },
      { label: tr('항상 위에 표시', 'Always on top'), type: 'checkbox', checked: !!settings.alwaysOnTop, click: item => { settings.alwaysOnTop = item.checked; liveClient()?.setAlwaysOnTop(item.checked); save(); } },
      { label: tr('전체 화면', 'Full screen'), accelerator: 'F11', click: () => { const w = liveClient(); if (w) w.setFullScreen(!w.isFullScreen()); } },
    ] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  /* Started again while running: bring the open window back, even from
     minimized or hidden, rather than seeming to do nothing. From the jump
     list it also opens a new chat. */
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--new-chat')) newChat(); else reveal();
  });
  app.whenReady().then(async () => {
    setLanguage(app.getLocale());
    try { settings = { ...settings, ...JSON.parse(await readFile(configPath(), 'utf8')) }; } catch {}
    if (!Array.isArray(settings.recent)) settings.recent = settings.server ? [settings.server] : [];
    /* Addresses saved before only nip.io ones were taken: an IPv4 one is
       written in the new form, anything else (a web site saved as the server)
       is dropped, so the app opens on the address screen instead of on it. */
    const valid = value => { try { return normalizeServer(value); } catch { return ''; } };
    settings.recent = [...new Set(settings.recent.map(valid).filter(Boolean))];
    if (settings.server) {
      const migrated = valid(settings.server);
      if (!migrated) lastFailure = { server: settings.server, message: tr('저장된 주소가 Ollama WebUI 서버 주소 형식이 아닙니다. 0.0.0.0.nip.io:0000 형식으로 다시 입력하세요.', 'The saved address is not an Ollama WebUI server address. Enter it again as 0.0.0.0.nip.io:0000.'), invalid: true };
      settings.server = migrated;
    }
    ipcMain.handle('connection:current', event => { if (!validSetup(event)) throw new Error('Forbidden'); return settings.server; });
    ipcMain.handle('connection:connect', (event, value) => { if (!validSetup(event) || typeof value !== 'string') throw new Error('Forbidden'); return connect(value); });
    ipcMain.handle('connection:recent', event => { if (!validSetup(event)) throw new Error('Forbidden'); return settings.recent; });
    ipcMain.handle('connection:failure', event => { if (!validSetup(event)) throw new Error('Forbidden'); return lastFailure; });
    ipcMain.handle('connection:forget', (event, value) => {
      if (!validSetup(event) || typeof value !== 'string') throw new Error('Forbidden');
      settings.recent = forgetRecent(settings.recent, value); save(); return settings.recent;
    });
    // What the page asks of the app (client-preload.cjs).
    ipcMain.handle('client:changeServer', event => { if (!validClient(event)) throw new Error('Forbidden'); openSetup(); return true; });
    ipcMain.handle('client:checkUpdates', event => { if (!validClient(event)) throw new Error('Forbidden'); notifyUpdate(true); return true; });
    ipcMain.on('client:busy', (event, value) => { if (validClient(event)) setBusy(!!value); });
    // Running a project on this PC (runner.mjs), for the page's Run workspace.
    const folderKey = dir => path.resolve(dir).toLowerCase();
    runner = createRunner({
      valid: validClient,
      owner: () => liveClient(),
      send: (channel, payload) => { const win = liveClient(); if (win && !win.clientContents.isDestroyed()) win.clientContents.send(channel, payload); },
      allowed: dir => Array.isArray(settings.runFolders) && settings.runFolders.includes(folderKey(dir)),
      allow: dir => { settings.runFolders = [...new Set([...(settings.runFolders || []), folderKey(dir)])]; save(); },
      openBrowser: url => openInAppBrowser(url, { parent: liveClient(), background: settings.pageBackground }),
    });
    buildMenu();
    createTray();
    applyGlobalShortcut();
    setJumpList();
    if (settings.server && !smoke) {
      try { await connect(settings.server); }
      catch { openSetup(); }
    } else openSetup();
    void notifyUpdate();
    // Kept running for days in the tray, it still hears of a new version.
    if (!smoke) setInterval(() => { void notifyUpdate(); }, UPDATE_EVERY);
    const smokeServer = process.argv.find(v => v.startsWith('--smoke-server='));
    if (smoke && smokeServer) connect(smokeServer.slice(15)).catch(error => { console.error(error); app.exit(1); });
  });
  app.on('window-all-closed', () => { if (!connecting) app.quit(); });
  app.on('before-quit', () => { quitting = true; runner?.stopAll(); gateway?.close(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
