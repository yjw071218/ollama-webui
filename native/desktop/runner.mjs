/*
 * Run a project on this PC from the app, the way Codex does: pick a folder,
 * see what it can run (package.json scripts, Python entry points, ...), start
 * one or several commands, read their output, type into them, stop them, and
 * open the address a dev server prints in the in-app browser.
 *
 * Commands run here, on the PC the app is on -- not on the server, which may
 * be another machine. The page asks over IPC (client-preload.cjs) and main.mjs
 * checks every request comes from the server's page. A folder is run in only
 * after the user has said yes to it once, in a dialog the page cannot draw.
 */
import { ipcMain, dialog, shell, screen } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tr } from './i18n.mjs';
import { createWinEmbed } from './winembed.mjs';

const MAX_CHUNK = 64 * 1024;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:\/[^\s'"`)\]]*)?/gi;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/* What a project opens "in the browser" goes nowhere. BROWSER=none is how
   Node tools (Vite, CRA) are told, but Python's webbrowser -- ComfyUI's
   auto-launch -- takes BROWSER as a command, fails to run "none", and falls
   through to the system browser: Chrome opened on :8188. So on Windows it is
   a tiny script that only prints the address, which the runner then reads
   like any other and shows in the preview. Forward slashes, because Python
   splits the variable with shlex, which eats backslashes. */
let noBrowser = 'none';
if (process.platform === 'win32') {
  try {
    const dir = path.join(os.tmpdir(), 'ollama-webui-runner');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'no-browser.cmd');
    writeFileSync(file, '@echo off\r\nif not "%~1"=="" echo [runner] open: %~1\r\nexit /b 0\r\n');
    if (!/\s/.test(file)) noBrowser = file.replace(/\\/g, '/') + ' %s';
  } catch { /* stays "none" */ }
}

/* "That port is taken", as the usual servers say it: Python (Errno 10048 /
   98, ComfyUI's own line), Node (EADDRINUSE), uvicorn, Vite, Flask... */
