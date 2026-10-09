// Copying text, on the addresses this app is actually opened from.
//
// `navigator.clipboard` only exists in a secure context, and "secure" means
// HTTPS or localhost — nothing else. That is precisely the case this app does
// not have: the whole point of `PUBLIC_ORIGIN` is to be reachable from a phone,
// which means a LAN address or a nip.io hostname, over plain HTTP. On the
// machine that serves it the copy buttons work, because that machine uses
// localhost. On every other device they did not work at all.
//
// And they failed silently, which is the part that made it a bug rather than a
// limitation: `navigator.clipboard.writeText(text)` throws a TypeError on
// `undefined`, nothing caught it, and the button simply did nothing — not even
// its own "copied" tick, since the line that sets it came after the throw.
//
// So: use the modern API where it exists, fall back to the old one where it
// does not, and — this is the part the old code skipped — report whether it
// actually worked, so a caller can say so instead of showing a tick that lies.

import { decodeByteFallback } from './byteFallback.js';

/**
 * Text as it should land on the clipboard.
 *
 * What is on screen and what was copied disagreed in ways that pasted as
 * broken letters: Korean a CLI wrote decomposed (NFD jamo -- drawn joined by
 * the browser, pasted as separate ㅈㅓㅇ in many apps), byte-fallback tokens
 * (<0xED>…) the renderer decodes but the raw content did not, and lone
 * surrogates / zero-width markers from a stream cut mid-character.
 */
export const cleanCopiedText = (text) => {
  let value = decodeByteFallback(String(text ?? ''));
  try { value = value.normalize('NFC'); } catch { /* old engine */ }
  if (typeof value.toWellFormed === 'function') value = value.toWellFormed();
  // ZWSP / BOM / replacement char. ZWJ (U+200D) stays: emoji need it.
  return value.replace(/[​﻿�]/g, '');
};

/**
 * Ctrl+C on a selection gets the same cleaning. The plain text is rewritten;
 * the HTML copy is kept (normalized) so rich pastes keep their formatting.
 */
export const installCopyCleanup = () => {
  if (typeof document === 'undefined' || installCopyCleanup.done) return;
  installCopyCleanup.done = true;
  document.addEventListener('copy', (e) => {
    const target = e.target;
    // Inputs and editors copy what they hold, untouched.
    if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"], .cm-editor, .monaco-editor')) return;
    const selection = document.getSelection?.();
    if (!selection || selection.isCollapsed || !e.clipboardData) return;
    const plain = cleanCopiedText(selection.toString());
    if (!plain) return;
    let html = '';
    try {
      const box = document.createElement('div');
      for (let i = 0; i < selection.rangeCount; i++) box.appendChild(selection.getRangeAt(i).cloneContents());
      html = box.innerHTML.normalize('NFC').replace(/[​﻿]/g, '');
    } catch { /* plain is enough */ }
    e.preventDefault();
    e.clipboardData.setData('text/plain', plain);
    if (html) e.clipboardData.setData('text/html', `<meta charset="utf-8">${html}`);
  });
};

/**
 * Put `text` on the clipboard. Resolves true if it got there.
 *
 * Never throws. A copy button that raises is worse than one that returns
 * false, because the caller is in an event handler and has nowhere to put it.
 */
export const copyText = async (text) => {
  const value = cleanCopiedText(text);
  if (!value) return false;

  // The modern path. Also rejects when the document is not focused, or when
  // permission is refused, which is why the fallback runs on rejection and not
  // only on absence.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (err) {
      // Fall through.
    }
  }

  return legacyCopy(value);
};

/**
 * `document.execCommand('copy')`, which is deprecated and still the only thing
 * that works over plain HTTP.
 *
 * The element has to be in the document and selectable for the command to have
 * anything to act on, so it is added, used and removed within one synchronous
 * stretch — no frame is ever painted with it present.
 */
const legacyCopy = (value) => {
  if (typeof document === 'undefined' || !document.body) return false;

  const holder = document.createElement('textarea');
  holder.value = value;
  // `readonly` stops a mobile keyboard appearing for the split second the
  // element is focused; `contentEditable` is what makes iOS select it at all.
  holder.setAttribute('readonly', '');
  holder.contentEditable = 'true';
  // Off screen rather than `display: none`: a hidden element has no selection
  // and the command silently copies nothing. `position: fixed` with a zero
  // opacity keeps it out of the layout without scrolling the page to it, which
  // a plain off-screen offset would do on focus.
  Object.assign(holder.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: 'none',
    outline: 'none',
    boxShadow: 'none',
    background: 'transparent',
    opacity: '0',
    pointerEvents: 'none',
  });

  const previous = document.activeElement;
  document.body.appendChild(holder);

  let copied = false;
  try {
    holder.focus({ preventScroll: true });
    holder.select();
    // iOS ignores select() on a readonly field and needs the range spelled out.
    holder.setSelectionRange(0, value.length);
    copied = document.execCommand('copy');
  } catch (err) {
    copied = false;
  } finally {
    holder.remove();
    // Typing should carry on where it left off; without this the composer
    // loses focus every time something is copied.
    if (previous && typeof previous.focus === 'function') {
      try { previous.focus({ preventScroll: true }); } catch (err) { /* gone */ }
    }
  }

  return copied;
};

/** True where the modern API is available, i.e. HTTPS or localhost. */
export const hasSecureClipboard = () =>
  typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
