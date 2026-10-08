/**
 * Requests from the Windows and Android apps to the page, and back.
 *
 * The apps put what they want done on `window.__ollamaNative` (a queue) and
 * fire `ollama-native-action`; a queue, because a request made as the app
 * opens -- a launcher shortcut, a file shared from the gallery -- comes before
 * the page is listening. The Windows app can also call back through
 * `window.ollamaNative.onAction` (client-preload.cjs).
 *
 *   { type: 'new-chat' }
 *   { type: 'share', text, files: [{ name, type, data /* base64 *\/ }] }
 *
 * Pure apart from `window`, so it is tested with a stand-in for one
 * (scripts/nativeevents.test.mjs).
 */

export const QUEUE = '__ollamaNative';
export const EVENT = 'ollama-native-action';

/** A shared file as the page's File, from the app's base64. */
export const fileOf = ({ name, type, data }) => {
  const binary = atob(String(data || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], String(name || 'shared'), { type: String(type || 'application/octet-stream') });
};

/** One request, handled. Unknown types are ignored: an older page, a newer app. */
export const dispatchNative = (request, handlers) => {
  if (!request || typeof request !== 'object') return false;
  if (request.type === 'new-chat') { handlers.newChat?.(); return true; }
  if (request.type === 'share') {
    const files = (Array.isArray(request.files) ? request.files : []).map((f) => {
      try { return fileOf(f); } catch { return null; }
    }).filter(Boolean);
    const text = typeof request.text === 'string' ? request.text.trim() : '';
    if (!files.length && !text) return false;
    handlers.share?.({ files, text });
    return true;
  }
  return false;
};

/** Listen for the apps' requests. Returns the function that stops listening. */
export const listenNative = (handlers, win = typeof window === 'undefined' ? undefined : window) => {
  if (!win) return () => {};
  const drain = () => {
    const queue = Array.isArray(win[QUEUE]) ? win[QUEUE].splice(0) : [];
    for (const request of queue) { try { dispatchNative(request, handlers); } catch { /* one bad request */ } }
  };
  win.addEventListener?.(EVENT, drain);
  drain();
  let off = null;
  try { off = win.ollamaNative?.onAction?.((request) => { try { dispatchNative(request, handlers); } catch { /* */ } }); } catch { /* */ }
  return () => {
    win.removeEventListener?.(EVENT, drain);
    try { if (typeof off === 'function') off(); } catch { /* */ }
  };
};

/** Tell the app an answer is (or is no longer) being written. */
export const tellNativeBusy = (busy, win = typeof window === 'undefined' ? undefined : window) => {
  try { win?.ollamaNative?.busy?.(!!busy); } catch { /* an app without it */ }
};
