/**
 * What is on screen when the server cannot be reached.
 *
 * Two places, two shapes:
 *
 *   * At start-up, `ServerOffline` instead of the app. Without it, a server
 *     that was off meant the session check failed, the app quietly ran as the
 *     guest, and somebody signed in found an empty chat list with nothing to
 *     say why -- worse, anything typed went into the guest's storage. It keeps
 *     trying on its own, and offers to carry on offline (the cached shell and
 *     this browser's chats) for whoever wants to.
 *   * Later, `ConnectionBanner` over the app, when a server that was there
 *     stops answering. The app stays usable; the banner says it is
 *     disconnected, counts down to the next try, and goes when it is back.
 *
 * Both sit outside the i18n provider's tree, so they translate for themselves.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WifiOff, RefreshCcw } from 'lucide-react';
import { translate, detectLanguage } from './i18n.jsx';
import { Logo } from './Logo.jsx';

const say = (key, vars) => translate(detectLanguage(), key, vars);

const RETRY_SECONDS = 5;

/** Counts down from `seconds` while `active`, calls `onZero`, and starts again. */
const useCountdown = (active, seconds, onZero) => {
  const [left, setLeft] = useState(seconds);
  const zero = useRef(onZero);
  zero.current = onZero;
  useEffect(() => {
    if (!active) { setLeft(seconds); return undefined; }
    const timer = setInterval(() => {
      setLeft((n) => {
        if (n > 1) return n - 1;
        zero.current?.();
        return seconds;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [active, seconds]);
  return [left, () => setLeft(seconds)];
};

/** The start-up screen: the session check could not reach the server. */
export const ServerOffline = ({ onRetry, onContinue }) => {
  const [busy, setBusy] = useState(false);
  const retry = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try { await onRetry?.(); } finally { setBusy(false); }
  }, [busy, onRetry]);
  const [left, reset] = useCountdown(!busy, RETRY_SECONDS, retry);

  // Back online is the likeliest moment for it to work.
  useEffect(() => {
    const now = () => { reset(); retry(); };
    window.addEventListener('online', now);
    return () => window.removeEventListener('online', now);
  }, [retry, reset]);

  return (
    <div className="server-offline" role="alert" aria-live="assertive">
      <div className="server-offline-card">
        <Logo size={48} spinning={busy} />
        <h1>{say('server.offlineTitle')}</h1>
        <p>{say('server.offlineBody')}</p>
        <ul className="server-offline-checks">
          <li>{say('server.checkRunning')}</li>
          <li>{say('server.checkAddress', { address: window.location.host })}</li>
          <li>{say('server.checkNetwork')}</li>
        </ul>
        <div className="server-offline-status" aria-live="polite">
          {busy ? say('server.connecting') : say('server.retryIn', { seconds: left })}
        </div>
        <div className="server-offline-actions">
          <button type="button" onClick={() => { reset(); retry(); }} disabled={busy}>
            <RefreshCcw size={15} className={busy ? 'spin' : ''} /> {say('server.retryNow')}
          </button>
          {onContinue && (
            <button type="button" className="secondary" onClick={onContinue} disabled={busy}>
              {say('server.continueOffline')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* Is the server there? `/api/config` is small, cached by nothing (no-store),
   and has no side effects -- unlike the session check, which can create one. */
const ping = async () => {
  try {
    const res = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    // Any answer from the server counts. A gateway error is the app's own
    // proxy (desktop/Android) saying the server behind it is not there.
    return ![502, 504].includes(res.status);
  } catch (e) {
    return false;
  }
};

const CHECK_EVERY_MS = 15000;

/**
 * A strip over the app while the server is unreachable. `onBack` runs when it
 * returns (used to re-read the session after carrying on offline).
 */
export const ConnectionBanner = ({ onBack }) => {
  const [down, setDown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState(false);
  const misses = useRef(0);
  const downRef = useRef(false);
  downRef.current = down;
  const backRef = useRef(onBack);
  backRef.current = onBack;

  const check = useCallback(async () => {
    if (document.visibilityState === 'hidden' && !downRef.current) return;
    setBusy(true);
    const ok = await ping();
    setBusy(false);
    if (ok) {
      misses.current = 0;
      if (downRef.current) {
        setDown(false);
        setBack(true);
        setTimeout(() => setBack(false), 3000);
        backRef.current?.();
      }
      return;
    }
    // Two misses in a row: one can be a request dropped by a sleeping radio.
    // While a sync is moving data, a slow ping is the sync's traffic, not an
    // outage -- unless the browser itself says it is offline.
    if (navigator.onLine !== false && (globalThis.__webuiSyncBusy || 0) > 0) return;
    misses.current += 1;
    if (misses.current >= 2) setDown(true);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => { if (!downRef.current) check(); }, CHECK_EVERY_MS);
    const soon = () => check();
    window.addEventListener('online', soon);
    window.addEventListener('offline', soon);
    document.addEventListener('visibilitychange', soon);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', soon);
      window.removeEventListener('offline', soon);
      document.removeEventListener('visibilitychange', soon);
    };
  }, [check]);

  const [left, reset] = useCountdown(down && !busy, RETRY_SECONDS, check);

  if (back) {
    return <div className="connection-banner is-back" role="status">{say('server.reconnected')}</div>;
  }
  if (!down) return null;
  return (
    <div className="connection-banner" role="alert">
      <WifiOff size={15} aria-hidden="true" />
      <span className="connection-banner-text">
        {say('server.lost')}{' '}
        <span className="connection-banner-count">
          {busy ? say('server.connecting') : say('server.retryIn', { seconds: left })}
        </span>
      </span>
      <button type="button" onClick={() => { reset(); check(); }} disabled={busy}>
        <RefreshCcw size={13} className={busy ? 'spin' : ''} /> {say('server.retryNow')}
      </button>
    </div>
  );
};

export default ServerOffline;
