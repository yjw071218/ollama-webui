// Getting a provider to hand us a credential. Nothing more.
//
// This file used to be an account system: a user table in IndexedDB, PBKDF2 in
// the browser, its own sessions, its own passkey verification. All of it is
// gone, and none of it was replaced here — identity moved to the server, where
// it belongs, and the client's side of it lives in session.jsx.
//
// What is left is genuinely browser work: loading Google's script, rendering
// its button, and handing what it returns on. Each of these ends by handing a credential to the server,
// which decides what it means. Nothing here decides who anybody is.

import { api } from './session.jsx';

/* =========================================================================
   Provider configuration
   ========================================================================= */

// Filled in from /api/config at boot. Serving the identifiers at runtime is
// what lets a phone — a different origin, with its own empty localStorage — get
// a working sign-in button without anyone pasting keys in.
let serverProvided = { googleClientId: '' };

export const setServerSocialConfig = (config) => {
  serverProvided = {
    googleClientId: config?.googleClientId || '',
  };
};

export const socialConfig = () => ({
  googleClientId: localStorage.getItem('googleClientId')
    || serverProvided.googleClientId
    || import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
});

// What is in effect without anything stored in this browser — which is what a
// settings box should show as the placeholder rather than as a value.
export const socialDefaults = () => ({
  googleClientId: serverProvided.googleClientId || import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
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

  // A native gateway answers this locally; normal servers do not.
  let native = false, loopback = false;
  try {
    const response = await fetch('/__native/info', { cache: 'no-store' });
    const info = response.ok && response.headers.get('content-type')?.includes('application/json')
      ? await response.json() : {};
    native = info.nativeGoogle === true;
    loopback = native && info.googleLoopback === 47615;
  } catch {}
  if (native) {
    container.replaceChildren();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'auth-social-btn native-google';
    button.innerHTML = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.4 5.4 2.5 13.2l7.8 6.1C12.2 13.3 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.3z"/><path fill="#FBBC05" d="M10.3 28.7a14.6 14.6 0 010-9.4l-7.8-6.1a24 24 0 000 21.6l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.8-3.8-13.7-9.1l-7.8 6.1C6.4 42.6 14.6 48 24 48z"/></svg><span>Google 계정으로 계속하기</span>';
    container.appendChild(button);
    let attempt = 0;
    button.onclick = async () => {
      const currentAttempt = ++attempt;
      button.disabled = true;
      /* Read as text and parsed here: the app's loopback proxy answers a
         server it cannot reach with a plain sentence, and `response.json()` on
         that was "Unexpected token '서'" -- the whole sign-in abandoned over
         one dropped request. A failure that may pass (no connection, a
         gateway error, a body that is not JSON) is marked `transient`; the
         poll below waits it out rather than giving up. */
      const post = async (action, body) => {
        let response;
        try {
          response = await fetch('/api/auth/native/' + action, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
          });
        } catch (e) {
          throw Object.assign(new Error('서버에 연결하지 못했습니다. 네트워크를 확인하세요.'), { transient: true });
        }
        const text = await response.text().catch(() => '');
        let result = null;
        try { result = JSON.parse(text); } catch { /* below */ }
        if (!result || typeof result !== 'object') {
          throw Object.assign(new Error((text || `HTTP ${response.status}`).slice(0, 160)), {
            transient: response.status >= 500 || response.status === 0 || !response.ok,
          });
        }
        if (!response.ok) {
          throw Object.assign(new Error(result.error || 'Google 로그인 연결 실패'), { transient: response.status >= 500 });
        }
        return result;
      };
      // A start that met a dropped connection is simply asked again.
      const startWithRetry = async () => {
        for (let tries = 0; ; tries += 1) {
          try { return await post('start', {}); }
          catch (e) {
            if (!e.transient || tries >= 2) throw e;
            await new Promise(resolve => setTimeout(resolve, 1200));
          }
        }
      };
      try {
        const { id, secret } = await startWithRetry();
        if (currentAttempt !== attempt || !button.isConnected) return;
        /* Straight to Google's account chooser when the app can take the answer
           on loopback and the server has seen that redirect URI registered with
           Google; otherwise the server's page with the Google button. */
        let direct = false;
        if (loopback) {
          try {
            const ready = await fetch('/api/auth/native/google/ready', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
            direct = ready.ok && (await ready.json()).direct === true;
          } catch {}
          if (currentAttempt !== attempt || !button.isConnected) return;
        }
        window.location.assign('/__native/auth#' + (direct ? 'google:' + id + ':' + googleClientId : id));
        button.disabled = false; // Closing the browser must not lock out another attempt.
        const deadline = Date.now() + 300000;
        let lastTransient = null;
        while (Date.now() < deadline && button.isConnected) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (!button.isConnected || currentAttempt !== attempt) return;
          /* While the Google page is in front the app is in the background,
             and a tablet in particular may drop its connection for a moment.
             Those polls fail and the next one usually works. */
          let result;
          try { result = await post('poll', { id, secret }); }
          catch (e) {
            if (!e.transient) throw e;
            lastTransient = e;
            continue;
          }
          lastTransient = null;
          if (currentAttempt !== attempt) return;
          if (result.credential) { onCredential?.(result.credential); return; }
        }
        if (button.isConnected) throw lastTransient || new Error('로그인 시간이 만료되었습니다. 다시 시도하세요.');
      } catch (error) { if (currentAttempt === attempt) onError?.({ error: 'auth.googleFailed', detail: error.message }); }
      finally { if (currentAttempt === attempt) { button.disabled = false; } }
    };
    return { rendered: true };
  }

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
