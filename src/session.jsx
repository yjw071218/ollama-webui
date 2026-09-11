// Who is signed in. One answer, from one place.
//
// This file exists because there used to be two answers. A browser-local
// account system kept its own users, its own password hashes and its own
// "current profile" in IndexedDB, while the server kept accounts of its own.
// Storage keys were derived from whichever of the two was consulted, and the
// two disagreed constantly — most reliably during boot, when the local answer
// arrived immediately and the server's took a round trip. Anything written in
// between went into the wrong bucket, and the state sync then uploaded it,
// which is how one person's chats ended up inside another person's account.
//
// The rule now is the one every real site follows: the server owns identity,
// the browser holds an opaque session cookie, and the client's only way to know
// who it is, is to ask. Three consequences follow, and all three matter:
//
//   * There is exactly one moment when identity is unknown — before the first
//     answer — and it is represented explicitly as `loading` rather than as
//     "signed out", which is what silently pointed the app at the guest's data.
//   * Nothing account-scoped may be read or written while it is unknown. The
//     provider renders nothing but a splash until it is not.
//   * A change of identity is not a state update to be reconciled. It is a
//     different person, and the app is remounted from scratch.
//
// The fourth consequence took longer to see. A cookie belongs to an origin, not
// to a tab, so one cookie holding one session made every tab one identity:
// signing out of one signed out the rest, and two accounts could not be open
// side by side at all. The cookie now holds a *set* of sessions and each tab
// names the one it is using. That name is the only thing in this app that is
// genuinely per-tab, and it lives in the only per-tab store there is.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

const SessionContext = createContext(null);

// A sign-in or sign-out anywhere in this browser reaches the other tabs. They
// no longer have to *obey* it — each one keeps whichever session it pinned —
// but they do have to re-read, because the set of accounts they can offer to
// switch to has changed, and because the session they are holding may be one of
// the ones that just ended.
const CHANNEL = 'ollama-webui-auth';

/** Raised for a request the server refused; carries the code it sent. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ this tab */

// Which of the browser's sessions this tab is acting as.
//
// sessionStorage rather than localStorage, and that is the entire point: it is
// per-tab, it survives a reload of that tab, and a second tab starts without
// it. A previous version of this app kept a whole *profile* here and that was
// wrong — the profile decided which storage bucket to write, so a tab could be
// signed out on the server while still writing an account's chats. This is the
// opposite: it stores no identity at all, only which session to ask about. The
// server still decides who that is, and can answer "nobody".
const TAB_KEY = 'webui-tab-session';

// Sent when the tab is signed out on purpose while other tabs are not.
const GUEST = 'guest';

// Sent by a tab that has not been given a session of its own yet, which is what
// a newly opened tab is. It means "a handle on whoever is signed in here", and
// the server answers by forking one — so the tab lands on the account you were
// already using, holding a session it can end without ending anybody else's.
//
// Distinguishing this from sending nothing is the fix for the original bug. Two
// tabs opened on the same account used to be handed the same session, and a tab
// cannot sign itself out of a session another tab is using: sign out of one and
// the other went with it, which is exactly what it looked like from outside.
const NEW = 'new';

let tabSessionId = NEW;

const rememberTab = (id) => {
  tabSessionId = id || null;
  try {
    if (id) sessionStorage.setItem(TAB_KEY, id);
    else sessionStorage.removeItem(TAB_KEY);
  } catch (e) {
    // Private mode, or storage refused. The tab still works; it simply follows
    // the newest session instead of holding one of its own.
  }
};

/**
 * The session a redirect sign-in left in the address bar.
 *
 * Kakao finishes with a full navigation, and a navigation cannot carry the
 * header a tab identifies itself with — so the tab comes back not knowing which
 * session is now its own, and the cookie is HttpOnly, so it cannot look. The
 * server puts the id in the URL. It names a session without being able to
 * present one, so this leaks nothing that mattered.
 *
 * Read once and stripped, so a reload or a shared link does not re-pin the tab.
 */
const claimSessionFromUrl = () => {
  try {
    const params = new URLSearchParams(globalThis.location?.search || '');
    const sid = params.get('sid');
    if (!sid) return null;
    params.delete('sid');
    const query = params.toString();
    globalThis.history?.replaceState(
      {}, '',
      globalThis.location.pathname + (query ? `?${query}` : '') + (globalThis.location.hash || ''),
    );
    return sid;
  } catch (e) {
    return null;
  }
};

