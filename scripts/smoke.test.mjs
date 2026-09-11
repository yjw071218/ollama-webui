// Does the built app actually start?
//
// This exists because it should have existed three crashes ago. Every one of
// them was the same shape — a `const` read before the line that declares it,
// from a hook's dependency array, which is evaluated during render — and every
// one of them passed `npm run build` and `npm run lint` without a murmur:
//
//   Cannot access 'stopSpeaking' before initialization
//   Cannot access 'isGenerating' before initialization
//   Cannot access 'mcpEnabled' before initialization
//
// `no-undef` does not see them, because the name is defined. `no-use-before-
// define` does not see them either — tested, it reports nothing on the exact
// code that threw. Nothing static catches this class. The only thing that does
// is starting the app, which is what this file does.
//
// It builds, serves `dist/` over http (a file:// page cannot load modules),
// opens it in headless Edge or Chrome, and fails on any uncaught exception, on
// the error boundary appearing, or on the app not rendering anything.
//
// Skipped, loudly, where there is no browser: a machine that cannot run this
// is better told so than silently passed.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
// Not 8188. That is ComfyUI's default port, and this repository now tells people
// to run ComfyUI there — so the old number turned `npm test` into a hard crash
// (EADDRINUSE, no failures reported, exit 1) on any machine where the image
// generator happened to be running. A test port has to be somewhere nothing
// real wants to live.
const HTTP_PORT = 8253;
const CDP_PORT = 9488;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const done = (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(code ?? (fail === 0 ? 0 : 1));
};

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) {
  console.log('SKIP  no Chrome or Edge found; the app was not started');
  done(0);
}

// Build if there is nothing to serve, so the file works on a clean checkout.
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('      dist/ is empty; building first…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: true });
}
check('there is a build to open', fs.existsSync(path.join(DIST, 'index.html')));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // The app talks to Ollama and the dev middleware. Neither is running here,
  // and neither needs to be: what is under test is whether the page boots.
  if (/^\/(api|mcp|localfs|system|tts-api|kakao|studio)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"not running in the smoke test"}');
    return;
  }
  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-smoke-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--force-device-scale-factor=1',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { child.kill(); } catch (e) { /* gone */ }
  try { server.close(); } catch (e) { /* closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
};

let ws;
try {
  const wsUrl = await (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const target = list.find(t => t.type === 'page');
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      } catch (e) { /* not up yet */ }
      await sleep(250);
    }
    throw new Error('the browser never opened a debugging port');
  })();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
} catch (err) {
  check('the browser starts', false, err.message);
  cleanup();
  done();
}

let nextId = 1;
const pending = new Map();
const thrown = [];
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails;
    thrown.push(String(d?.exception?.description || d?.text || '').split('\n')[0].slice(0, 200));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map(a => a.description || a.value).join(' ').split('\n')[0].slice(0, 200));
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(7000);

// Past the sign-in screen as a guest, because the tree that crashed is the one
// behind it — the sign-in screen is a different, much smaller component.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || ''));
  if (b) { b.click(); return 'clicked'; }
  return 'none';
})()`);
await sleep(5000);

const state = JSON.parse(await evaluate(`(() => JSON.stringify({
  crashed: /React Crashed/i.test(document.body.innerText || ''),
  crashText: (document.body.innerText || '').slice(0, 300),
  rootChildren: document.getElementById('root')?.children.length ?? 0,
  hasComposer: !!document.querySelector('.chat-input'),
  hasSidebar: !!document.querySelector('.claude-sidebar'),
  hasHeader: !!document.querySelector('.main-header'),
}))()`) || '{}');

// The error boundary is the loud failure: it means the tree threw during
// render, which is exactly what a temporal dead zone reference does.
check('the app does not hit its error boundary', state.crashed === false,
  state.crashed ? state.crashText : '');

// A TDZ throw at the top of the component leaves the root empty, so this
// catches the same class from the other side.
check('something rendered', state.rootChildren > 0, `root has ${state.rootChildren} children`);
check('the composer is on screen', state.hasComposer === true);
check('the sidebar is on screen', state.hasSidebar === true);
check('the header is on screen', state.hasHeader === true);

/* The surfaces that are not the chat screen.
 *
 * A panel that throws during render is exactly the failure this file was
 * written for, and the error boundary check above cannot see one that only
 * mounts when a button is pressed. The studio is the newest and the largest of
 * them, and here it renders with no backend behind it — which is the state
 * every install starts in, and the one where a missing null check shows up. */
const studio = await evaluate(`(async () => {
  const open = [...document.querySelectorAll('button')]
    .find(b => /studio|스튜디오|スタジオ|工作室|estudio|xưởng|الاستوديو/i.test(b.getAttribute('title') || ''));
  if (!open) return 'no-button';
  open.click();
  await new Promise(r => setTimeout(r, 1200));
  if (/React Crashed/i.test(document.body.innerText || '')) return 'crashed';
  // Either the panel or its "no backend" notice; both mean it rendered.
  return document.querySelector('.studio') ? 'rendered' : 'missing';
})()`);

check('the studio panel opens from the header', studio !== 'no-button', studio);
check('and renders even with no generator running', studio === 'rendered', studio);

// Uncaught exceptions of any kind. Filtered for the ones this environment
// creates on purpose: nothing is serving Ollama or the dev middleware here.
const offline = /Failed to fetch|NetworkError|503|not running in the smoke test|ERR_|gsi|accounts\.google/i;
const real = [...thrown, ...consoleErrors].filter(line => line && !offline.test(line));
check('no uncaught exceptions while starting', real.length === 0, real.slice(0, 4).join('\n      '));

cleanup();
done();
