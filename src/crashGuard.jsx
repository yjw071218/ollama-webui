/**
 * Keeping one broken thing from taking the whole app with it.
 *
 * There was one error boundary, around everything. So a single message that
 * would not render -- a malformed chart block, a picture record missing a field,
 * a half-synced chat from another device -- replaced the entire app with
 * "React Crashed!", and the only way out was a reload that often hit the same
 * message again.
 *
 * Now:
 *   - each message row has its own boundary: a row that fails shows a one-line
 *     notice with a retry, and the rest of the conversation stays usable;
 *   - panels (sidebar, studio, side panels) get one each, the same way;
 *   - the outermost boundary recovers by itself once (re-mounting the app), and
 *     only if it fails again within a short time does it show the error, with
 *     buttons to retry, reload, or copy the details;
 *   - every caught error, and every uncaught one (window.onerror, unhandled
 *     promise rejections), is kept in localStorage (`webui:crashLog`, last 30)
 *     and, in the Windows app, written to userData/crash.log.
 */
import React from 'react';

const LOG_KEY = 'webui:crashLog';
const MAX_LOG = 30;

const describe = (error) => {
  if (!error) return 'unknown error';
  if (error instanceof Error) return `${error.name}: ${error.message}\n${(error.stack || '').split('\n').slice(1, 8).join('\n')}`;
  try { return typeof error === 'string' ? error : JSON.stringify(error); } catch { return String(error); }
};

/** Write one error down: localStorage, and the Windows app's crash.log. */
export const recordCrash = (where, error, extra = '') => {
  const text = `[${where}] ${describe(error)}${extra ? `\n${String(extra).slice(0, 1500)}` : ''}`;
  try {
    const list = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    list.push({ at: new Date().toISOString(), text: text.slice(0, 4000) });
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-MAX_LOG)));
  } catch { /* storage full or unavailable */ }
  try { window.ollamaNative?.reportError?.(text); } catch { /* */ }
  try { console.error(text); } catch { /* */ }
  return text;
};

export const readCrashLog = () => {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
};

/** Errors nothing caught. Installed once. */
let installed = false;
export const installGlobalCrashLog = () => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    // A resource that failed to load (an <img>) is not an error in the app.
    if (!event?.error && event?.target && event.target !== window) return;
    recordCrash('window.onerror', event?.error || event?.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    // A fetch the user cancelled is not a failure.
    if (reason?.name === 'AbortError') return;
    recordCrash('unhandledrejection', reason);
  });
};

/**
 * A boundary for one part of the screen. `fallback(error, retry)` draws what
 * stands in for it; by default a small notice with a retry button.
 * `resetKey`: when it changes, a failed part tries again by itself (a new
 * chat, a new version of the message).
 */
export class SafeBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, key: props.resetKey }; }
  static getDerivedStateFromError(error) { return { error }; }
  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }
  componentDidCatch(error, info) { recordCrash(this.props.name || 'part', error, info?.componentStack); }
  retry = () => this.setState({ error: null });
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.retry);
    const ko = /^ko/i.test(typeof navigator !== 'undefined' ? navigator.language || '' : '');
    return (
      <div className="safe-boundary" role="alert">
        <span>{ko ? '이 부분을 표시하지 못했습니다.' : 'This part could not be shown.'}</span>
        <button type="button" onClick={this.retry}>{ko ? '다시 시도' : 'Try again'}</button>
      </div>
    );
  }
}

/** Run `build`; if it throws, record it and return `fallback()` instead. */
export const safely = (where, build, fallback) => {
  try { return build(); }
  catch (error) { recordCrash(where, error); return fallback(error); }
};

/**
 * The outermost boundary. It re-mounts the app by itself once; a second
 * failure within 20 seconds is shown, with ways out.
 */
export class AppBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, text: '', generation: 0 }; this.failures = []; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    const text = recordCrash('app', error, info?.componentStack);
    const now = Date.now();
    this.failures = [...this.failures.filter(t => now - t < 20000), now];
    this.setState({ text });
    if (this.failures.length <= 1) {
      // Once: start the app again in place. Most crashes are a state that a
      // fresh mount (re-reading storage) no longer has.
      setTimeout(() => this.setState(s => ({ error: null, generation: s.generation + 1 })), 300);
    }
  }
  render() {
    const { error, text, generation } = this.state;
    if (!error) return <React.Fragment key={generation}>{this.props.children}</React.Fragment>;
    if (this.failures.length <= 1) return null; // recovering
    const ko = /^ko/i.test(navigator.language || '');
    return (
      <div className="app-crash" role="alert">
        <div className="app-crash-card">
          <h2>{ko ? '문제가 발생했습니다' : 'Something went wrong'}</h2>
          <p>{ko ? '대화 내용은 이 기기와 계정에 저장되어 있습니다. 다시 시도하거나 새로고침해 주세요.' : 'Your chats are saved on this device and on the account. Try again or reload.'}</p>
          <pre>{text}</pre>
          <div className="app-crash-actions">
            <button type="button" onClick={() => { this.failures = []; this.setState(s => ({ error: null, generation: s.generation + 1 })); }}>{ko ? '다시 시도' : 'Try again'}</button>
            <button type="button" onClick={() => window.location.reload()}>{ko ? '새로고침' : 'Reload'}</button>
            <button type="button" onClick={() => { try { navigator.clipboard?.writeText(text); } catch { /* */ } }}>{ko ? '오류 내용 복사' : 'Copy details'}</button>
          </div>
        </div>
      </div>
    );
  }
}
