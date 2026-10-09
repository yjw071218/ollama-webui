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
import { ipcMain, dialog, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { tr } from './i18n.mjs';

const MAX_CHUNK = 64 * 1024;
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\d+\.\d+\.\d+\.\d+)(?::\d+)?(?:\/[^\s'"`)\]]*)?/gi;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

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
  let seq = 0;

  const kill = (p) => {
    if (!p || p.exited) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-p.child.pid, 'SIGTERM');
    } catch { try { p.child.kill(); } catch { /* gone */ } }
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
    const child = spawn(cmd, {
      cwd: dir, shell: process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : true,
      windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '1', CLICOLOR_FORCE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', BROWSER: 'none' },
    });
    const p = { id, child, cwd: dir, command: cmd, startedAt: Date.now(), exited: false, code: null, urls: new Set() };
    procs.set(id, p);
    const decoder = new TextDecoder('utf-8');
    const onData = (stream) => (buf) => {
      let text = decoder.decode(buf, { stream: true });
      if (text.length > MAX_CHUNK) text = text.slice(-MAX_CHUNK);
      send('runner:output', { id, stream, text });
      for (const m of text.replace(ANSI, '').matchAll(URL_RE)) {
        const url = m[0].replace(/0\.0\.0\.0|\[::1?\]/, 'localhost').replace(/[.,;:]+$/, '');
        if (!p.urls.has(url)) { p.urls.add(url); send('runner:url', { id, url }); }
      }
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    child.on('error', (e) => send('runner:output', { id, stream: 'stderr', text: `\n${e.message}\n` }));
    child.on('exit', (code, signal) => {
      p.exited = true; p.code = code ?? (signal ? -1 : 0);
      send('runner:exit', { id, code: p.code });
    });
    return { id, cwd: dir, command: cmd, startedAt: p.startedAt };
  }));
  ipcMain.handle('runner:input', guard(async (id, text) => {
    const p = procs.get(id);
    if (!p || p.exited || typeof text !== 'string') return false;
    p.child.stdin.write(text);
    return true;
  }));
  ipcMain.handle('runner:stop', guard(async (id) => { kill(procs.get(id)); return true; }));
  ipcMain.handle('runner:forget', guard(async (id) => { const p = procs.get(id); if (p) { kill(p); procs.delete(id); } return true; }));
  ipcMain.handle('runner:openFolder', guard(async (dir) => { await shell.openPath(await folderOf(dir)); return true; }));
  ipcMain.handle('runner:browse', guard(async (url) => { openBrowser(String(url || '')); return true; }));

  return { stopAll: () => { for (const p of procs.values()) kill(p); } };
}
