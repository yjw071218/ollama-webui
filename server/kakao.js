// Kakao Login, done the way the documentation says.
//
//   1. /oauth/authorize    the user consents, we get a code
//   2. /oauth/token        the code becomes an access token   (server only)
//   3. /v2/user/me         the token becomes a profile
//   4. /v1/user/logout     ends the Kakao session
//   5. /v1/user/unlink     severs the connection entirely
//
// Three things were missing before and each one matters:
//
// `state` was generated and compared in the browser. It exists to stop a forged
// callback being accepted, and the browser is exactly what is being defended,
// so the value has to be minted and checked here.
//
// The tokens were read once and thrown away. Kakao's access token expires in
// about six hours and comes with a refresh token; without keeping them there is
// no way to stay connected, and no way to log out or unlink either, because
// both of those are calls that need the token.
//
// And nothing ever called logout or unlink. Signing out of the app left the
// Kakao session standing, and deleting the profile left the connection.
//
// Tokens live on the server, under server/data, and never reach the browser.

import crypto from 'node:crypto';
import { database } from './db.js';

const AUTH_HOST = 'https://kauth.kakao.com';
const API_HOST = 'https://kapi.kakao.com';

// Long enough for a slow consent screen, short enough to be worth little to
// anyone who scrapes one.
const STATE_TTL_MS = 10 * 60 * 1000;

// Refresh a little before expiry rather than after a call has already failed.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const timeout = (ms) => AbortSignal.timeout(ms);

// ---------------------------------------------------------------- state

// In memory: a state is meaningful for minutes, and losing them on a restart
// only means one sign-in attempt has to be started again.
const pendingStates = new Map();

const sweepStates = () => {
  const now = Date.now();
  for (const [value, entry] of pendingStates) {
    if (entry.expires <= now) pendingStates.delete(value);
  }
};

/**
 * A state, and whatever the callback will need to know.
 *
 * `context` is carried rather than sent through the browser because the browser
 * is what this value exists to distrust. It holds which of this browser's
 * sessions started the sign-in, so the callback replaces that tab's session and
 * not some other tab's.
 */
export const issueState = (context = {}) => {
  sweepStates();
  const value = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(value, { expires: Date.now() + STATE_TTL_MS, context });
  return value;
};

/**
 * Accept a state exactly once, and hand back what was stored with it.
 *
 * Single use on purpose: a replayed callback carrying a state that has already
 * been spent is precisely what this is meant to reject. Null is the refusal,
 * and an object — possibly empty — is the acceptance.
 */
export const consumeState = (value) => {
  sweepStates();
  if (!value || !pendingStates.has(value)) return null;
  const { context } = pendingStates.get(value);
  pendingStates.delete(value);
  return context || {};
};

// ---------------------------------------------------------------- tokens
//
// These are a live credential for somebody's Kakao account, so they live beside
// the account they belong to rather than in a file named after it — which means
// deleting the account takes them with it, by foreign key, rather than by
// somebody remembering to unlink first.

export const readTokens = (userId) => {
  const row = database().prepare('SELECT * FROM kakao_tokens WHERE user_id = ?').get(userId);
  if (!row) return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    scope: row.scope || '',
  };
};

export const writeTokens = (userId, tokens) => {
  database().prepare(`
    INSERT INTO kakao_tokens
      (user_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      scope = excluded.scope
  `).run(
    userId,
    tokens.accessToken || null,
    tokens.refreshToken || null,
    tokens.accessTokenExpiresAt || null,
    tokens.refreshTokenExpiresAt || null,
    tokens.scope || null,
  );
};

export const clearTokens = (userId) =>
  database().prepare('DELETE FROM kakao_tokens WHERE user_id = ?').run(userId).changes > 0;

// Kakao returns lifetimes in seconds; storing an instant means the arithmetic
// is not repeated at every call site.
const withExpiry = (token, previous = {}) => ({
  accessToken: token.access_token,
  accessTokenExpiresAt: Date.now() + (Number(token.expires_in) || 0) * 1000,
  // A refresh response omits the refresh token unless it is being rotated, and
  // dropping the old one on that response would end the connection.
  refreshToken: token.refresh_token || previous.refreshToken || null,
  refreshTokenExpiresAt: token.refresh_token_expires_in
    ? Date.now() + Number(token.refresh_token_expires_in) * 1000
    : previous.refreshTokenExpiresAt || null,
  scope: token.scope || previous.scope || '',
  updatedAt: Date.now(),
});

