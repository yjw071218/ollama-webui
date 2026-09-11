/**
 * Handing one conversation to somebody who has no account here.
 *
 * The server side is in server/shares.js and explains the storage decisions.
 * This half is about what actually goes into the snapshot, which is the part
 * only the client can decide — the server sees an array of messages and has no
 * way to know that half of one is a tool trace.
 *
 * Three things are stripped, and each has a reason beyond tidiness:
 *
 *   * **Reasoning traces.** A `<think>` block is the model talking to itself,
 *     it is often longer than the answer, and it frequently restates the whole
 *     prompt — including anything retrieved from private documents.
 *   * **Tool calls and their results.** These carry filesystem paths, local
 *     URLs and whatever a read returned. "Share this answer" is not consent to
 *     publish the contents of a directory listing.
 *   * **Attachment bodies and injected context.** The transcript keeps the
 *     chip saying a file was attached, because that is part of the
 *     conversation, but the file's text and the retrieved passages behind an
 *     answer are not published.
 *
 * Images stay: a conversation about a screenshot is unreadable without it, and
 * the person publishing it is looking straight at the picture when they decide.
 */
import { api } from './session.jsx';
import { stripAttachments } from './attachMarkers.js';
import { canonicalToolTags } from './tools.js';
import { variantsOf, variantIndexOf } from './variants.js';

/** Where a share is read. Relative, so it works on whatever address this is. */
export const shareUrl = (token, origin = window.location.origin) =>
  `${origin.replace(/\/$/, '')}/s/${token}`;

/** The token in the address bar, if this page is a shared conversation. */
export const shareTokenFromPath = (pathname = window.location.pathname) => {
  const match = /^\/s\/([A-Za-z0-9_-]{16,})\/?$/.exec(pathname || '');
  return match ? match[1] : '';
};

const stripScaffolding = (content) => stripAttachments(
  canonicalToolTags(String(content || ''))
    // The model's own reasoning, including a block left unterminated by a
    // stopped stream.
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
    // Tool calls and everything they returned.
    .replace(/<TOOL_RESULT>[\s\S]*?(<\/TOOL_RESULT>|$)/gi, '')
    .replace(/<TOOL_[A-Z_]+(\s+[^>]*)?>[\s\S]*?(<\/TOOL_[A-Z_]+>|$)/gi, ''),
).trim();

/** A message with nothing on it but what a reader needs. */
const publishable = (message) => {
  // Only the variant that is on screen. The others are the answers their
  // author decided against, and publishing the ones they rejected alongside
  // the one they chose is not what "share this conversation" means.
  const shown = variantsOf(message)[variantIndexOf(message)] || message;
  const content = stripScaffolding(
    message.role === 'assistant' ? (shown.content ?? message.content) : message.content,
  );
  if (!content && !(message.images?.length)) return null;
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
    at: message.at || null,
    ...(message.images?.length ? { images: message.images } : {}),
    ...(message.role === 'assistant' && (shown.model || message.model)
      ? { model: shown.model || message.model }
      : {}),
  };
};

/**
 * Turn a chat into what will be published.
 *
 * A tool result arrives as a `user` message whose whole body is the result, so
 * stripping leaves it empty — and an empty bubble in a published transcript is
 * a reader wondering what they are not being shown. They are dropped instead.
 */
export const buildSnapshot = (session) => ({
  title: String(session?.title || '').slice(0, 200),
  messages: (session?.messages || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && !m.continuation)
    .map(publishable)
    .filter(Boolean),
});

/** Roughly how big the published copy will be, for showing before publishing. */
export const snapshotBytes = (snapshot) => {
  try { return new Blob([JSON.stringify(snapshot)]).size; } catch (e) { return 0; }
};

export const createShare = async ({ chatId, title, snapshot, expiresInDays }) => {
  const data = await api('/api/share/create', {
    method: 'POST',
    body: { chatId: String(chatId ?? ''), title, snapshot, expiresInDays },
  });
  return { id: data.id, token: data.token, expiresAt: data.expiresAt, url: shareUrl(data.token) };
};

export const listShares = async () => (await api('/api/share/list')).shares || [];

export const revokeShare = (id) => api('/api/share/revoke', { method: 'POST', body: { id } });

export const revokeAllShares = () => api('/api/share/revoke', { method: 'POST', body: { all: true } });

/**
 * Read a published conversation.
 *
 * Deliberately not through `api()`: that helper attaches the session cookie
 * and the CSRF header, and this request is made by people who have neither.
 * Sending credentials to read a public page would also mean a shared link
 * quietly telling the server who opened it.
 */
export const fetchShare = async (token, signal) => {
  const res = await fetch(`/api/share/view?token=${encodeURIComponent(token)}`, {
    credentials: 'omit',
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) return null;
  return data.share;
};

/* --------------------------------------------------- what this device knows

   The server keeps only a hash of each token, so it cannot show the owner
   their own link a second time. That is the right trade -- a stolen database
   is not a stack of working links -- but it means the URL has to live
   somewhere, and the only somewhere that does not weaken it is the device that
   made it. Kept per scope, beside every other setting. */

const KEY = 'shareLinks';

export const loadShareUrls = (getSetting) => {
  try {
    const parsed = JSON.parse(getSetting(KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
};

export const rememberShareUrl = (getSetting, setSetting, id, url) => {
  const all = { ...loadShareUrls(getSetting), [id]: url };
  setSetting(KEY, JSON.stringify(all));
  return all;
};

export const forgetShareUrl = (getSetting, setSetting, id) => {
  const all = loadShareUrls(getSetting);
  delete all[id];
  setSetting(KEY, JSON.stringify(all));
  return all;
};
