/**
 * Sending an answer somewhere else.
 *
 * Copy exists, and on a desktop copy is enough: the other window is one
 * keystroke away. On a phone it is not. Getting an answer into KakaoTalk meant
 * copy, leave the browser, find the app, find the conversation, paste — and
 * the browser is quite likely to have been discarded by the time you come
 * back. The share sheet is one tap and the operating system does the rest.
 *
 * `navigator.share` needs a secure context and a real user gesture, and it is
 * absent on most desktop browsers, so everything here reports what happened
 * rather than assuming: the caller falls back to copying.
 */

/** Is there a share sheet to open at all? */
export const canShare = () => (
  typeof navigator !== 'undefined'
  && typeof navigator.share === 'function'
  // A share from an insecure origin throws rather than returning false, and
  // this app is reached over plain http on a home network all the time.
  && (typeof window === 'undefined' || window.isSecureContext !== false)
);

/**
 * What a shared answer should say.
 *
 * The question comes first because a passage of prose with no question above
 * it is a puzzle for whoever receives it, and the model's name last because it
 * is the part a reader may want and never the part they read first.
 */
export const shareBody = ({ question = '', answer = '', model = '' } = {}) => {
  const parts = [];
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (q) parts.push(`Q. ${q}`);
  if (a) parts.push(a);
  if (model) parts.push(`— ${model}`);
  return parts.join('\n\n');
};

/**
 * Open the share sheet.
 *
 * Returns one of:
 *   'shared'      — it went somewhere
 *   'cancelled'   — the sheet opened and the person dismissed it
 *   'unsupported' — there is no sheet on this browser
 *   'failed'      — it threw for some other reason
 *
 * Cancelling is not a failure and must not be reported as one: dismissing the
 * sheet is a decision, and a red "sharing failed" for it would be a lie. The
 * browser signals it with an `AbortError`.
 */
export const shareText = async ({ title = '', text = '' } = {}) => {
  if (!canShare()) return 'unsupported';
  if (!String(text || '').trim()) return 'failed';
  try {
    await navigator.share(title ? { title, text } : { text });
    return 'shared';
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return 'cancelled';
    return 'failed';
  }
};