// ---------------------------------------------------------------- the calls

const form = (fields) => new URLSearchParams(
  Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''),
);

const kakaoError = (payload, fallback) => {
  const code = payload?.error_code ? `${payload.error_code}: ` : '';
  return new Error(code + (payload?.error_description || payload?.error || payload?.msg || fallback));
};

/** Step 1: where to send the browser. */
export const authorizeUrl = ({ restKey, redirectUri, state, scope }) =>
  `${AUTH_HOST}/oauth/authorize?${form({
    client_id: restKey,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope,
  })}`;

/** Step 2: the code becomes tokens. Never done in a browser — it needs the secret. */
export const exchangeCode = async ({ code, restKey, redirectUri, clientSecret }) => {
  const res = await fetch(`${AUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: form({
      grant_type: 'authorization_code',
      client_id: restKey,
      redirect_uri: redirectUri,
      code,
      client_secret: clientSecret,
    }),
    signal: timeout(15000),
  });
  const payload = await res.json();
  if (!res.ok || !payload.access_token) throw kakaoError(payload, 'Token exchange failed');
  return withExpiry(payload);
};

/** Keeps a connection alive past the access token's few hours. */
export const refreshTokens = async ({ refreshToken, restKey, clientSecret, previous }) => {
  const res = await fetch(`${AUTH_HOST}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: form({
      grant_type: 'refresh_token',
      client_id: restKey,
      refresh_token: refreshToken,
      client_secret: clientSecret,
    }),
    signal: timeout(15000),
  });
  const payload = await res.json();
  if (!res.ok || !payload.access_token) throw kakaoError(payload, 'Token refresh failed');
  return withExpiry(payload, previous);
};

export const needsRefresh = (tokens) =>
  !!tokens?.refreshToken
  && (!tokens.accessToken || tokens.accessTokenExpiresAt - REFRESH_MARGIN_MS <= Date.now());

/**
 * A usable access token, refreshed if it is due.
 *
 * Every call that needs a token goes through here, so expiry is handled once
 * rather than being remembered at each call site.
 */
export const validAccessToken = async (userId, { restKey, clientSecret }) => {
  const tokens = readTokens(userId);
  if (!tokens) return null;
  if (!needsRefresh(tokens)) return tokens.accessToken;

  try {
    const next = await refreshTokens({
      refreshToken: tokens.refreshToken, restKey, clientSecret, previous: tokens,
    });
    writeTokens(userId, next);
    return next.accessToken;
  } catch (e) {
    // The refresh token is spent or revoked; the connection is over.
    clearTokens(userId);
    return null;
  }
};

/** Step 3: the profile, which is also what completes the connection. */
export const fetchProfile = async (accessToken) => {
  const res = await fetch(`${API_HOST}/v2/user/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeout(15000),
  });
  const payload = await res.json();
  if (!res.ok || !payload.id) throw kakaoError(payload, 'Profile request failed');

  const account = payload.kakao_account || {};
  const profile = account.profile || {};
  return {
    provider: 'kakao',
    providerId: String(payload.id),
    email: (account.email || '').toLowerCase(),
    emailVerified: account.is_email_verified === true,
    name: profile.nickname || payload.properties?.nickname || 'Kakao user',
    avatar: profile.profile_image_url || payload.properties?.profile_image || '',
  };
};

/** Step 4: end the Kakao session. Signing out of this app should mean this too. */
export const logout = async (accessToken) => {
  const res = await fetch(`${API_HOST}/v1/user/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeout(15000),
  });
  // An already-expired token means the session is gone, which is the goal.
  if (!res.ok && res.status !== 401) throw kakaoError(await res.json().catch(() => null), 'Logout failed');
  return true;
};

/** Step 5: sever the connection. What "연결 끊기" means, and what deleting an account should do. */
export const unlink = async (accessToken) => {
  const res = await fetch(`${API_HOST}/v1/user/unlink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: timeout(15000),
  });
  if (!res.ok && res.status !== 401) throw kakaoError(await res.json().catch(() => null), 'Unlink failed');
  return true;
};