// Before the first request, because the first request is the one that has to
// carry it.
(() => {
  const fromUrl = claimSessionFromUrl();
  if (fromUrl) return rememberTab(fromUrl);
  // Not persisted: NEW is the absence of a session, and writing it would make
  // a reloaded tab ask for a second one.
  try { tabSessionId = sessionStorage.getItem(TAB_KEY) || NEW; } catch (e) { tabSessionId = NEW; }
})();

/** Which session this tab is holding, or `new` while it has yet to be given one. */
export const currentTabSession = () => tabSessionId;

/* ------------------------------------------------------------------ requests */

let csrfToken = null;

/** So a module outside React can still make an authenticated call. */
export const currentCsrfToken = () => csrfToken;

/**
 * Every call to our own API goes through here.
 *
 * Three things it guarantees. The session cookie is sent — `same-origin` rather
 * than the default, because the cookie is HttpOnly and there is nothing else
 * identifying the caller. Every state-changing request carries the CSRF token,
 * which is what separates "the browser sent this" from "this page sent this": a
 * cross-site form post arrives with the cookie attached and cannot ever learn
 * the token. And every request says which of the browser's sessions it is
 * acting as, so a tab keeps its own account no matter what the others do.
 *
 * That last one is a header rather than anything the cookie carries, and it has
 * to be: a header is something only this origin's script can set. A cross-site
 * request cannot choose which of the victim's accounts it acts as — it gets
 * whatever the cookie's newest session is, and the CSRF check then refuses it.
 */
export const api = async (path, { method = 'GET', body, signal } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  headers['X-Session-Id'] = tabSessionId || NEW;

  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new ApiError('The server could not be reached.', { code: 'offline' });
  }

  const data = await response.json().catch(() => null);
  // The token rotates with the session, so it is picked up wherever it appears
  // rather than only at sign-in.
  if (data?.csrfToken) csrfToken = data.csrfToken;

  if (!response.ok || data?.success === false) {
    throw new ApiError(data?.error || `HTTP ${response.status}`, {
      status: response.status,
      code: data?.code || '',
    });
  }
  return data;
};

/* ------------------------------------------------------------------ provider */

const EMPTY = { user: null, csrfToken: null, state: null, anyAccounts: false, accounts: [] };

export const SessionProvider = ({ children, fallback = null }) => {
  // 'loading' is a real state, not an absence. Treating it as "signed out" is
  // precisely the bug this file was written to remove.
  const [status, setStatus] = useState('loading');
  const [session, setSession] = useState(EMPTY);
  const [error, setError] = useState(null);

  const lastUserId = useRef(undefined);

  const channel = useMemo(() => (
    typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
  ), []);

  const apply = useCallback((data) => {
    const next = {
      user: data?.user || null,
      csrfToken: data?.csrfToken || null,
      state: data?.state || null,
      anyAccounts: !!data?.anyAccounts,
      // Everyone signed in on this browser, this tab's own account included.
      accounts: Array.isArray(data?.accounts) ? data.accounts : [],
    };
    csrfToken = next.csrfToken;

    // The tab pins itself to whatever answered. A tab that arrived with no
    // preference was given the newest session; from now on it holds that one,
    // so another tab signing in or out cannot move it.
    if (data?.sessionId) rememberTab(data.sessionId);

    lastUserId.current = next.user?.id || null;

    setSession(next);
    setStatus('ready');
    return next;
  }, []);

  /** Ask the server who this is. The only way anything here learns that. */
  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/auth/session');
      setError(null);
      return apply(data);
    } catch (e) {
      // No backend, or it is down. Signed out is the truthful answer: without a
      // server there is no account, and the app runs as the guest. What must
      // not happen is staying in `loading` forever with a blank screen.
      setError(e);
      return apply(EMPTY);
    }
  }, [apply]);

  useEffect(() => { refresh(); }, [refresh]);

  // A sign-in or sign-out anywhere in this browser reaches every other tab.
  useEffect(() => {
    if (!channel) return undefined;
    const onMessage = (event) => {
      if (event.data?.type !== 'identity-changed') return;
      // Refetch rather than trusting the message: the other tab is telling us
      // that something changed, not what we are now. What comes back is pinned
      // to *this* tab's session, so an identity change elsewhere updates the
      // list of accounts here and leaves this tab's own account alone — unless
      // the session it is holding is one of the ones that just ended, which is
      // exactly when it should notice.
      refresh();
    };
    channel.addEventListener('message', onMessage);
    return () => channel.removeEventListener('message', onMessage);
  }, [channel, refresh]);

  const announce = useCallback(() => {
    try { channel?.postMessage({ type: 'identity-changed', at: Date.now() }); } catch (e) { /* closed */ }
  }, [channel]);

  /**
   * Adopt the result of a sign-in.
   *
   * Every sign-in route answers with the same shape — user, csrfToken, state,
   * and the id of the session it opened — so there is one path here regardless
   * of whether it was a password, Google or a passkey. Kakao is the exception
   * only in that it finishes with a redirect: the page that comes back reads
   * that id out of the address bar instead, and learns the rest from `refresh`.
   */
  const adopt = useCallback((data) => {
    const next = apply({ ...data, anyAccounts: true });
    announce();
    return next;
  }, [apply, announce]);

  /**
   * Sign out of this tab.
   *
   * One session ends, not the browser's. The request carries this tab's id, so
   * the server knows which of them to destroy; the tab then pins itself to the
   * guest so that re-reading does not quietly hand it the next account in the
   * cookie. Other tabs hear about it and re-read, and keep who they are.
   */
  const signOut = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // The session may already be gone; either way this tab is done with it,
      // and leaving the UI signed in would be the dangerous outcome.
    }
    rememberTab(GUEST);
    // Re-read rather than assuming: the accounts still signed in here are what
    // this tab now has to offer to switch back to.
    const next = await refresh();
    announce();
    return next;
  }, [refresh, announce]);

  /**
   * Show this tab the sign-in screen without ending anything.
   *
   * What "add an account" means. The account this tab was showing stays signed
   * in — other tabs may be using it, and it is one click away in the switcher —
   * but this tab stops acting as it, so the sign-in that follows adds a session
   * rather than replacing one.
   */
  const addAccount = useCallback(async () => {
    rememberTab(GUEST);
    return refresh();
  }, [refresh]);

  /**
   * Point this tab at an account already signed in on this browser.
   *
   * `new:` and not the id itself: the id names a session another tab may be
   * holding, and adopting it would put the two back to sharing one — so the
   * next sign-out in either would take both. The server forks instead, and the
   * reply re-pins this tab to the session it was given.
   */
  const switchTo = useCallback(async (sessionId) => {
    rememberTab(sessionId ? `${NEW}:${sessionId}` : GUEST);
    return refresh();
  }, [refresh]);

  const value = useMemo(() => ({
    status,
    user: session.user,
    anyAccounts: session.anyAccounts,
    accounts: session.accounts,
    stateInfo: session.state,
    error,
    refresh,
    adopt,
    signOut,
    addAccount,
    switchTo,
    // Convenience so callers do not have to remember the shape of a patch.
    setUser: (user) => setSession(current => ({ ...current, user })),
  }), [status, session, error, refresh, adopt, signOut, addAccount, switchTo]);

  if (status === 'loading') return fallback;

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = () => {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider.');
  return value;
};

