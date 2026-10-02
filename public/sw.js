/* Offline shell for the app, and nothing else.
 *
 * What this is for: a phone that has the app on its home screen and no network
 * — or, far more often, a phone whose network is bad enough that the browser
 * spends four seconds deciding it is. Without a worker that is a blank page,
 * because every byte of the app comes off the server. With one it is the app,
 * open on the last chat, saying it cannot reach Ollama. Those are very
 * different failures to be looking at.
 *
 * What this deliberately does NOT do is cache anything with an answer in it.
 * A model reply, a session lookup, a directory listing and a search result are
 * all things whose correctness depends on being asked *now*; a cached one is
 * not stale data, it is a wrong answer served confidently. So the worker is
 * scoped to the shell — the HTML, the hashed bundles, the fonts and the icons
 * — and every request that carries meaning is passed straight through as if
 * the worker were not installed.
 *
 * Two cache strategies, chosen by what breaks when they are wrong:
 *
 *   * Navigations are network-first. The shell is small and the fallback only
 *     matters when the network is gone, so paying a round trip to be certain
 *     the app is current is the right trade — and it means a rebuild is picked
 *     up on the next load rather than whenever the worker feels like it.
 *   * Hashed build assets are cache-first. Their names change when their
 *     contents do, so a cached one can never be the wrong version, and
 *     re-fetching it is pure latency.
 */

// Bump to invalidate everything this worker has stored. The caches are named
// after it, so the activate handler below deletes the previous generation.
const VERSION = 'v2';

/* A digest of the unhashed files below, which is not the same job as VERSION.
 *
 * The icons and the manifest are the only things here whose names do not
 * change when their contents do — build assets carry a hash, so a new one is a
 * new URL and can never be served stale. These cannot, and the consequence
 * showed up as "the tab still has the old lightning bolt on it": the icons had
 * been redrawn, the build was correct, and this worker went on handing out the
 * copy it had kept.
 *
 * Remembering to bump VERSION is exactly the kind of step that gets forgotten,
 * so it is not left to memory. `scripts/logo.test.mjs` recomputes this digest
 * from the files and fails if it disagrees, which makes changing an icon
 * without invalidating the cache impossible to do quietly.
 */
const ICONS_REV = '920c86fa';

const SHELL_CACHE = `webui-shell-${VERSION}-${ICONS_REV}`;
const ASSET_CACHE = `webui-assets-${VERSION}`;

const SHELL_URL = '/index.html';

// Everything the dev server and the backend answer themselves. These are the
// requests that must never come out of a cache: `/api` is Ollama, `/mcp` is
// web search and page fetching, `/localfs` is the disk, `/system` is a live
// reading, and `/kakao` is half of an OAuth exchange whose whole point is that
// it happens once.
const PASS_THROUGH = [
  /^\/risuai(?:\/|$)/,
  /^\/api\//, /^\/api$/,
  /^\/mcp\//, /^\/localfs\//, /^\/system\//, /^\/tts-api\//, /^\/kakao\//,
];

const isPassThrough = (pathname) => PASS_THROUGH.some(re => re.test(pathname));

// Vite emits `/assets/<name>-<hash>.<ext>`. The hash is the point: a file
// whose name contains a digest of its contents is safe to keep forever,
// because a change produces a different name rather than different bytes.
const isHashedAsset = (pathname) => /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(pathname);

// The handful of unhashed files the shell needs to paint: the icons and the
// manifest. Worth caching, not worth trusting forever, so they are refreshed
// in the background after being served.
const isShellExtra = (pathname) =>
  pathname === '/favicon.svg'
  || pathname === '/icon-maskable.svg'
  || pathname === '/icons.svg'
  || pathname === '/manifest.webmanifest';

