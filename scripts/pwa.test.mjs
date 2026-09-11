// What the service worker is allowed to cache, and what it must never touch.
//
// A worker sits in front of every request the page makes, so the interesting
// question is not whether it caches well but whether it caches the wrong
// thing. A cached model reply, session lookup, directory listing or search
// result is not stale data — it is a wrong answer served confidently, from a
// layer the page cannot see, that survives a reload. That failure would look
// like the app lying, and it would be very hard to trace.
//
// So the worker is loaded here in a fake worker global, and its own fetch
// handler is asked, request by request, what it intends to do. Nothing is
// mocked at the routing level: the real `install`, `activate` and `fetch`
// listeners run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ the manifest */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));

// `display: standalone` is the whole point: it is what removes the address bar
// and makes the installed copy read as an app rather than as a bookmark.
eq('the app installs standalone', manifest.display, 'standalone');
// A scope narrower than the app means a navigation inside it leaves the
// installed window and reopens in a browser tab.
eq('the scope covers the whole app', manifest.scope, '/');
check('there is an icon to install with', Array.isArray(manifest.icons) && manifest.icons.length > 0);

// Android crops an icon to whatever shape the launcher uses. Without a
// maskable one it crops the ordinary icon, and the corners of the artwork go
// with it.
check('one icon is maskable',
  manifest.icons.some(i => (i.purpose || '').split(/\s+/).includes('maskable')));

for (const icon of manifest.icons) {
  const file = path.join(ROOT, 'public', icon.src.replace(/^\//, ''));
  check(`the icon ${icon.src} exists`, fs.existsSync(file));
}

// The shortcut is half a feature: the other half is the `?new=1` handler in
// App.jsx, and a shortcut pointing somewhere that handler does not read is a
// launcher entry that silently opens the last chat instead.
check('the New chat shortcut asks for a new chat',
  (manifest.shortcuts || []).some(s => s.url.includes('new=1')),
  JSON.stringify(manifest.shortcuts));

/* -------------------------------------------- index.html points at the manifest */

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
check('index.html links the manifest', /rel="manifest"[^>]*manifest\.webmanifest/.test(html));
// iOS reads none of the manifest for this; without its own key an app added
// to the home screen opens with the browser chrome still on it.
check('iOS is told it is an app', /apple-mobile-web-app-capable"\s+content="yes"/.test(html));

/* ------------------------------------------ the worker, in a fake worker global */

// Just enough of the Cache API to answer the worker honestly. Nothing here
// pretends to store anything: what is under test is which request goes down
// which path, so the caches only need to say "I do not have that".
const emptyCache = {
  match: async () => undefined,
  put: async () => {},
  add: async () => {},
};

const listeners = {};
const fetched = [];

const self = {
  location: { origin: 'http://localhost:5173' },
  registration: { navigationPreload: { enable: async () => {} } },
  clients: { claim: async () => {} },
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  skipWaiting: () => { self.skipped = true; },
  skipped: false,
};

globalThis.self = self;
globalThis.caches = {
  open: async () => emptyCache,
  keys: async () => [],
  delete: async () => true,
  match: async () => undefined,
};
globalThis.fetch = async (request) => {
  fetched.push(typeof request === 'string' ? request : request.url);
  return { ok: true, type: 'basic', clone: () => ({}) };
};
globalThis.Request = class { constructor(url) { this.url = url; } };

await import(path.join(ROOT, 'public/sw.js').replace(/\\/g, '/').replace(/^/, 'file:///'));

check('the worker registers a fetch handler', (listeners.fetch || []).length === 1);
check('and an install and an activate handler',
  (listeners.install || []).length === 1 && (listeners.activate || []).length === 1);

// Asks the worker what it would do with one request. `respondWith` being
// called at all is the answer: an untouched request is one the worker declined
// to handle, which is the same as it not being installed.
const routeOf = (url, { mode = 'no-cors', method = 'GET' } = {}) => {
  let handled = false;
  listeners.fetch[0]({
    request: { url, method, mode },
    preloadResponse: Promise.resolve(undefined),
    respondWith: () => { handled = true; },
  });
  return handled;
};

const ORIGIN = 'http://localhost:5173';

/* ---- what must never be cached ---- */

// Every one of these has an answer that depends on being asked now. A cached
// one is not slow or stale; it is wrong.
for (const [what, url] of [
  ['a model reply', `${ORIGIN}/api/chat`],
  ['the model list', `${ORIGIN}/api/tags`],
  ['who is signed in', `${ORIGIN}/api/auth/session`],
  ['a web search', `${ORIGIN}/mcp/search`],
  ['a file on disk', `${ORIGIN}/localfs/read`],
  ['a live CPU reading', `${ORIGIN}/system/stats`],
  ['a voice synthesis', `${ORIGIN}/tts-api/tts`],
  ['an OAuth code exchange', `${ORIGIN}/kakao/callback`],
]) {
  eq(`${what} is passed straight through`, routeOf(url), false);
}

// A worker sees the writes too, and a cache has no safe answer for one.
eq('a POST is never handled', routeOf(`${ORIGIN}/index.html`, { method: 'POST' }), false);

// Another origin's answer is not ours to decide a lifetime for.
eq('another origin is left alone', routeOf('https://accounts.google.com/gsi/client'), false);

/* ---- what the shell is ---- */

eq('a navigation is handled', routeOf(`${ORIGIN}/`, { mode: 'navigate' }), true);
eq('a hashed build asset is handled', routeOf(`${ORIGIN}/assets/index-BUBDFSHy.js`), true);
eq('so is a hashed stylesheet', routeOf(`${ORIGIN}/assets/index-C5mm9g52.css`), true);
eq('and a hashed font', routeOf(`${ORIGIN}/assets/KaTeX_Main-Regular-B22Nviop.woff2`), true);
eq('the icon is handled', routeOf(`${ORIGIN}/favicon.svg`), true);
eq('and the manifest', routeOf(`${ORIGIN}/manifest.webmanifest`), true);

// Nothing in dist/ is named this way, and treating an unhashed path as
// immutable is how a file that does change gets frozen.
eq('an unhashed asset path is not treated as immutable',
  routeOf(`${ORIGIN}/assets/vendor.js`), false);

/* ---- taking over ---- */

// A worker that calls skipWaiting on install swaps the build out mid-session,
// so the next lazily-loaded chunk comes from a different build than the code
// asking for it. It waits to be asked instead, and this is the asking.
listeners.message[0]({ data: { type: 'SKIP_WAITING' } });
check('the page can ask the new worker to take over', self.skipped === true);

self.skipped = false;
listeners.message[0]({ data: { type: 'something-else' } });
check('and nothing else can', self.skipped === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
