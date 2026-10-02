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


/* ------------------------------------------------------------ a picture

   The same sheet, with a file in it.

   `navigator.share` will only take files a browser says it can take, and it
   says so through a second call -- `navigator.canShare({ files })` -- which
   has to be made with the actual File, not with a guess about it. So the
   bytes are fetched first and the question asked afterwards; there is no way
   to know in advance, and pretending otherwise means a button that opens
   nothing on the one device it exists for.

   The fallback is not here. A caller that gets 'unsupported' has a link to
   offer instead, and which of those is the better answer is a question about
   the picture and the page it is on, not about the sheet. */

/* What a file is, from its name, when the server did not say.
   Only the handful this app makes. */
const guessType = (filename) => {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'image/png';
};

/**
 * Why there is no share sheet here, when there is not one.
 *
 * Two different reasons, with two different answers. A desktop browser simply
 * has no `navigator.share` and never will, and the answer there is a link. A
 * phone has one and is refusing it because the page arrived over plain HTTP --
 * and the answer there is not a link, it is the file.
 *
 * Worth telling apart, because "there is no sheet on this browser" and "there
 * is a sheet and this address cannot use it" lead somewhere different.
 */
export const whyNoSheet = () => {
  if (typeof navigator === 'undefined') return 'none';
  if (typeof navigator.share !== 'function') return 'none';
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
  return '';
};

/** Whether this browser will take a file at all. Cheap, and often enough. */
export const canShareFiles = () => (
  canShare() && typeof navigator.canShare === 'function'
);

/**
 * Open the share sheet with a picture in it.
 *
 * `url` is fetched rather than being handed over as a link: a link in a share
 * sheet arrives in the other app as text, and a picture sent to somebody
 * should arrive as a picture. The same four outcomes as `shareText`.
 */
export const sharePicture = async ({ url, filename = 'picture.png', text = '', title = '' } = {}) => {
  if (!canShareFiles() || !url) return 'unsupported';
  let file;
  try {
    const blob = await (await fetch(url)).blob();
    // The type comes from the bytes, not from the name: this takes films as
    // well as pictures, and `image/png` on an mp4 is a file KakaoTalk shows as
    // a broken thumbnail.
    file = new File([blob], filename, { type: blob.type || guessType(filename) });
  } catch (e) {
    return 'failed';
  }
  // Asked with the real file, because that is the only form of the question
  // a browser answers honestly.
  if (!navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({
      files: [file],
      ...(title ? { title } : {}),
      ...(text ? { text } : {}),
    });
    return 'shared';
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return 'cancelled';
    return 'failed';
  }
};
