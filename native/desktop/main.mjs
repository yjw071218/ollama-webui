import { app, BrowserWindow, Menu, ipcMain, session, shell, desktopCapturer } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeServer, startProxy } from './proxy.mjs';
import { createUpdater } from './updater.mjs';
import { loadTrustedPage, kakaoAuthURL } from './navigation.mjs';
import { createClientWindow, chromeOptions } from './chrome.mjs';
import { appDialog } from './dialog.mjs';
import { parseGoogleHandoff, googleAuthorizeUrl, startGoogleLoopback } from './googleLoopback.mjs';
const showError = (title, message) => appDialog(clientWindow && !clientWindow.isDestroyed() ? clientWindow : setupWindow, { title, message });

const directory = path.dirname(fileURLToPath(import.meta.url));
const setupURL = pathToFileURL(path.join(directory, 'setup.html')).href;
const smokeProfile = process.argv.find(value => value.startsWith('--smoke-profile='));
if (process.argv.includes('--native-smoke') && smokeProfile) app.setPath('userData', smokeProfile.slice(16));
let setupWindow, clientWindow, gateway, settings = { server: '', ports: {} }, connecting = false;
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
const sameOrigin = (value, origin) => { try { return new URL(value).origin === origin; } catch { return false; } };
async function external(url, owner) {
  if (!/^https?:\/\//i.test(url)) return;
  const result = await appDialog(owner, { type: 'question', title: '외부 링크', message: '기본 브라우저에서 이 링크를 여시겠습니까?', detail: url, buttons: ['취소', '열기'], defaultId: 0, cancelId: 0 });
  if (result.response === 1) await shell.openExternal(url);
}
let updater = null;
/** In-app update: check, download with progress, verify and install (updater.mjs). */
function notifyUpdate(manual = false) {
  if (process.argv.includes('--native-smoke')) return;
  updater ??= createUpdater({
    ownerWindow: () => (clientWindow && !clientWindow.isDestroyed() ? clientWindow : setupWindow),
    beforeInstall: async () => { await gateway?.close(); },
  });
  return updater.check({ manual });
}
function openSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({ ...chromeOptions, icon: path.join(directory, 'icons/app.png'), show: !process.argv.includes('--native-smoke'), width: 700, height: 650, title: '서버 연결',
    webPreferences: { preload: path.join(directory, 'setup-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  setupWindow.setMenu(null);
  setupWindow.webContents.on('will-navigate', event => event.preventDefault());
  setupWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupWindow.loadURL(setupURL);
}
function validSetup(event) {
  return setupWindow && event.sender === setupWindow.webContents && event.senderFrame === setupWindow.webContents.mainFrame && event.senderFrame.url === setupURL;
}
async function connect(value) {
  if (connecting) throw new Error('연결 중입니다.');
  connecting = true;
  try {
    const server = normalizeServer(value);
    const key = createHash('sha256').update(server).digest('hex');
    const savedPort = settings.ports[key] || 0;
    // Fixed per-server origins preserve IndexedDB and keep different servers isolated.
    if (clientWindow && !clientWindow.isDestroyed()) clientWindow.destroy();
    if (gateway) { await gateway.close(); gateway = undefined; }
    try { gateway = await startProxy(server, savedPort); }
    catch (error) { if (error.code === 'EADDRINUSE') throw new Error('저장된 앱 포트가 사용 중입니다. 다른 앱 인스턴스를 종료한 후 다시 시도하세요.'); throw error; }
    const current = gateway;
    const ses = session.fromPartition('persist:server-' + key);
    const grants = new Set();
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
      const supported = ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'idle-detection', 'speaker-selection'];
      const requestingURL = details.requestingUrl || details.securityOrigin || wc?.getURL();
      if (!trusted(wc, requestingURL) || details.isMainFrame === false || !supported.includes(permission)) { callback(false); return; }
      if (grants.has(permission)) { callback(true); return; }
      const labels = { media: '마이크 / 카메라 (' + (details.mediaTypes || []).join(', ') + ')', notifications: '알림', 'clipboard-read': '클립보드 읽기', 'clipboard-sanitized-write': '클립보드 쓰기', fullscreen: '전체 화면', pointerLock: '마우스 제어' };
      try {
        const result = await appDialog(clientWindow, { type: 'question', title: '권한 요청', message: (labels[permission] || permission) + ' 권한을 허용하시겠습니까?', detail: server + '\n현재 앱 실행 동안만 허용됩니다.', buttons: ['거부', '허용'], defaultId: 0, cancelId: 0 });
        const allowed = result.response === 1 && trusted(wc, requestingURL);
        if (allowed) grants.add(permission);
        callback(allowed);
      } catch { callback(false); }
    });
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (!sameOrigin(request.securityOrigin, current.origin) || request.frame !== clientWindow?.clientContents.mainFrame || !request.userGesture) { callback({}); return; }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const choices = sources.slice(0, 20);
        const result = await appDialog(clientWindow, { type: 'question', title: '화면 캡처', message: '공유할 화면 또는 창을 선택하세요.', detail: server + '\n선택한 화면이 서버에 첨부될 수 있습니다.', buttons: ['취소', ...choices.map(s => s.name)], defaultId: 0, cancelId: 0 });
        const stillTrusted = !winGone() && request.frame === clientWindow.clientContents.mainFrame && sameOrigin(clientWindow.clientContents.getURL(), current.origin);
        callback(stillTrusted && result.response > 0 && choices[result.response - 1] ? { video: choices[result.response - 1] } : {});
      } catch { callback({}); }
    });
    ses.removeAllListeners('will-download');
    ses.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: '파일 저장' }));
    clientWindow = createClientWindow({ icon: path.join(directory, 'icons/app.png'), show: !process.argv.includes('--native-smoke'), width: 1360, height: 900, minWidth: 420, minHeight: 500, title: 'Ollama WebUI Client',
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } }, { server: openSetup, updates: () => notifyUpdate(true), menu: win => Menu.getApplicationMenu()?.popup({window:win}) });
    const win = clientWindow;
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
          else if (/^#kakao:[a-f0-9]{64}$/.test(u.hash))
            void shell.openExternal(server + '/api/auth/native/kakao?id=' + u.hash.slice(7)).catch(() => {});
        }
        return;
      }
      // Kakao login finishes in this window so the state cookie on the app origin matches.
      if (kakaoAuthURL(url)) return;
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
      current.close();
      if (gateway === current) gateway = undefined;
      if (!connecting && !setupWindow?.isVisible()) app.quit();
    });
    settings.server = server;
    settings.ports[key] = current.port;
    await writeFile(configPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
    try { await loadTrustedPage({webContents:win.clientContents,loadURL:win.loadClientURL}, current.origin + '/', current.origin); }
    catch (error) {
      if (!win.isDestroyed()) win.destroy();
      openSetup();
      throw error;
    }
    setupWindow?.close();
    if (process.argv.includes('--native-smoke')) {
      const result = await win.clientContents.executeJavaScript('({secure:isSecureContext,media:!!navigator.mediaDevices?.getUserMedia,clipboard:!!navigator.clipboard,node:typeof process})');
      console.log('NATIVE_SMOKE ' + JSON.stringify(result));
      if (!result.secure || !result.media || !result.clipboard || result.node !== 'undefined') app.exit(1);
      else app.exit(0);
    }
  } finally { connecting = false; }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => (clientWindow || setupWindow)?.focus());
  app.whenReady().then(async () => {
    try { settings = { ...settings, ...JSON.parse(await readFile(configPath(), 'utf8')) }; } catch {}
    ipcMain.handle('connection:current', event => { if (!validSetup(event)) throw new Error('Forbidden'); return settings.server; });
    ipcMain.handle('connection:connect', (event, value) => { if (!validSetup(event) || typeof value !== 'string') throw new Error('Forbidden'); return connect(value); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '앱', submenu: [{ label: '서버 주소 변경', click: openSetup }, { label: '업데이트 확인', click: () => notifyUpdate(true) }, { label: '권한 초기화 / 다시 연결', click: () => settings.server && connect(settings.server).catch(e => showError('연결 실패', e.message)) }, { type: 'separator' }, { role: 'quit', label: '종료' }] },
      { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '보기', submenu: [{ label: '새로고침', accelerator: 'CmdOrCtrl+R', click: () => clientWindow?.clientContents?.reload() }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    ]));
    if (settings.server && !process.argv.includes('--native-smoke')) {
      try { await connect(settings.server); }
      catch (error) { openSetup(); showError('연결 실패', error.message); }
    } else openSetup();
    void notifyUpdate();
    const smoke = process.argv.find(v => v.startsWith('--smoke-server='));
    if (process.argv.includes('--native-smoke') && smoke) connect(smoke.slice(15)).catch(error => { console.error(error); app.exit(1); });
  });
  app.on('window-all-closed', () => { if (!connecting) app.quit(); });
  app.on('before-quit', () => gateway?.close());
}
