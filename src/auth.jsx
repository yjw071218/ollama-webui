// Getting a provider to hand us a credential. Nothing more.
//
// This file used to be an account system: a user table in IndexedDB, PBKDF2 in
// the browser, its own sessions, its own passkey verification. All of it is
// gone, and none of it was replaced here — identity moved to the server, where
// it belongs, and the client's side of it lives in session.jsx.
//
// What is left is genuinely browser work: loading Google's script, rendering
// its button, starting Kakao's redirect, and reading what the redirect left in
// the address bar. Each of these ends by handing a credential to the server,
// which decides what it means. Nothing here decides who anybody is.

import { api } from './session.jsx';

/* =========================================================================
   Provider configuration
   ========================================================================= */

// Filled in from /api/config at boot. Serving the identifiers at runtime is
// what lets a phone — a different origin, with its own empty localStorage — get
// a working sign-in button without anyone pasting keys in.
let serverProvided = { googleClientId: '', kakaoRestKey: '' };

export const setServerSocialConfig = (config) => {
  serverProvided = {
    googleClientId: config?.googleClientId || '',
    kakaoRestKey: config?.kakaoRestKey || '',
  };
};

export const socialConfig = () => ({
  googleClientId: localStorage.getItem('googleClientId')
    || serverProvided.googleClientId
    || import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
  // Kakao's code exchange needs the REST API key; the JavaScript key cannot be
  // used for it. An older stored JS key is ignored rather than silently
  // producing an invalid_client error.
  kakaoRestKey: localStorage.getItem('kakaoRestKey')
    || serverProvided.kakaoRestKey
    || import.meta.env?.VITE_KAKAO_REST_KEY || '',
});

// What is in effect without anything stored in this browser — which is what a
// settings box should show as the placeholder rather than as a value.
export const socialDefaults = () => ({
  googleClientId: serverProvided.googleClientId || import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
  kakaoRestKey: serverProvided.kakaoRestKey || import.meta.env?.VITE_KAKAO_REST_KEY || '',
});

/* =========================================================================
   Google
   ========================================================================= */

const loadScriptOnce = (id, src) => new Promise((resolve, reject) => {
  const existing = document.getElementById(id);
  if (existing) {
    if (existing.dataset.loaded === 'true') return resolve();
    existing.addEventListener('load', () => resolve(), { once: true });
    existing.addEventListener('error', () => reject(new Error(`Could not load ${src}`)), { once: true });
    return;
  }
  const script = document.createElement('script');
  script.id = id;
  script.src = src;
  script.async = true;
  script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
  script.onerror = () => reject(new Error(`Could not load ${src}`));
  document.head.appendChild(script);
});

/**
 * Decode the payload of a JWT, for display only.
 *
 * Deliberately not used to decide anything. There is no signature check here
 * and there cannot be a meaningful one — the server verifies the token against
 * Google, and that is the only reading of it that counts.
 */