/* ------------------------------------------------------------- the handoff */

// A change of identity remounts the whole app, which is the correct thing to do
// and means the component that started a sign-in is gone before the result can
// be shown. Anything that needs to survive that — a welcome message, the fact
// that a sign-out should land on the sign-in screen — is left here and picked
// up once by whatever mounts next.
//
// sessionStorage, not a module variable: a Kakao sign-in finishes with a full
// page navigation, so the message has to outlive the document too.

const HANDOFF_KEY = 'webui-auth-handoff';

export const leaveHandoff = (value) => {
  try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(value)); } catch (e) { /* private mode */ }
};

/** Reads it and clears it, so a reload does not replay the same message. */
export const takeHandoff = () => {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    sessionStorage.removeItem(HANDOFF_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

/* ------------------------------------------------------------ the sign-ins */

export const registerAccount = (name, email, password) =>
  api('/api/auth/register', { method: 'POST', body: { name, email, password } });

export const loginWithPassword = (email, password) =>
  api('/api/auth/login', { method: 'POST', body: { email, password } });

/** A Google ID token becomes a session here, verified server-side. */
export const loginWithGoogle = (credential) =>
  api('/api/auth/google', { method: 'POST', body: { credential } });

export const updateProfile = (patch) =>
  api('/api/auth/profile', { method: 'POST', body: patch });

export const changePassword = (currentPassword, newPassword) =>
  api('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } });

export const deleteAccount = () => api('/api/auth/account', { method: 'POST' });

export const listSessions = () => api('/api/auth/sessions');

/**
 * The app's public identity, served by the backend rather than compiled in.
 *
 * A client ID names the application, not the user, so serving it at runtime is
 * safe and means any origin the backend answers on gets a working sign-in
 * button without anyone pasting keys into a settings box. The Kakao client
 * secret is never part of this.
 */
export const fetchServerConfig = async () => {
  try {
    return await api('/api/config');
  } catch (e) {
    // No backend, or an older one: the app still works, just without this.
    return null;
  }
};

export const signOutOtherDevices = () => api('/api/auth/logout-others', { method: 'POST' });
