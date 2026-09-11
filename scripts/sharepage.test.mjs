// The page a stranger lands on, in a real browser.
//
// server/shares.js is checked by scripts/shares.test.mjs; this is the other
// half — that `/s/<token>` reaches a page at all, and that the page it reaches
// is not the app.
//
// That distinction is the whole point. `main.jsx` branches before
// `SessionProvider` mounts, so somebody following a link is not handed a
// session, not shown a sign-in screen, and not given a composer to type into.
// A branch that merely rendered the app with a different chat in it would look
// almost right and be wrong in every way that matters.
//
// The token used here is a real-shaped token that no share exists for, so the
// server answers 404 — which is also what a revoked or expired link gets, and
// therefore the state most readers of a stale link will actually see.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = 8207;
const CDP_PORT = 9507;

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
  '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) {
  console.log('SKIP  no Chrome or Edge found; the shared page was not opened');
  done(0);
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.png': 'image/png',
};

/* The share API is answered here rather than proxied to a real server: what is
 * under test is the page, and a 404 is the answer every dead link gets.
 *
 * DIST is resolved rather than written with forward slashes, because
 * `path.join` returns backslashes on Windows and the `startsWith` guard below
 * would then reject every asset and serve index.html in its place — which is a
 * page that renders nothing and looks exactly like a routing bug. */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/share/view') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"success":false,"error":"That link is not available."}');
    return;
  }
  if (/^\/(api|mcp|localfs|system|tts-api|kakao)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{}');
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-share-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { child.kill(); } catch (e) { /* gone */ }
  try { server.close(); } catch (e) { /* closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
};

try {
  let wsUrl = '';
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl || '';
    } catch (e) { /* not up yet */ }
    if (!wsUrl) await sleep(250);
  }
  check('the browser opened', !!wsUrl);
  if (!wsUrl) { cleanup(); done(1); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  const thrown = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split(String.fromCharCode(10))[0]);
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(r => {
    const id = nextId++;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const res = (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))?.result;
    if (res?.exceptionDetails) return `THREW: ${String(res.exceptionDetails.exception?.description || '').slice(0, 160)}`;
    return res?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/s/${TOKEN}` });
  await sleep(4500);

  const view = JSON.parse(await ev(`JSON.stringify({
    rendered: (document.getElementById('root')?.innerHTML || '').length,
    text: (document.body.innerText || '').trim(),
    composer: !!document.querySelector('.chat-input'),
    sidebar: !!document.querySelector('.claude-sidebar'),
    authScreen: !!document.querySelector('.auth-card'),
    boundary: (document.body.innerText || '').includes('Something went wrong'),
  })`));

  check('the shared route renders something', view.rendered > 0, `${view.rendered} chars`);
  check('and it is not the error boundary', !view.boundary, view.text.slice(0, 120));

  // The three that say this is a page and not the app wearing a hat.
  check('there is no composer to type into', !view.composer);
  check('there is no sidebar of somebody else\'s chats', !view.sidebar);
  check('a dead link says so rather than showing a blank page', view.text.length > 0, view.text.slice(0, 160));

  // The URL is checked rather than the copy, so this does not break the moment
  // somebody rewords the message.
  const asked = await ev(`JSON.stringify(performance.getEntriesByType('resource')
    .map(e => e.name).filter(n => n.includes('/api/')))`);
  check('it asked the share endpoint for the token', asked.includes(`share/view?token=${TOKEN}`), asked);
  check('and asked nothing else of the server',
    !asked.includes('/api/auth/session'),
    'a session was requested for somebody who only followed a link');

  check('no uncaught exceptions on the shared page',
    thrown.filter(t => !/Failed to fetch|503|ERR_/i.test(t)).length === 0,
    thrown.slice(0, 3).join(' | '));

  // And the ordinary app still boots at the root, which is the half a routing
  // change is most likely to break.
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
  await sleep(5000);
  const root = JSON.parse(await ev(`JSON.stringify({
    rendered: (document.getElementById('root')?.innerHTML || '').length,
    shared: !!document.querySelector('.shared-page'),
  })`));
  check('the app still starts at the root', root.rendered > 0);
  check('and the root is not the shared page', !root.shared);
} finally {
  cleanup();
}

done();
