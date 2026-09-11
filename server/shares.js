/**
 * Publishing one conversation as a read-only link.
 *
 * The feature people actually want is "let someone read this without giving
 * them my account", and every part of the design here follows from taking that
 * literally.
 *
 * **A snapshot, not a reference.** The row stores a copy of the transcript at
 * the moment the link was made. Pointing at the live chat would be less code
 * and much worse: every message added afterwards — including the one where you
 * paste an API key into the same thread out of habit — would appear under a URL
 * you handed out last week and have long since forgotten. Sharing has to be an
 * act with a boundary, and the boundary is the snapshot.
 *
 * **The token is the capability, so it is stored hashed.** Anyone holding it
 * can read the snapshot; that is the point of a link. But a copy of `webui.db`
 * must not be a stack of working links, so the row keeps only SHA-256 of the
 * token — the same treatment session tokens get. The consequence is that the
 * URL can be shown exactly once, at creation, and the owner's device is what
 * remembers it afterwards.
 *
 * **The public read is anonymous by construction.** `readShare` returns the
 * transcript and its dates and nothing else: no user id, no email, no name, no
 * neighbouring chats. There is no code path from a token to an account.
 *
 * **Every share can be ended.** Revocation, expiry and account deletion all
 * kill a link — the last one by the foreign key, so deleting an account cannot
 * leave its conversations readable on the internet.
 */
import crypto from 'node:crypto';
import { one, query, run, transaction } from './db.js';

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

/* One snapshot should not be able to fill the disk, and a transcript that
 * large is not something anybody is going to read in a browser anyway. The cap
 * is generous because a chat carrying screenshots is normal here. */
export const MAX_SHARE_BYTES = 4 * 1024 * 1024;

/** How many live links one account may hold. */
export const MAX_SHARES_PER_USER = 200;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const nextId = () => crypto.randomBytes(9).toString('base64url');

export class ShareError extends Error {
  constructor(message, status = 400, code = 'share') {
    super(message);
    this.name = 'ShareError';
    this.status = status;
    this.code = code;
  }
}

/** What the owner is allowed to see about their own links. Never the token. */
const toSummary = (row) => ({
  id: row.id,
  chatId: row.chat_id,
  title: row.title || '',
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revoked: !!row.revoked,
  views: row.views,
  lastViewedAt: row.last_viewed_at,
  messageCount: countMessages(row.payload),
});

const countMessages = (payload) => {
  try {
    const parsed = JSON.parse(payload);
    return Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
  } catch (e) {
    return 0;
  }
};

/**
 * Publish a snapshot and return the one and only copy of its token.
 *
 * `snapshot` is whatever the client decided to publish — it does the stripping,
 * because it is the side that knows what a message means. What this checks is
 * that the thing is a transcript at all and that it fits.
 */
export const createShare = (userId, { chatId, title, snapshot, expiresInDays }) => {
  if (!userId) throw new ShareError('Not signed in.', 401, 'unauthenticated');
  if (!snapshot || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
    throw new ShareError('There is nothing in that chat to share.');
  }

  const payload = JSON.stringify({
    title: String(title || snapshot.title || '').slice(0, 200),
    messages: snapshot.messages,
    // Kept so the reader knows how old this is. Not the owner's clock for the
    // chat — the moment of publication, which is the only date that describes
    // what they are looking at.
    sharedAt: Date.now(),
  });
  if (Buffer.byteLength(payload, 'utf8') > MAX_SHARE_BYTES) {
    throw new ShareError('That conversation is too large to publish as a link.', 413, 'too-large');
  }

  const days = Number(expiresInDays);
  // 0 or absent means no expiry, which is a deliberate choice and not a
  // default: the dialog asks, and "never" is one of the answers.
  const expiresAt = Number.isFinite(days) && days > 0
    ? Date.now() + Math.min(days, 3650) * 86400000
    : null;

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');

  return transaction((db) => {
    const live = db.prepare(
      'SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND revoked = 0',
    ).get(userId)?.n ?? 0;
    if (live >= MAX_SHARES_PER_USER) {
      throw new ShareError('You already have the maximum number of share links.', 429, 'too-many');
    }

    const id = nextId();
    db.prepare(`
      INSERT INTO shares (token_hash, id, user_id, chat_id, title, payload, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      hashToken(token), id, userId, String(chatId || ''),
      String(title || snapshot.title || '').slice(0, 200),
      payload, Date.now(), expiresAt,
    );

    return { token, id, expiresAt };
  });
};

/**
 * Read a published snapshot by its token.
 *
 * Returns null for every reason a link can fail — unknown, revoked, expired —
 * on purpose. Distinguishing them would tell a stranger with a guessed token
 * that they had guessed a real one.
 */
export const readShare = (token) => {
  if (!token) return null;
  const row = one('SELECT * FROM shares WHERE token_hash = ?', hashToken(token));
  if (!row || row.revoked) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null;

  // Best-effort: a counter failing to increment must not stop somebody reading
  // a page they were given the link to.
  try {
    run('UPDATE shares SET views = views + 1, last_viewed_at = ? WHERE token_hash = ?',
      Date.now(), row.token_hash);
  } catch (e) { /* the read is what matters */ }

  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch (e) {
    return null;
  }

  // Deliberately narrow. There is no field here that names the account, and
  // nothing that could grow one by accident later: this object is built by
  // hand rather than spread from the row.
  return {
    title: payload.title || '',
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    sharedAt: payload.sharedAt || row.created_at,
    expiresAt: row.expires_at,
  };
};

/** The owner's own links, newest first. */
export const listShares = (userId) => {
  if (!userId) return [];
  return query(
    'SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC',
    userId,
  ).map(toSummary);
};

/**
 * End a link.
 *
 * The payload goes with it rather than being left behind with a flag set. A
 * revoked share is one somebody decided should stop existing, and keeping a
 * readable copy of a conversation after being asked to stop is the wrong
 * reading of that.
 */
export const revokeShare = (userId, id) => {
  if (!userId || !id) return false;
  return run('DELETE FROM shares WHERE user_id = ? AND id = ?', userId, String(id)).changes > 0;
};

/** Everything the account has published, at once. */
export const revokeAllShares = (userId) => {
  if (!userId) return 0;
  return run('DELETE FROM shares WHERE user_id = ?', userId).changes;
};

/**
 * Drop what has expired.
 *
 * An expired share is already unreadable — `readShare` checks the date — so
 * this is housekeeping rather than enforcement, and it is written that way: if
 * it never ran, nothing would be exposed.
 */
export const purgeExpiredShares = () =>
  run('DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?', Date.now()).changes;
