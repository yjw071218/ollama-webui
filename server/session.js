// Sessions, done the way a real site does them.
//
// What was here before was a bearer token stored verbatim in a JSON file, with
// one expiry, no rotation, no CSRF, and no way to end anything but the session
// in front of you. It worked, and every one of those omissions is a way for two
// people's data to end up in one place.
//
// The rules this file enforces:
//
//   * The cookie value is never what is stored. Only its SHA-256 lands in the
//     database, so a leaked file cannot be replayed as a login.
//   * A session id is replaced at login, never reused. Fixing a victim's cookie
//     before they sign in is the oldest trick there is.
//   * Two clocks: idle and absolute. A session that is used stays alive; one
//     that is used for a month still ends.
//   * Every session carries a CSRF token. Nothing that changes state is
//     accepted without it, because SameSite=Lax alone still lets a top-level
//     GET-shaped navigation through.
//   * A user's sessions are enumerable and revocable as a set, so "sign out
//     everywhere" and a password change actually mean something.
//   * A browser may hold several sessions at once and a tab names the one it is
//     using. One cookie holding one session made every tab a single identity,
//     so signing out in one signed out the rest.
//
// The store is SQLite. It was a JSON file kept in memory, which was fine for
// one process and wrong the moment there were two — and a session table is
// exactly the kind of thing that wants an index and a foreign key rather than a
// linear scan and a hope.

import crypto from 'node:crypto';
import { database } from './db.js';

// Two clocks. Idle is what expires an abandoned browser; absolute is what
// guarantees a stolen session eventually stops working no matter how busy the
// thief keeps it.
export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// last_seen_at is written at most this often. Every request would mean a write
// per request for a field nothing reads to the second.
const TOUCH_INTERVAL_MS = 60 * 1000;

export const SESSION_COOKIE = 'webui_session';
export const CSRF_COOKIE = 'webui_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// Which of this browser's sessions a request is acting as.
//
// Cookies are an origin's, not a tab's, so one cookie is what every tab sends
// and a single-session cookie makes every tab one identity — sign out in one
// and the rest go with it. The cookie therefore holds a *set* of sessions and
// each tab names the one it is using, in a header only this app's own script
// can set. See the note above `attachSessions`.
export const SESSION_ID_HEADER = 'x-session-id';

// What a tab sends to say "none of them": it is signed out here even though the
// browser still holds sessions for other tabs.
export const GUEST_SESSION_ID = 'guest';

// What a tab sends when it has no session of its own yet, which is what a newly
// opened tab looks like. It means "a handle on whoever is signed in here" — not
// "whichever session is newest", which is what it used to mean and was the
// whole bug: two tabs opened on the same account both landed on the same
// session, so signing out of one still signed out the other. A tab asking this
// gets a session forked for it, and a session of its own is one it can end
// without ending anybody else's.
export const NEW_SESSION_ID = 'new';

// The same request, aimed: "a session of my own on *that* account". It is what
// switching accounts sends, and it forks for the same reason opening a tab
// does — adopting the session another tab is holding would put the two back to
// sharing one, which is the thing that made signing out contagious.
export const NEW_SESSION_PREFIX = 'new:';

// Base64url tokens never contain it, and it is a legal cookie octet.
const SESSION_SEPARATOR = '~';

// A tab is a session now, so this is a limit on open tabs as much as on signed
// in accounts, and it is set where somebody with a lot of windows open will not
// meet it. The cookie stays under a kilobyte at the cap, and an attacker cannot
// grow it past that. The oldest goes when a new one would exceed it.
export const MAX_SESSIONS = 16;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * The public name of a session.
 *
 * A prefix of the stored hash rather than a column of its own: it is derived
 * from the token, so the two can never drift, and it gives away nothing. The
 * token is 256 random bits and lookup is by the *whole* hash, so knowing 64
 * bits of that hash does not let anyone present the session — which is what
 * makes it safe to put in a header, a URL and a list on screen.
 */
export const sessionIdOf = (tokenHash) => String(tokenHash || '').slice(0, 16);

/** Expired rows are dead weight and a session table should not accumulate them. */
const sweep = () => {
  const now = Date.now();
  return database().prepare(
    'DELETE FROM sessions WHERE absolute_expires_at <= ? OR last_seen_at + ? <= ?'
  ).run(now, IDLE_TTL_MS, now).changes;
};

/* --------------------------------------------------------------- lifecycle */

/**
 * Start a session and return the value the browser is to hold.
 *
 * The raw token is returned once and never stored, which is why there is no
 * "look up my session id" anywhere: the only copy lives in the cookie.
 */
