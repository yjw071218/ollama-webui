import { SafeBoundary } from './crashGuard.jsx';
import React, { Suspense } from 'react';

/**
 * A component whose code is fetched the first time it is shown.
 *
 *   const ModelCompare = lazyPanel(() => import('./ModelCompare.jsx'), 'ModelCompare');
 *
 * For panels nobody sees on first paint -- settings tabs, the model comparison,
 * evals, integrations. Left in the main bundle, every one of them is
 * downloaded, parsed and compiled before a phone shows its first chat, which on
 * a mid-range handset is most of the startup time.
 *
 * Each one carries its own Suspense boundary, so a call site does not change
 * and the rest of the app keeps rendering while the chunk arrives. `preload`
 * starts the download early (on hover, or once the app is idle).
 */
/* A chunk is named by its hash, so a page opened before the server was
   rebuilt asks for a file that no longer exists ("Failed to fetch
   dynamically imported module") and React used to crash. The fetch is
   retried once (a dropped connection), and if the file is really gone the
   page reloads once to pick up the new build. A failure is not cached. */
const RELOAD_KEY = 'lazy-chunk-reload';
const isChunkError = (e) => /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch/i.test(String(e?.message || e));
const loadChunk = async (load) => {
  try { return await load(); } catch (first) {
    if (!isChunkError(first)) throw first;
    await new Promise(r => setTimeout(r, 600));
    try { return await load(); } catch (second) {
      /* Never reloads the page any more (that threw away whatever was being
         typed or streamed). Old chunks are kept on the server, so a third try
         after a pause usually works; otherwise the panel shows its error. */
      await new Promise(r => setTimeout(r, 2000));
      return load();
    }
  }
};

export const lazyPanel = (load, name = 'default') => {
  let pending = null;
  const preload = () => (pending ||= loadChunk(load).catch(e => { pending = null; throw e; }));
  /* React.lazy remembers a failed load for good, so "try again" needs a new
     lazy component; `attempt` makes one. And a failure stays inside the panel
     (SafeBoundary): a chunk that could not be fetched -- the server was just
     updated and the old file is gone -- used to take the whole app down to
     "React Crashed!". */
  const make = () => React.lazy(() => preload().then(m => ({ default: m[name] })));
  let Inner = make();
  const Panel = (props) => {
    const [attempt, setAttempt] = React.useState(0);
    return (
      <SafeBoundary name={`panel:${name}`} resetKey={attempt}
        fallback={(error, retry) => (
          <div className="safe-boundary" role="alert">
            <span>{/^ko/i.test(navigator.language || '') ? '이 화면을 불러오지 못했습니다.' : 'This panel could not be loaded.'}</span>
            <button type="button" onClick={() => { pending = null; Inner = make(); setAttempt(n => n + 1); retry(); }}>
              {/^ko/i.test(navigator.language || '') ? '다시 시도' : 'Try again'}
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              {/^ko/i.test(navigator.language || '') ? '새로고침' : 'Reload'}
            </button>
          </div>
        )}>
        <Suspense fallback={<div className="lazy-panel-loading" aria-busy="true" />}>
          <Inner {...props} />
        </Suspense>
      </SafeBoundary>
    );
  };
  Panel.displayName = `Lazy(${name === 'default' ? 'Panel' : name})`;
  Panel.preload = preload;
  return Panel;
};

/** Fetch the given panels once the browser has nothing better to do. */
export const preloadWhenIdle = (panels) => {
  const run = () => panels.forEach(p => p.preload?.().catch(() => {}));
  // Not on a metered or slow connection: there the user pays for every byte.
  const conn = navigator.connection;
  if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType || '')) return;
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 8000 });
  else setTimeout(run, 4000);
};