export const decodeJwtPayload = (token) => {
  const parts = String(token || '').split('.');
  if (parts.length < 2) throw new Error('Malformed token');
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const json = decodeURIComponent(
    atob(padded)
      .split('')
      .map(c => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`)
      .join('')
  );
  return JSON.parse(json);
};

/**
 * Render Google's own button into `container`.
 *
 * This is the reliable path: One Tap (`prompt()`) is suppressed whenever
 * third-party cookies are blocked, the user dismissed it recently, or no Google
 * session exists — in all of which the old flow silently produced "invalid
 * credentials". The rendered button always works.
 *
 * `onCredential` receives the raw ID token. What it means is the server's to
 * say; this function does not look inside it.
 */
export const renderGoogleButton = async (container, { onCredential, onError, locale, theme = 'outline' } = {}) => {
  const { googleClientId } = socialConfig();
  if (!googleClientId) return { error: 'auth.notConfigured' };
  if (!container) return { error: 'auth.googleFailed' };

  try {
    await loadScriptOnce('google-gsi', 'https://accounts.google.com/gsi/client');
  } catch (e) {
    return { error: 'auth.googleScript' };
  }
  if (!window.google?.accounts?.id) return { error: 'auth.googleScript' };

  window.google.accounts.id.initialize({
    client_id: googleClientId,
    callback: (response) => {
      if (!response?.credential) return onError?.({ error: 'auth.googleFailed' });
      onCredential?.(response.credential);
    },
    auto_select: false,
    cancel_on_tap_outside: true,
    use_fedcm_for_prompt: true,
  });

  container.innerHTML = '';
  window.google.accounts.id.renderButton(container, {
    type: 'standard',
    theme,
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'left',
    width: Math.min(Math.round(container.clientWidth) || 320, 400),
    locale,
  });

  return { rendered: true };
};

/**
 * Let Google forget the automatic choice.
 *
 * Without this a sign-out is undone by the next visit: One Tap picks the same
 * account again without asking, which on a shared computer means the previous
 * person is back.
 */
export const forgetGoogleAutoSelect = () => {
  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch (e) {
    // Signing out must succeed even if a provider SDK misbehaves.
  }
};

/* =========================================================================
   Kakao
   ========================================================================= */

export const kakaoRedirectUri = () => `${window.location.origin}/kakao/callback`;

/**
 * Kakao Login, authorization-code grant.
 *
 * The JS SDK v2 removed `Kakao.Auth.login()`, and Kakao's token endpoint
 * neither allows browser calls (no CORS) nor accepts the JavaScript key — it
 * wants the REST API key. So the server starts it, the server exchanges the
 * code, and the browser comes back already holding a session.
 */
export const signInWithKakao = async () => {
  const redirectUri = kakaoRedirectUri();

  // The state has to be issued by whoever will verify it — a value this page
  // invents and this page checks says nothing about a forged callback.
  let start;
  try {
    // Through `api` for the session header: the state issued here remembers
    // which tab started the sign-in, and the callback uses that to replace this
    // tab's session rather than whichever one another tab is holding.
    start = await api(`/kakao/start?redirect_uri=${encodeURIComponent(redirectUri)}`);
  } catch (e) {
    // 501 is the server saying Kakao was never set up here, which is a
    // different thing to tell someone than "it failed".
    return e.status === 501
      ? { error: 'auth.notConfigured', detail: e.message }
      : { error: 'auth.kakaoFailed', detail: e.message };
  }

  // A full navigation, not a popup. Popups are blocked by default in plenty of
  // browsers and are miserable on a phone, and a redirect is what both Kakao's
  // documentation and the redirect URI itself describe.
  window.location.assign(start.authorizeUrl);
  return { redirecting: true };
};

/**
 * What the callback left in the address bar, if anything.
 *
 * The login finishes on the server and ends in a redirect, so its outcome
 * arrives as a query parameter rather than a return value. Reading it clears
 * it, so a refresh does not report the same thing twice.
 */
export const readKakaoOutcome = () => {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('kakao');
  if (!outcome) return null;

  const detail = params.get('detail') || '';
  params.delete('kakao');
  params.delete('detail');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));

  return { outcome, detail };
};

/**
 * Sever the connection between this app and the Kakao account.
 *
 * Distinct from logging out, and what 연결 끊기 means: the app's permission is
 * withdrawn and the next sign-in asks for consent again. Signing out already
 * ends the Kakao session server-side, so there is no separate call for that.
 */
export const kakaoUnlink = async () => {
  try {
    return await api('/kakao/unlink', { method: 'POST' });
  } catch (e) {
    return { success: false, error: e.message };
  }
};

/**
 * Whether this account still holds a live Kakao connection.
 *
 * Through `api` rather than a bare fetch, so it carries the header naming which
 * of this browser's sessions is asking. A raw fetch would be answered for
 * whichever account signed in most recently — which, with two tabs open, is
 * frequently not the one on this screen.
 */
export const kakaoStatus = async () => {
  try {
    return await api('/kakao/status');
  } catch (e) {
    return { success: false, connected: false };
  }
};

/* =========================================================================
   Avatars
   ========================================================================= */

const AVATAR_SIZE = 160;

/**
 * Square and shrink an uploaded image before it is stored, so a profile picture
 * cannot bloat the account's state with a multi-megabyte data URL.
 */
export const prepareAvatar = (file) => new Promise((resolve, reject) => {
  if (!file || !file.type.startsWith('image/')) return reject(new Error('Not an image'));

  const reader = new FileReader();
  reader.onerror = () => reject(new Error('Could not read the image'));
  reader.onload = () => {
    const image = new Image();
    image.onerror = () => reject(new Error('Could not decode the image'));
    image.onload = () => {
      const side = Math.min(image.width, image.height);
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        image,
        (image.width - side) / 2, (image.height - side) / 2, side, side,
        0, 0, AVATAR_SIZE, AVATAR_SIZE
      );
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    image.src = reader.result;
  };
  reader.readAsDataURL(file);
});

/* =========================================================================
   Storage keys
   ========================================================================= */

/**
 * Where a scope's chats live.
 *
 * The guest keeps the bare key, which is not only tidiness: every install that
 * existed before any of this has its chats there, and the guest is who they
 * belong to until somebody signs in and adopts them.
 */
export const sessionStorageKeyFor = (scope) => (
  scope ? `ollama-sessions:${scope}` : 'ollama-sessions'
);