export const createSession = (userId, { userAgent = '', ip = '' } = {}) => {
  if (!userId) throw new Error('A session must belong to an account.');
  sweep();

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  database().prepare(`
    INSERT INTO sessions
      (token_hash, user_id, created_at, last_seen_at, absolute_expires_at, csrf, user_agent, ip)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    hashToken(token), userId, now, now, now + ABSOLUTE_TTL_MS,
    crypto.randomBytes(32).toString('base64url'),
    // Recorded so a person can recognise their own sessions in a list. The
    // user agent is truncated because the full string is long and useless.
    String(userAgent).slice(0, 180),
    String(ip).slice(0, 64),
  );
  return token;
};

/**
 * Replace the id of a live session, keeping everything else.
 *
 * This is what makes session fixation impossible: whatever cookie the browser
 * arrived with is not the cookie it leaves with, so a value planted before
 * sign-in is worthless afterwards.
 */
export const rotateSession = (oldToken, { userId, userAgent = '', ip = '' } = {}) => {
  const db = database();
  const previous = oldToken
    ? db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(oldToken))
    : null;
  if (oldToken) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(oldToken));

  const owner = userId || previous?.user_id;
  if (!owner) throw new Error('A session must belong to an account.');

  // Signing a tab into a *different* account is a new session, not a rotation
  // of the old one. Inheriting the clocks there would hand the arriving account
  // whatever was left of the departing one's, which is neither person's answer
  // to "how long have I been signed in".
  const carried = previous?.user_id === owner ? previous : null;

  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions
      (token_hash, user_id, created_at, last_seen_at, absolute_expires_at, csrf, user_agent, ip)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    hashToken(token), owner,
    // A rotation does not restart the absolute clock; that is the point of it
    // being absolute.
    carried?.created_at || now,
    now,
    carried?.absolute_expires_at || now + ABSOLUTE_TTL_MS,
    crypto.randomBytes(32).toString('base64url'),
    String(userAgent).slice(0, 180) || carried?.user_agent || '',
    String(ip).slice(0, 64) || carried?.ip || '',
  );
  return token;
};

/**
 * A second session for whoever already holds this one.
 *
 * What a newly opened tab gets. It is not a sign-in — nobody proved anything
 * here — so the clocks are the source's rather than fresh: the same sign-in is
 * being looked at through another window, and a new window must not extend how
 * long that sign-in lasts. Two things are its own: the token, so it can be
 * ended alone, and the CSRF token, so it cannot act for any other tab.
 *
 * The alternative was to let both tabs share one session, and that is precisely
 * the bug — a tab cannot sign itself out of a session another tab is using.
 */
export const forkSession = (sourceToken, { userAgent = '', ip = '' } = {}) => {
  const db = database();
  const source = sourceToken
    ? db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(sourceToken))
    : null;
  if (!source) return '';

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`
    INSERT INTO sessions
      (token_hash, user_id, created_at, last_seen_at, absolute_expires_at, csrf, user_agent, ip)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    hashToken(token), source.user_id,
    source.created_at, Date.now(), source.absolute_expires_at,
    crypto.randomBytes(32).toString('base64url'),
    String(userAgent).slice(0, 180) || source.user_agent || '',
    String(ip).slice(0, 64) || source.ip || '',
  );
  return token;
};

/**
 * The session behind a cookie value, or null.
 *
 * Reading a session slides its idle clock, which is what makes an active
 * browser stay signed in and an abandoned one not.
 */
export const readSession = (token) => {
  if (!token) return null;
  const db = database();
  const key = hashToken(token);
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(key);
  if (!row) return null;

  const now = Date.now();
  if (row.absolute_expires_at <= now || row.last_seen_at + IDLE_TTL_MS <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(key);
    return null;
  }

  if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, key);
  }

  return {
    key,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: now,
    absoluteExpiresAt: row.absolute_expires_at,
    csrf: row.csrf,
    userAgent: row.user_agent || '',
    ip: row.ip || '',
  };
};

export const destroySession = (token) => {
  if (!token) return false;
  return database().prepare('DELETE FROM sessions WHERE token_hash = ?')
    .run(hashToken(token)).changes > 0;
};

/**
 * End every session belonging to an account.
 *
 * A password change has to do this or changing it after a laptop is stolen
 * accomplishes nothing. `keepToken` is how "sign out my other devices" leaves
 * the one in front of you alone.
 */
export const destroyUserSessions = (userId, { keepToken = null } = {}) => {
  const db = database();
  if (keepToken) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .run(userId, hashToken(keepToken)).changes;
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
};