self.addEventListener('install', (event) => {
  // Only the shell is precached. Nothing else can be: the asset names are
  // decided by the build and are not knowable from here.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      // A failed precache must not fail the install, or a worker can never
      // take over on a machine that happened to be offline at the wrong
      // moment — and a worker that never installs never gets to try again.
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map(name => (keep.has(name) ? null : caches.delete(name))));
    // Navigation preload lets the browser start the network request for a
    // navigation before this worker has even booted, which is most of what a
    // worker otherwise costs on a cold start.
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

/* The page asks for the new version rather than being given it.
 *
 * A worker that calls skipWaiting() in `install` replaces the running app
 * mid-session: the next lazily-loaded chunk comes from a different build than
 * the code asking for it, and the failure looks like a random crash. So the new
 * worker waits, the page notices and offers a reload, and this is the reply. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* Tapping "your picture is ready" opens the picture, not a second copy of the app.
 *
 * A notification click with no handler at all does nothing on Android and opens
 * a new tab on the desktop -- so the reader ends up with two of this app, the
 * second one cold, while the answer they were told about is in the first. So an
 * open window is looked for first and focused, and a new one is opened only
 * when there is none. `data.url` is the conversation to land in. */
/* Woken by the server, with nothing to read.
 *
 * A push carries no payload here -- see server/push.js for why -- so this asks
 * what just finished and what to call it. The sentence comes from the server
 * because it was the app that handed it over when it subscribed, and a worker
 * has no translations of its own.
 *
 * Nothing is shown if the app is already in front of somebody. That is the same
 * rule the in-page half applies (`unattended` in src/notify.js) and it is the
 * difference between a notification and an interruption: a push arrives whether
 * or not the reader is watching the answer arrive.
 *
 * `userVisibleOnly` was promised at subscribe time, so a browser may show a
 * notification of its own if this handler shows none -- hence the check for a
 * *visible* client rather than simply skipping when any window exists. */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open.some(client => client.visibilityState === 'visible' && client.focused)) return;
    let said = '';
    let tag = 'ollama-webui-push';
    try {
      const res = await fetch('/api/push/last', { cache: 'no-store', credentials: 'include' });
      const data = await res.json();
      said = (data && data.label) || '';
      /* A subscription CLI back from its usage limit: its own sentence, with
         the CLI's name put in, and its own tag so it does not replace (or get
         replaced by) an answer's notification. */
      const last = data && data.last;
      if (last && last.kind === 'cli-reset') {
        const sentence = (data.labels && data.labels.cliReset) || '{name} is available again';
        said = sentence.replace('{name}', last.name || 'CLI');
        tag = 'ollama-webui-cli-reset';
      }
    } catch (err) { /* the notification is still worth showing */ }
    await self.registration.showNotification(said || 'Ollama WebUI', {
      body: '',
      tag,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      // Same origin is the only test that matters: the app is a single page, so
      // any window of it is a window that can show this.
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus().catch(() => {});
        try { client.postMessage({ type: 'OPEN_CHAT', url: wanted }); } catch (e) { /* focused anyway */ }
        return;
      }
    }
    await self.clients.openWindow(wanted).catch(() => {});
  })());
});

const fromNetworkThenCache = async (event) => {
  try {
    // Whatever navigation preload already started, if anything did.
    const preloaded = await event.preloadResponse;
    const response = preloaded || await fetch(event.request);
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then(cache => cache.put(SHELL_URL, copy)).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL_URL);
    if (cached) return cached;
    throw err;
  }
};

const fromCacheThenNetwork = async (request, cacheName, { revalidate = false } = {}) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const network = fetch(request).then((response) => {
    // Opaque responses (`type: 'opaque'`) have a status of 0 and no readable
    // body; storing one caches a result nothing can inspect, including this
    // worker on the next request.
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);

  if (cached) {
    if (revalidate) network.catch(() => {});   // warm it, do not wait for it
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error('offline and not cached');
};

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // A worker sees every request the page makes, including the ones that change
  // things. Only GET has a safe answer to give from a cache.
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (err) { return; }

  // Another origin's business — a Google sign-in script, say. Caching it here
  // would mean deciding on its behalf how long its answer stays true.
  if (url.origin !== self.location.origin) return;

  if (isPassThrough(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(fromNetworkThenCache(event));
    return;
  }

  if (isHashedAsset(url.pathname)) {
    event.respondWith(fromCacheThenNetwork(request, ASSET_CACHE));
    return;
  }

  if (isShellExtra(url.pathname)) {
    event.respondWith(fromCacheThenNetwork(request, SHELL_CACHE, { revalidate: true }));
  }
});
