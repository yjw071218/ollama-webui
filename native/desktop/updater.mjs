import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { tr } from './i18n.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkUpdate, downloadUpdate, portableScript, encodePowerShell } from './updates.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const pageURL = pathToFileURL(path.join(root, 'update.html')).href;

/** How this copy was installed decides how it replaces itself. */
export function installKind(env = process.env, packaged = app.isPackaged) {
  if (env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  return packaged ? 'setup' : 'dev';
}

export function createUpdater({ ownerWindow, beforeInstall = async () => {} }) {
  const kind = installKind();
  const stateFile = () => path.join(app.getPath('userData'), 'update.json');
  const dir = () => path.join(app.getPath('temp'), 'OllamaWebUI-Update');
  let win = null, update = null, controller = null, ready = null, quitting = false;
  let state = { phase: 'idle' };
  let offered = '';

  const prefs = async () => { try { return JSON.parse(await readFile(stateFile(), 'utf8')); } catch { return {}; } };
  const savePrefs = async (value) => writeFile(stateFile(), JSON.stringify(value), { mode: 0o600 }).catch(() => {});

  const send = (patch) => {
    state = { ...state, ...patch };
    if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
  };
  const valid = (event) => win && !win.isDestroyed() && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === pageURL;

  /* Always over the app. Its parent is whatever window is the app *now*: a
     check at start-up can open it while only the server window exists, and
     a window owned by that one fell behind the client as soon as it opened.
     With no app window at all it stays on top on its own. */
  const attach = () => {
    if (!win || win.isDestroyed()) return;
    const owner = ownerWindow();
    const live = owner && !owner.isDestroyed() ? owner : null;
    if (win.getParentWindow() !== live) { try { win.setParentWindow(live); } catch { /* closing */ } }
    win.setAlwaysOnTop(!live);
    if (live && win.isVisible()) { win.moveTop(); }
  };
  const open = () => {
    if (win && !win.isDestroyed()) { attach(); win.show(); win.focus(); return; }
    const owner = ownerWindow();
    win = new BrowserWindow({
      parent: owner && !owner.isDestroyed() ? owner : undefined, modal: false, show: false, frame: false,
      width: 560, height: 560, minWidth: 420, minHeight: 420, resizable: true, backgroundColor: '#292620',
      title: tr('업데이트', 'Update'), icon: path.join(root, 'icons/app.png'),
      webPreferences: { preload: path.join(root, 'update-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenu(null);
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('ready-to-show', () => { attach(); win.show(); });
    win.on('closed', () => { win = null; });
    win.loadURL(pageURL);
  };

  const describe = (u) => ({
    version: u.version, current: app.getVersion(), notes: u.notes, size: u.asset.size,
    publishedAt: u.publishedAt, kind,
  });

  /** Check GitHub; open the window when there is news or when asked. */
  const check = async ({ manual = false } = {}) => {
    if (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'installing') { if (manual) open(); return; }
    if (manual) { open(); send({ phase: 'checking', error: '' }); }
    try {
      const found = await checkUpdate(app.getVersion(), fetch, kind === 'portable' ? 'portable' : 'windows');
      if (!found) { if (manual) send({ phase: 'latest', current: app.getVersion() }); return; }
      if (!manual && (await prefs()).skipped === found.version) return;
      // The periodic check (main.mjs) offers a version once a run; "later" means later.
      if (!manual && offered === found.version) return;
      offered = found.version;
      update = found;
      open();
      send({ phase: 'available', error: '', info: describe(found) });
    } catch (error) {
      if (manual) send({ phase: 'error', error: tr('업데이트를 확인하지 못했습니다. 네트워크 연결 또는 GitHub 요청 제한을 확인하세요.', 'Could not check for updates. Check the network, or the GitHub request limit.'), detail: error.message });
    }
  };

  const download = async () => {
    if (!update || state.phase === 'downloading') return;
    if (kind === 'dev') { await shell.openExternal(update.url); return; }
    controller = new AbortController();
    send({ phase: 'downloading', error: '', progress: { received: 0, total: update.asset.size, percent: 0, bytesPerSecond: 0 } });
    try {
      await mkdir(dir(), { recursive: true });
      let last = 0;
      const file = await downloadUpdate(update, path.join(dir(), update.asset.name), {
        signal: controller.signal,
        onProgress: (p) => { const t = Date.now(); if (t - last > 120 || p.received === p.total) { last = t; send({ progress: p }); } },
      });
      ready = { ...file, version: update.version };
      send({ phase: 'ready', progress: { ...state.progress, percent: 100 } });
    } catch (error) {
      if (controller?.signal.aborted) send({ phase: 'available', error: '', progress: null });
      else send({ phase: 'error', error: tr('다운로드하지 못했습니다.', 'The download failed.'), detail: error.message });
    } finally { controller = null; }
  };

  /* Synchronous on purpose: at exit there is no later tick to finish in. */
  const launch = (relaunch) => {
    if (!ready) return;
    if (kind === 'portable') {
      const target = process.env.PORTABLE_EXECUTABLE_FILE;
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShell(portableScript(ready.path, target, relaunch))],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else {
      // electron-builder's NSIS installer: silent, into the existing install, then start it.
      const args = ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])];
      spawn(ready.path, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
    ready = null;
    quitting = true;
  };
  /** Hand over to the new version now, and start it again. */
  const install = async () => {
    if (!ready) return;
    send({ phase: 'installing' });
    await beforeInstall();
    launch(true);
    app.quit();
  };

  ipcMain.on('update:ready', (event) => { if (valid(event)) event.sender.send('update:state', state); });
  ipcMain.on('update:action', async (event, action) => {
    if (!valid(event)) return;
    if (action === 'download' || action === 'retry') { if (update) download(); else check({ manual: true }); }
    else if (action === 'cancel') controller?.abort();
    else if (action === 'install') install().catch(error => send({ phase: 'error', error: tr('설치를 시작하지 못했습니다.', 'The installer did not start.'), detail: error.message }));
    else if (action === 'skip' && update) { await savePrefs({ ...(await prefs()), skipped: update.version }); win?.close(); }
    else if (action === 'release') shell.openExternal(update?.url || 'https://github.com/yjw071218/ollama-webui/releases');
    else if (action === 'later' || action === 'close') win?.close();
  });

  // Downloaded but put off: installed quietly when the app closes, not relaunched.
  app.on('will-quit', () => { if (ready && !quitting) { try { launch(false); } catch { /* next launch offers it again */ } } });
  // A previous run's leftovers.
  rm(dir(), { recursive: true, force: true }).catch(() => {});

  return { check, open, attach, get state() { return state; } };
}