/** What a person should be able to see about their own sessions. */
export const listUserSessions = (userId, currentToken = null) => {
  sweep();
  const currentKey = currentToken ? hashToken(currentToken) : null;
  return database().prepare(
    'SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC'
  ).all(userId).map(row => ({
    id: sessionIdOf(row.token_hash),
    current: row.token_hash === currentKey,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: Math.min(row.absolute_expires_at, row.last_seen_at + IDLE_TTL_MS),
    userAgent: row.user_agent || '',
    ip: row.ip || '',
  }));
};

/* ------------------------------------------------------------------ cookies */

export const readCookie = (req, name) => {
  const raw = req.headers?.cookie || '';
  const match = raw.match(new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
};

/**
 * Every session id this browser is carrying, oldest first.
 *
 * Duplicates and anything past the cap are dropped here rather than trusted:
 * the cookie is client-controlled, and a request that arrives with two hundred
 * repeated values must not turn into two hundred database lookups.
 */
export const sessionTokensOf = (req) => {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return [];
  const seen = new Set();
  const tokens = [];
  for (const part of raw.split(SESSION_SEPARATOR)) {
    const token = part.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens.slice(-MAX_SESSIONS);
};

/** Which session this tab asked to act as, if it said. */
export const requestedSessionId = (req) => String(req.headers?.[SESSION_ID_HEADER] || '').trim();

/**
 * What a tab is asking for, in the two parts that matter.
 *
 * `id` names a session — empty meaning "whichever is newest" — and `fork` says
 * whether the tab wants a session of its own on that account rather than a
 * share of the one it named.
 */
export const sessionRequest = (req) => {
  const wanted = requestedSessionId(req);
  if (wanted === NEW_SESSION_ID) return { fork: true, id: '' };
  if (wanted.startsWith(NEW_SESSION_PREFIX)) {
    return { fork: true, id: wanted.slice(NEW_SESSION_PREFIX.length) };
  }
  return { fork: false, id: wanted };
};

/** Those of a token list that still resolve, in the order they were given. */
export const liveTokens = (tokens) => (tokens || []).filter(token => !!readSession(token));

/**
 * The session this request is acting as, and the set it came from.
 *
 * Three cases, and the difference between them is the whole point:
 *
 *   * A tab that named a session gets that one or nothing. Never a fallback —
 *     falling back is how a tab whose session was just ended would silently
 *     start acting as whichever account happened to be next in the cookie.
 *   * A tab that said `guest` gets nothing, deliberately: it is signed out here
 *     while other tabs are not.
 *   * A tab that said `new`, or said nothing at all, gets the newest live
 *     session — the account most recently signed into on this browser.
 *   * A tab that said `new:<id>` gets that one, exactly as if it had named it.
 *
 * The `new` forms additionally mean the tab wants a session of its own rather
 * than a share of the one it landed on, and the session route is where it gets
 * forked one. Here they resolve the same way, because acting as the session
 * they name is the right answer everywhere else — including a plain navigation,
 * which names nothing at all.
 */
export const pickSession = (req) => {
  const tokens = sessionTokensOf(req);
  const { id } = sessionRequest(req);

  if (id === GUEST_SESSION_ID) return { tokens, token: '', session: null };

  if (id) {
    // Hashing is cheap; a database read per candidate is not, so the match is
    // found first and only the winner is loaded.
    const token = tokens.find(t => sessionIdOf(hashToken(t)) === id) || '';
    return { tokens, token, session: token ? readSession(token) : null };
  }

  return pickNewest(tokens);
};

const pickNewest = (tokens) => {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const session = readSession(tokens[i]);
    if (session) return { tokens, token: tokens[i], session };
  }
  return { tokens, token: '', session: null };
};

/**
 * Whether this request arrived over TLS.
 *
 * `Secure` cannot simply be hardcoded: on a LAN over plain HTTP the browser
 * drops a Secure cookie silently and sign-in loops forever with no error
 * anywhere. It is set when — and only when — the connection can carry it.
 */
export const isSecureRequest = (req) => {
  if (req.socket?.encrypted) return true;
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https';
};

const cookie = (name, value, { maxAge, secure, httpOnly }) => [
  `${name}=${value}`,
  'Path=/',
  'SameSite=Lax',
  httpOnly ? 'HttpOnly' : '',
  secure ? 'Secure' : '',
  `Max-Age=${maxAge}`,
].filter(Boolean).join('; ');

const appendCookie = (res, value) => {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('Set-Cookie', [...list, value]);
};

/**
 * Write the whole set of sessions this browser holds.
 *
 * Two cookies, deliberately different: the session cookie is HttpOnly so script
 * can never read it, and the CSRF token is not, because the page has to echo it
 * back in a header. A token script can read is not a weakness here — the point
 * is that a *different origin's* script cannot read it, and same-origin policy
 * is what guarantees that.
 *
 * The session cookie holds every session, separated. That is what lets two tabs
 * be two people: the browser sends all of them and the tab picks. The tab's
 * choice travels in a header rather than in the cookie because a header is
 * something only this origin's script can set — a cross-site request cannot
 * choose which of the victim's accounts it acts as, it gets whatever the cookie
 * says, and CSRF then stops it regardless.
 *
 * Only one CSRF token fits in a cookie, so the one written is the acting
 * session's. Nothing reads it: the client takes its token from the JSON body of
 * the session reply, which is per-session and cannot be confused between tabs.
 * The cookie is kept because a token the page can read is the conventional
 * shape of this and costs nothing.
 */
export const attachSessions = (req, res, tokens, csrf = '') => {
  const list = (tokens || []).filter(Boolean).slice(-MAX_SESSIONS);
  if (!list.length) return clearSessionCookies(req, res);

  const secure = isSecureRequest(req);
  const maxAge = Math.floor(ABSOLUTE_TTL_MS / 1000);
  appendCookie(res, cookie(SESSION_COOKIE, list.join(SESSION_SEPARATOR), { maxAge, secure, httpOnly: true }));
  // No acting session means this tab is the guest, so its CSRF token goes
  // rather than lingering as a value that names nothing.
  appendCookie(res, csrf
    ? cookie(CSRF_COOKIE, csrf, { maxAge, secure, httpOnly: false })
    : cookie(CSRF_COOKIE, '', { maxAge: 0, secure, httpOnly: false }));
};

export const clearSessionCookies = (req, res) => {
  const secure = isSecureRequest(req);
  appendCookie(res, cookie(SESSION_COOKIE, '', { maxAge: 0, secure, httpOnly: true }));
  appendCookie(res, cookie(CSRF_COOKIE, '', { maxAge: 0, secure, httpOnly: false }));
};

/* --------------------------------------------------------------------- CSRF */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a state-changing request carries proof it came from this app.
 *
 * A cross-site form post arrives with the session cookie attached — that is
 * what cookies do — but it cannot read the response of anything, and so cannot
 * learn the token bound to that session. Requiring the token in a header is
 * what separates "the browser sent this" from "the page sent this".
 *
 * Requests with no session are exempt: there is nothing to ride on, and login
 * itself is a POST that necessarily happens before any token exists.
 */
export const csrfOk = (req, session) => {
  if (SAFE_METHODS.has(req.method)) return true;
  if (!session) return true;
  const presented = String(req.headers?.[CSRF_HEADER] || '');
  if (!presented || !session.csrf) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(session.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/* ---------------------------------------------------------- login throttling */

// Guessing a password over the network should get slower, and an attacker who
// sprays one password across many accounts should be stopped by the address
// they are coming from rather than by any single account's counter.
//
// In memory on purpose: a lockout is meaningful for minutes, and persisting it
// would mean a write per failed attempt for state that must not outlive a
// restart anyway.
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attemptKey = (ip, email) => `${ip}|${String(email || '').toLowerCase()}`;

export const throttleState = (ip, email) => {
  const key = attemptKey(ip, email);
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.until <= now) {
    if (record) attempts.delete(key);
    return { blocked: false, retryAfterMs: 0, remaining: MAX_ATTEMPTS };
  }
  if (record.count >= MAX_ATTEMPTS) {
    return { blocked: true, retryAfterMs: record.until - now, remaining: 0 };
  }
  return { blocked: false, retryAfterMs: 0, remaining: MAX_ATTEMPTS - record.count };
};

export const recordFailedLogin = (ip, email) => {
  const key = attemptKey(ip, email);
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.until <= now) {
    attempts.set(key, { count: 1, until: now + ATTEMPT_WINDOW_MS });
    return;
  }
  record.count++;
  // Each failure past the limit pushes the window out, so hammering keeps it
  // shut rather than letting it lapse on schedule.
  if (record.count >= MAX_ATTEMPTS) record.until = now + ATTEMPT_WINDOW_MS;
};

export const clearFailedLogins = (ip, email) => { attempts.delete(attemptKey(ip, email)); };

/** Only used for throttling, so a spoofed header costs the spoofer, not us. */
export const clientIp = (req) => {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || '';
};

// Exposed for tests, which need to start from a known state.
export const _resetForTests = () => { attempts.clear(); };
