// Installing the app, and noticing when a new build is waiting.
//
// Three separate things live here because they are three halves of one
// feature — "this is an app on your phone, not a tab" — and each is a browser
// API with a sharp edge:
//
//   * Registration. Only in a production build: the dev server rewrites
//     modules on every save, and a worker sitting in front of that serves the
//     previous edit back. It is also skipped where there is no worker at all
//     (Safari in a private window, an insecure origin that is not localhost).
//   * The update prompt. A new worker installs and then *waits*, because
//     taking over mid-session mixes two builds in one page. Somebody has to
//     ask, so the page does.
//   * The install prompt. `beforeinstallprompt` fires once, early, and is the
//     only handle on the browser's own install flow — so it is captured and
//     kept rather than being allowed to pass.

const SW_URL = '/sw.js';

export const supportsServiceWorker = () =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/**
 * True when the app is running as an installed app rather than in a tab.
 *
 * Two ways of asking, because iOS answers only the second: Chromium sets the
 * `display-mode` media feature, and Safari sets `navigator.standalone`.
 */
export const isStandalone = () => {
  if (typeof window === 'undefined') return false;
  const asApp = window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: minimal-ui)').matches
    || window.matchMedia?.('(display-mode: window-controls-overlay)').matches;
  return !!asApp || window.navigator?.standalone === true;
};

/**
 * Register the worker, and call `onUpdate` when a newer build is ready.
 *
 * `onUpdate` is handed a function that applies it. Applying means telling the
 * waiting worker to take over and then reloading once it has — not reloading
 * immediately, which would just load the old build again from a worker that is
 * still the one in charge.
 */
export const registerServiceWorker = ({ onUpdate } = {}) => {
  if (!supportsServiceWorker()) return () => {};
  // A worker registered against a dev server caches modules Vite is still
  // rewriting; the symptom is an edit that will not appear however many times
  // you reload.
  if (import.meta.env && import.meta.env.DEV) return () => {};

  let disposed = false;
  let reloading = false;

  // `controllerchange` fires when the new worker takes over. Reloading there,
  // rather than straight after postMessage, is what guarantees the reloaded
  // page is served by the build the user just accepted.
  const onControllerChange = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  const offerUpdate = (worker) => {
    if (disposed || !worker) return;
    onUpdate?.(() => worker.postMessage({ type: 'SKIP_WAITING' }));
  };

  const start = async () => {
    try {
      const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
      if (disposed) return;

      // Already waiting when the page loaded: the update arrived during a
      // previous visit and nobody accepted it.
      //
      // `navigator.serviceWorker.controller` is the guard that stops this
      // firing on a first visit. The very first worker also passes through
      // "installed", but there is nothing to update *from* — showing a reload
      // prompt to somebody who has just opened the app for the first time is
      // nonsense.
      if (registration.waiting && navigator.serviceWorker.controller) {
        offerUpdate(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate(installing);
          }
        });
      });
    } catch (err) {
      // An unregistrable worker is not a broken app; it is an app without
      // offline support, which is what it was before this file existed.
    }
  };

  start();

  return () => {
    disposed = true;
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  };
};

/**
 * Hold on to the browser's install prompt so a button can fire it later.
 *
 * `beforeinstallprompt` is fired once, unprompted, usually before the app has
 * finished mounting, and the event is the only way to open the install flow —
 * there is no method to call. Letting it go means the app can never offer to
 * install itself, only wait for the user to find the browser menu.
 *
 * `available` is called with true when there is a prompt to show and false
 * once it has been used or the app has been installed.
 */
export const watchInstallPrompt = (available) => {
  if (typeof window === 'undefined') return { dispose: () => {}, prompt: async () => false };

  let deferred = null;

  const onBeforeInstall = (event) => {
    // Without this the browser shows its own bar, and the event is consumed.
    event.preventDefault();
    deferred = event;
    available?.(true);
  };

  const onInstalled = () => {
    deferred = null;
    available?.(false);
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  window.addEventListener('appinstalled', onInstalled);

  return {
    /** Open the browser's install dialog. Resolves true if it was accepted. */
    prompt: async () => {
      if (!deferred) return false;
      const event = deferred;
      // A deferred prompt is single-use whatever the answer, so it is dropped
      // before awaiting rather than after — a second click while the dialog is
      // open would otherwise throw.
      deferred = null;
      available?.(false);
      try {
        event.prompt();
        const { outcome } = await event.userChoice;
        return outcome === 'accepted';
      } catch (err) {
        return false;
      }
    },
    dispose: () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    },
  };
};