const PORT_BUSY = [
  /port\s+(\d{2,5})\s+is\s+(?:already\s+)?in\s+use/i,
  /EADDRINUSE[^\n]*?:(\d{2,5})\b/i,
  /bind on address \(['"][^'"]+['"],\s*(\d{2,5})\)/i,
  /(?:Errno\s*(?:10048|98|48)|address already in use)[^\n]*?[(:,'"\s](\d{2,5})\b/i,
];
export const busyPort = (line) => {
  for (const re of PORT_BUSY) { const m = re.exec(line); if (m) { const n = Number(m[1]); if (n > 0 && n < 65536) return n; } }
  return 0;
};

/* Who is listening on `port`: pid, name, command line and start time. */
async function portOwner(port) {
  if (process.platform !== 'win32') return null;
  const ns = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  let pid = 0;
  for (const line of String(ns.stdout || '').split(/\r?\n/)) {
    const c = line.trim().split(/\s+/);
    // The state is localized ("수신 대기"); a listener is the line whose remote end is :0.
    if (c[0] !== 'TCP' || !c[1].endsWith(':' + port)) continue;
    const n = Number(c[c.length - 1]);
    if (!n) continue;
    if (/:0$/.test(c[2])) { pid = n; break; }
    // No listener row shown (filtered views): the side accepting on that port is the owner.
    if (!pid && /ESTAB/i.test(line)) pid = n;
  }
  if (!pid) return null;
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { @{ name=$p.Name; cmd=$p.CommandLine; started=$p.CreationDate.ToString('o') } | ConvertTo-Json -Compress }`;
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  let info = {};
  try { info = JSON.parse(String(ps.stdout || '').trim() || '{}'); } catch { /* name unknown */ }
  return { pid, port, name: info.name || '', command: info.cmd || '', startedAt: info.started ? Date.parse(info.started) : null };
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

/** What a folder looks like it can run, most likely first. */
export async function inspectProject(dir) {
  const out = { dir, name: path.basename(dir), kind: [], commands: [] };
  const add = (label, command, group) => { if (!out.commands.some(c => c.command === command)) out.commands.push({ label, command, group }); };
  let names = [];
  try { names = await readdir(dir); } catch { throw new Error(tr('폴더를 읽을 수 없습니다.', 'The folder could not be read.')); }
  const has = (n) => names.some(x => x.toLowerCase() === n.toLowerCase());

  if (has('package.json')) {
    out.kind.push('node');
    const pkg = await readJson(path.join(dir, 'package.json')) || {};
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    // Not installed yet: that is the first thing to run.
    if (!has('node_modules')) add(tr('의존성 설치', 'Install dependencies'), `${pm} install`, 'setup');
    const scripts = Object.keys(pkg.scripts || {});
    const order = ['dev', 'start', 'serve', 'preview', 'build', 'test', 'lint'];
    for (const s of [...order.filter(x => scripts.includes(x)), ...scripts.filter(x => !order.includes(x))]) add(s, run(s), 'script');
    add(tr('의존성 설치', 'Install dependencies'), `${pm} install`, 'setup');
  }
  if (has('pyproject.toml') || has('requirements.txt') || names.some(n => n.endsWith('.py'))) {
    out.kind.push('python');
    if (has('requirements.txt')) add(tr('pip 설치', 'pip install'), 'python -m pip install -r requirements.txt', 'setup');
    for (const entry of ['main.py', 'app.py', 'manage.py', 'run.py', 'server.py']) {
      if (!has(entry)) continue;
      add(entry, entry === 'manage.py' ? 'python manage.py runserver' : `python ${entry}`, 'script');
    }
    if (has('pytest.ini') || has('tests') || has('conftest.py')) add('pytest', 'python -m pytest', 'script');
  }
  if (has('Cargo.toml')) { out.kind.push('rust'); add('cargo run', 'cargo run', 'script'); add('cargo test', 'cargo test', 'script'); }
  if (has('go.mod')) { out.kind.push('go'); add('go run .', 'go run .', 'script'); add('go test', 'go test ./...', 'script'); }
  for (const n of names.filter(n => /\.(bat|cmd)$/i.test(n)).slice(0, 6)) add(n, `"${n}"`, 'script');
  if (has('index.html') && !has('package.json')) { out.kind.push('static'); add(tr('정적 서버 (8000)', 'Static server (8000)'), 'python -m http.server 8000', 'script'); }
  if (await exists(path.join(dir, '.git'))) out.git = true;
  return out;
}

/**
 * The runner, bound to the app: `allowed(dir)` / `allow(dir)` remember which
 * folders the user agreed to, `owner()` is the window dialogs belong to,
 * `send(channel, payload)` reaches the page, `valid(event)` is main.mjs's check.
 */
export function createRunner({ valid, owner, send, allowed, allow, openBrowser }) {
  const procs = new Map();

  /* Windows the projects open (winembed.mjs). Every running process is looked
     at once a second; what it shows goes to the page as `runner:windows`, and
     the page says where each one it previews should sit (`runner:place`). */
  const win32 = createWinEmbed();
  const windows = new Map();   // hwnd -> { id, hwnd, title, w, h, embedded, popped }
  const sig = (list) => list.map(w => `${w.hwnd}:${w.title}:${w.w}x${w.h}:${w.popped}`).join('|');
  let polling = null, busy = false;
  const poll = async () => {
    if (!win32) return;
    const live = [...procs.values()].filter(p => !p.finished);
    if (!live.length) { clearInterval(polling); polling = null; return; }
    for (const p of live) {
      if (p.shellGone) {
        if (p.jobReady && (await win32.alive(p.child.pid)) === 0) { p.finish?.(); continue; }
      } else {
        for (const pid of await win32.pids(p.child.pid)) p.seen.add(pid);
      }
      const keep = [...windows.values()].filter(w => w.id === p.id).map(w => w.hwnd);
      const found = await win32.scan(p.child.pid, keep);
      if (p.finished || p.stopping) continue;
      for (const w of found) {
        const known = windows.get(w.hwnd);
        // Its own size is remembered from before it was taken in; afterwards the client rect is ours.
        if (known) { known.title = w.title || known.title; if (!known.embedded) { known.w = w.w; known.h = w.h; } }
        else { const fresh = { id: p.id, hwnd: w.hwnd, title: w.title, w: w.w, h: w.h, embedded: false, popped: false }; windows.set(w.hwnd, fresh); await takeIn(fresh); }
      }
      const alive = new Set(found.map(w => w.hwnd));
      for (const [h, w] of windows) if (w.id === p.id && !alive.has(h) && !w.popped) windows.delete(h);
      const list = [...windows.values()].filter(w => w.id === p.id).map(({ hwnd, title, w, h, popped }) => ({ hwnd, title, w, h, popped }));
      if (sig(list) !== p.windowSig) { p.windowSig = sig(list); send('runner:windows', { id: p.id, windows: list }); }
    }
  };
  const startPolling = () => { if (win32 && !polling) polling = setInterval(() => { if (!busy) { busy = true; poll().finally(() => { busy = false; }); } }, 400); };
  /* Taken in the moment it is found, and kept out of sight until the page
     asks for it: a window left on the desktop until its tab was clicked was a
     pop-up over everything, for every window but the one being previewed. */
  const takeIn = async (w) => {
    if (w.embedded || w.popped) return;
    const host = owner();
    if (!host || host.isDestroyed()) return;
    const handle = host.getNativeWindowHandle();
    const parent = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    if (await win32.embed(w.hwnd, parent.toString()) !== 'ok') throw new Error('Window embedding failed');
    w.embedded = true;
    await win32.hide(w.hwnd);
  };
  const forgetWindows = (id) => { for (const [h, w] of windows) if (w.id === id) windows.delete(h); };
  let seq = 0;

  // IPC resolves only after the entire job is empty. Failures stay stoppable.
  const kill = async (p) => {
    if (!p || p.finished) return;
    if (p.stopPromise) return p.stopPromise;
    p.stopPromise = (async () => {
      p.stopping = true;
      try {
        if (win32) {
          await p.setup;
          if (!p.jobReady || !(await win32.kill(p.child.pid))) {
            throw new Error(tr('백그라운드 프로세스 종료를 확인하지 못했습니다. 다시 중지해 주세요.', 'Could not verify background process termination. Please retry Stop.'));
          }
        } else {
          process.kill(-p.child.pid, 'SIGTERM');
        }
        p.code = 1;
        p.finish();
      } catch (error) {
        send('runner:output', { id: p.id, stream: 'stderr', text: `\n${error.message}\n` });
        throw error;
      } finally { p.stopping = false; p.stopPromise = null; }
    })();
    return p.stopPromise;
  };

  const confirmFolder = async (dir) => {
    if (allowed(dir)) return true;
    const result = await dialog.showMessageBox(owner(), {
      type: 'warning',
      title: tr('프로젝트 실행 허용', 'Allow running a project'),
      message: tr('이 폴더에서 명령을 실행하도록 허용할까요?', 'Allow commands to run in this folder?'),
      detail: dir + '\n\n' + tr('명령은 이 PC에서 사용자 권한으로 실행됩니다. 믿을 수 있는 프로젝트만 허용하세요.', 'Commands run on this PC with your permissions. Only allow projects you trust.'),
      buttons: [tr('취소', 'Cancel'), tr('허용', 'Allow')], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    allow(dir);
    return true;
  };

  const guard = (fn) => async (event, ...args) => {
    if (!valid(event)) throw new Error('Forbidden');
    return fn(...args);
  };
  const folderOf = async (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(tr('폴더를 고르세요.', 'Choose a folder.'));
    const dir = path.resolve(value.trim().replace(/^"(.*)"$/, '$1'));
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) throw new Error(tr('폴더가 없습니다: ', 'No such folder: ') + dir);
    return dir;
  };

  ipcMain.handle('runner:pick', guard(async () => {
    const r = await dialog.showOpenDialog(owner(), { title: tr('프로젝트 폴더', 'Project folder'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }));
  ipcMain.handle('runner:inspect', guard(async (dir) => inspectProject(await folderOf(dir))));
  ipcMain.handle('runner:list', guard(async () => [...procs.values()].map(p => ({ id: p.id, cwd: p.cwd, command: p.command, startedAt: p.startedAt, exited: p.exited, code: p.code }))));
  ipcMain.handle('runner:start', guard(async ({ cwd, command } = {}) => {
    const dir = await folderOf(cwd);
    const cmd = String(command || '').trim();
    if (!cmd || cmd.length > 4000) throw new Error(tr('명령을 입력하세요.', 'Enter a command.'));
    if (!(await confirmFolder(dir))) return null;
    const id = `run-${Date.now().toString(36)}-${++seq}`;
    /* The command waits at a gate -- one line read from stdin -- until the
       shell is inside its job, so nothing it starts can be born outside it. */
    const gated = win32 ? `set /p RUNNER_GATE= & ${cmd}` : cmd;
    const child = spawn(gated, {
      cwd: dir, shell: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : true,
      windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', BROWSER: noBrowser },
    });
    const p = { id, child, cwd: dir, command: cmd, startedAt: Date.now(), exited: false, finished: false, code: null, urls: new Set(), seen: new Set() };
    procs.set(id, p);
    const decoder = new TextDecoder('utf-8');
    const onData = (stream) => (buf) => {
      let text = decoder.decode(buf, { stream: true });
      if (text.length > MAX_CHUNK) text = text.slice(-MAX_CHUNK);
      send('runner:output', { id, stream, text });
      // Buffered output may arrive after Stop; it must not reopen a preview.
      if (p.finished || p.stopping) return;
      for (const m of text.replace(ANSI, '').matchAll(URL_RE)) {
        const url = m[0].replace(/0\.0\.0\.0|\[::1?\]/, 'localhost').replace(/[.,;:]+$/, '');
        if (!p.urls.has(url)) { p.urls.add(url); send('runner:url', { id, url }); }
      }
      /* The port this run wanted is someone else's. Say who, once per port,
         and whether it is one of ours or something started outside the
         Run tab (an old ComfyUI left from before, for instance). */
      for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
        const port = busyPort(line);
        if (!port || p.conflicts?.has(port)) continue;
        (p.conflicts ||= new Set()).add(port);
        void portOwner(port).then((holder) => {
          if (!holder) return;
          const mine = [...procs.values()].find(o => o.id !== id && !o.finished && (o.seen?.has(String(holder.pid)) || o.child.pid === holder.pid));
          send('runner:conflict', { id, ...holder, ownerRun: mine ? { id: mine.id, command: mine.command } : null });
        }).catch(() => {});
      }
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    child.on('error', (e) => send('runner:output', { id, stream: 'stderr', text: `\n${e.message}\n` }));
    const finish = () => {
      if (p.finished) return;
      p.finished = true; p.exited = true;
      send('runner:exit', { id, code: p.code });
      forgetWindows(id); p.windowSig = ''; send('runner:windows', { id, windows: [] });
    };
    p.finish = finish;
    child.on('exit', async (code, signal) => {
      p.code = code ?? (signal ? -1 : 0);
      p.shellGone = true;
      /* The shell is done, but what it started may not be (start.bat that
         launches pythonw and returns). Still running, then, and still
         stoppable -- the poll below finishes it when the job is empty. */
      if (win32 && (!p.jobReady || (await win32.alive(child.pid)) !== 0)) {
        send('runner:output', { id, stream: 'stdout', text: `\n${tr('[셸은 끝났지만 백그라운드 프로세스가 아직 실행 중입니다. 중지하면 모두 종료됩니다.]', '[The shell is done, but background processes are still running. Stop ends them all.]')}\n` });
        return;
      }
      finish();
    });
    // Fail closed: an untracked command must never pass the launch gate.
    p.setup = (async () => {
      if (win32) {
        p.jobReady = await win32.job(child.pid);
        if (!p.jobReady) {
          child.kill();
          p.code = -1;
          finish();
          throw new Error(tr('프로세스 종료 관리 설정에 실패하여 실행을 취소했습니다.', 'Run cancelled: process supervision could not be initialized.'));
        }
        child.stdin.write('ready\n');
      }
    })();
    await p.setup;
    startPolling();
    return { id, cwd: dir, command: cmd, startedAt: p.startedAt };
  }));
  ipcMain.handle('runner:input', guard(async (id, text) => {
    const p = procs.get(id);
    if (!p || p.exited || p.shellGone || typeof text !== 'string') return false;
    p.child.stdin.write(text);
    return true;
  }));
  ipcMain.handle('runner:stop', guard(async (id) => { await kill(procs.get(id)); return true; }));
  ipcMain.handle('runner:forget', guard(async (id) => { const p = procs.get(id); if (p) { await kill(p); procs.delete(id); } forgetWindows(id); return true; }));
  ipcMain.handle('runner:openFolder', guard(async (dir) => { await shell.openPath(await folderOf(dir)); return true; }));
  /* Where the page wants a window: `rect` in the page's CSS pixels, or null
     to put it away (another screen chosen, the workspace left, a menu over it). */
  ipcMain.handle('runner:place', guard(async (hwnd, rect) => {
    const w = windows.get(String(hwnd));
    if (!win32 || !w || w.popped) return false;
    const host = owner();
    if (!host || host.isDestroyed()) return false;
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || host.isMinimized()) { if (w.embedded) await win32.hide(w.hwnd); return true; }
    if (!w.embedded) await takeIn(w);
    const zoom = host.clientContents?.getZoomFactor?.() || 1;
    const scale = screen.getDisplayMatching(host.getBounds()).scaleFactor || 1;
    const top = host.isFullScreen() ? 0 : 44;
    const X = (rect.x * zoom) * scale, Y = (top + rect.y * zoom) * scale;
    const W = rect.width * zoom * scale, H = rect.height * zoom * scale;
    /* At its own size, centred, when it fits -- a pygame window draws for the
       size it asked for and does not stretch. Shrunk, keeping its shape, when
       it does not; or stretched when the page asks to fill. */
    let w2 = w.w, h2 = w.h;
    if (rect.fill || !(w2 > 0 && h2 > 0)) { w2 = W; h2 = H; }
    else if (w2 > W || h2 > H) { const k = Math.min(W / w2, H / h2); w2 *= k; h2 *= k; }
    const left = Math.round(X + (W - w2) / 2), upper = Math.round(Y + (H - h2) / 2);
    const regionRect = b => {
      if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
      return [Math.round(b.x * zoom * scale - left), Math.round((top + b.y * zoom) * scale - upper),
        Math.round((b.x + b.width) * zoom * scale - left), Math.round((top + (b.y + b.height) * zoom) * scale - upper)].join(',');
    };
    const clip = regionRect(rect.clip) || `0,0,${Math.round(w2)},${Math.round(h2)}`;
    const cuts = (Array.isArray(rect.cuts) ? rect.cuts.slice(0, 128) : []).map(regionRect).filter(Boolean);
    await win32.place(w.hwnd, left, upper, Math.max(1, Math.round(w2)), Math.max(1, Math.round(h2)), [clip, ...cuts].join(';'));
    if (rect.focus) await win32.focus(w.hwnd);
    return true;
  }));
  // Out into a window of its own again, and back in.
  ipcMain.handle('runner:popout', guard(async (hwnd, out = true) => {
    const w = windows.get(String(hwnd));
    if (!win32 || !w) return false;
    if (out) { if (w.embedded) await win32.release(w.hwnd); w.embedded = false; w.popped = true; }
    else { w.popped = false; await takeIn(w); }
    const p = procs.get(w.id);
    if (p) p.windowSig = '';
    send('runner:windows', { id: w.id, windows: [...windows.values()].filter(v => v.id === w.id).map(({ hwnd, title, w, h, popped }) => ({ hwnd, title, w, h, popped })) });
    return true;
  }));
  /* Ends whatever holds `port`, after the user says so in a dialog the page
     cannot draw -- and only if it still holds it, so a pid reused in the
     meantime is never touched. */
  ipcMain.handle('runner:freePort', guard(async (port, pid) => {
    port = Number(port); pid = Number(pid);
    if (!(port > 0 && port < 65536) || !(pid > 4)) throw new Error('Invalid port');
    const holder = await portOwner(port);
    if (!holder) return true; // already free
    if (holder.pid !== pid) throw new Error(tr('그 사이 다른 프로세스가 포트를 잡았습니다. 다시 실행해 확인해 주세요.', 'Another process took the port meanwhile. Run again to check.'));
    if (holder.pid === process.pid) throw new Error(tr('앱 자신은 종료할 수 없습니다.', 'The app cannot end itself.'));
    const r = await dialog.showMessageBox(owner(), {
      type: 'warning',
      title: tr('포트를 쓰는 프로세스 종료', 'End the process using the port'),
      message: tr(`${port}번 포트를 쓰는 프로세스를 종료할까요?`, `End the process using port ${port}?`),
      detail: `${holder.name || 'PID'} (PID ${holder.pid})\n${holder.command || ''}\n\n` + tr('하위 프로세스도 함께 종료됩니다. 진행 중인 작업은 중단됩니다.', 'Its child processes end too. Work in progress is lost.'),
      buttons: [tr('취소', 'Cancel'), tr('종료', 'End it')], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (r.response !== 1) return false;
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
    for (let i = 0; i < 40; i++) { if (!(await portOwner(port))) return true; await new Promise(res => setTimeout(res, 250)); }
    throw new Error(tr('프로세스를 종료했지만 포트가 아직 사용 중입니다.', 'The process was ended but the port is still in use.'));
  }));
  ipcMain.handle('runner:browse', guard(async (url) => { openBrowser(String(url || '')); return true; }));

  /* On quit the whole tree goes, and the app waits for it: taskkill started
     without waiting was cut off by the app exiting, and a project's server
     lived on with its port and its GPU memory -- the next run then failed
     to bind (Luna on :8000). */
  const stopAllNow = () => {
    for (const p of procs.values()) {
      if (p.finished) continue;
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        else process.kill(-p.child.pid, 'SIGTERM');
      } catch { /* gone */ }
    }
    clearInterval(polling);
    // Closing the helper closes every job handle, and kill-on-close ends what is left.
    win32?.close();
  };
  void win32?.warm?.();
  return { stopAll: stopAllNow };
}
