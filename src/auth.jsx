import localforage from 'localforage';

/**
 * Device-local accounts.
 *
 * There is no server here, so this is a *profile* system: it separates chats
 * and settings per account on this machine. Passwords are stored as PBKDF2
 * hashes rather than plaintext, but anyone with access to this browser profile
 * can read the underlying IndexedDB. Treat it as separation, not as a security
 * boundary — the UI says so too.
 */

const USERS_KEY = 'ollama-users';
const SESSION_KEY = 'ollama-auth-session';
const PBKDF2_ITERATIONS = 210000; // OWASP 2023 guidance for PBKDF2-SHA512
const SESSION_DAYS = 30;

const store = localforage.createInstance({ name: 'ollama-webui', storeName: 'auth' });

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const fromBase64 = (text) => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const randomBytes = (length) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

export const randomId = () => toBase64(randomBytes(16)).replace(/[+/=]/g, '').slice(0, 20);

export const derivePasswordHash = async (password, saltB64, iterations = PBKDF2_ITERATIONS) => {
  const salt = saltB64 ? fromBase64(saltB64) : randomBytes(16);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
    key,
    256
  );
  return { hash: toBase64(bits), salt: toBase64(salt), iterations };
};

/** Length-independent comparison so a mismatch does not leak its position. */
export const constantTimeEqual = (a, b) => {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
};

export const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

export const loadUsers = async () => {
  const users = await store.getItem(USERS_KEY);
  return Array.isArray(users) ? users : [];
};

const saveUsers = (users) => store.setItem(USERS_KEY, users);

export const publicUser = (user) => user && ({
  id: user.id,
  email: user.email,
  name: user.name,
  provider: user.provider,
  avatar: user.avatar || '',
  createdAt: user.createdAt,
});

export const registerWithPassword = async ({ email, password, name }) => {
  const clean = normalizeEmail(email);
  if (!isValidEmail(clean)) return { error: 'auth.invalidEmail' };
  if (!password || password.length < 8) return { error: 'auth.passwordShort' };

  const users = await loadUsers();
  if (users.some(u => u.email === clean && u.provider === 'password')) {
    return { error: 'auth.emailTaken' };
  }

  const { hash, salt, iterations } = await derivePasswordHash(password);
  const user = {
    id: randomId(),
    email: clean,
    name: (name || '').trim() || clean.split('@')[0],
    provider: 'password',
    hash,
    salt,
    iterations,
    createdAt: Date.now(),
  };
  await saveUsers([...users, user]);
  return { user: publicUser(user) };
};

export const signInWithPassword = async ({ email, password }) => {
  const clean = normalizeEmail(email);
  const users = await loadUsers();
  const user = users.find(u => u.email === clean && u.provider === 'password');

  // Derive regardless of whether the account exists so a missing account and a
  // wrong password take the same amount of time.
  const salt = user?.salt || toBase64(randomBytes(16));
  const iterations = user?.iterations || PBKDF2_ITERATIONS;
  const { hash } = await derivePasswordHash(password || '', salt, iterations);

  if (!user || !constantTimeEqual(hash, user.hash)) return { error: 'auth.invalidCredentials' };
  return { user: publicUser(user) };
};

/** Upserts the account behind a social identity and returns it. */
export const upsertSocialUser = async ({ provider, providerId, email, name, avatar }) => {
  const users = await loadUsers();
  const clean = normalizeEmail(email);
  const existing = users.find(u => u.provider === provider && u.providerId === providerId);

  if (existing) {
    const updated = { ...existing, name: name || existing.name, avatar: avatar || existing.avatar, email: clean || existing.email };
    await saveUsers(users.map(u => (u.id === existing.id ? updated : u)));
    return { user: publicUser(updated) };
  }

  const user = {
    id: randomId(),
    provider,
    providerId,
    email: clean,
    name: name || clean.split('@')[0] || provider,
    avatar: avatar || '',
    createdAt: Date.now(),
  };
  await saveUsers([...users, user]);
  return { user: publicUser(user) };
};

/* =========================================================================
   Profile editing
   ========================================================================= */

/** Patches the stored record and returns the public view of it. */
export const updateUser = async (userId, patch) => {
  const users = await loadUsers();
  const existing = users.find(u => u.id === userId);
  if (!existing) return { error: 'auth.invalidCredentials' };

  const name = patch.name !== undefined ? String(patch.name).trim() : existing.name;
  if (patch.name !== undefined && !name) return { error: 'auth.nameRequired' };

  let email = existing.email;
  if (patch.email !== undefined) {
    const clean = normalizeEmail(patch.email);
    if (clean && !isValidEmail(clean)) return { error: 'auth.invalidEmail' };
    // Only password accounts key on email, so only they need uniqueness.
    if (clean && clean !== existing.email
        && users.some(u => u.id !== userId && u.provider === 'password' && u.email === clean)) {
      return { error: 'auth.emailTaken' };
    }
    email = clean;
  }

  const updated = {
    ...existing,
    name,
    email,
    avatar: patch.avatar !== undefined ? patch.avatar : existing.avatar,
  };

  await saveUsers(users.map(u => (u.id === userId ? updated : u)));
  return { user: publicUser(updated) };
};

export const changePassword = async (userId, currentPassword, nextPassword) => {
  const users = await loadUsers();
  const existing = users.find(u => u.id === userId);
  if (!existing) return { error: 'auth.invalidCredentials' };
  if (existing.provider !== 'password') return { error: 'auth.passwordUnavailable' };
  if (!nextPassword || nextPassword.length < 8) return { error: 'auth.passwordShort' };

  const { hash } = await derivePasswordHash(currentPassword || '', existing.salt, existing.iterations);
  if (!constantTimeEqual(hash, existing.hash)) return { error: 'auth.wrongCurrentPassword' };

  // A new salt on every change, so the stored hash never repeats.
  const next = await derivePasswordHash(nextPassword);
  const updated = { ...existing, hash: next.hash, salt: next.salt, iterations: next.iterations };
  await saveUsers(users.map(u => (u.id === userId ? updated : u)));
  return { user: publicUser(updated) };
};

const AVATAR_SIZE = 160;

/**
 * Squares and shrinks an uploaded image before it is stored, so a profile
 * picture cannot bloat IndexedDB with a multi-megabyte data URL.
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

export const deleteUser = async (userId) => {
  const users = await loadUsers();
  await saveUsers(users.filter(u => u.id !== userId));
  await localforage.removeItem(sessionStorageKeyFor(userId));
};

/** Chats are namespaced per profile; the guest keeps the original key. */
export const sessionStorageKeyFor = (userId) => (
  userId ? `ollama-sessions:${userId}` : 'ollama-sessions'
);

export const saveSession = (user) => {
  if (!user) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    userId: user.id,
    expiresAt: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  }));
};

export const readSession = () => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.userId || !parsed?.expiresAt || parsed.expiresAt < Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch (e) {
    return null;
  }
};

/* =========================================================================
   Social sign-in
   =========================================================================
   Both providers here are pure browser flows keyed by a *public* client
   identifier, so no client secret ever lives in this repo. The user supplies
   their own IDs in Settings -> Account.
   ========================================================================= */

// A build-time value from .env behaves like a real site: whoever opens the app
// just sees a working button. The stored value lets you override it at runtime.
export const socialConfig = () => ({
  googleClientId: localStorage.getItem('googleClientId') || import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
  // Kakao's code exchange needs the REST API key; the JavaScript key cannot
  // be used for it. An older stored JS key is ignored rather than silently
  // producing an invalid_client error.
  kakaoRestKey: localStorage.getItem('kakaoRestKey') || import.meta.env?.VITE_KAKAO_REST_KEY || '',
});

export const socialDefaults = () => ({
  googleClientId: import.meta.env?.VITE_GOOGLE_CLIENT_ID || '',
  kakaoRestKey: import.meta.env?.VITE_KAKAO_REST_KEY || '',
});

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

/** Decodes the payload of a JWT. Signature checking needs a server. */
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
 * Google Identity Services. The button flow returns an ID token (a JWT)
 * straight to the browser — no secret and no redirect needed.
 */
/** Turns an ID token into a stored profile. */
const acceptGoogleCredential = (credential) => {
  const payload = decodeJwtPayload(credential);
  return upsertSocialUser({
    provider: 'google',
    providerId: payload.sub,
    email: payload.email,
    name: payload.name || payload.given_name,
    avatar: payload.picture,
  });
};

/**
 * Renders Google's own button into `container`.
 *
 * This is the reliable path: One Tap (`prompt()`) is suppressed whenever
 * third-party cookies are blocked, the user dismissed it recently, or no
 * Google session exists — in all of which the old flow silently produced
 * "invalid credentials". The rendered button always works.
 */
export const renderGoogleButton = async (container, { onResult, locale, theme = 'outline' } = {}) => {
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
    callback: async (response) => {
      if (!response?.credential) {
        onResult?.({ error: 'auth.googleFailed' });
        return;
      }
      try {
        onResult?.(await acceptGoogleCredential(response.credential));
      } catch (err) {
        onResult?.({ error: 'auth.googleFailed', detail: err.message });
      }
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
 * One Tap. Kept as a manual fallback; `renderGoogleButton` is what the UI uses.
 * A blocked prompt now reports Google's own reason instead of a generic error.
 */
export const signInWithGoogle = async () => {
  const { googleClientId } = socialConfig();
  if (!googleClientId) return { error: 'auth.notConfigured' };

  try {
    await loadScriptOnce('google-gsi', 'https://accounts.google.com/gsi/client');
  } catch (e) {
    return { error: 'auth.googleScript' };
  }
  if (!window.google?.accounts?.id) return { error: 'auth.googleScript' };

  const outcome = await new Promise((resolve) => {
    let settled = false;
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: (response) => {
        settled = true;
        resolve({ credential: response?.credential || null });
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.prompt((notification) => {
      if (settled) return;
      if (notification.isNotDisplayed?.()) {
        resolve({ blocked: notification.getNotDisplayedReason?.() || 'not_displayed' });
      } else if (notification.isSkippedMoment?.()) {
        resolve({ blocked: notification.getSkippedReason?.() || 'skipped' });
      }
    });
  });

  if (outcome.blocked) return { error: 'auth.googleBlocked', detail: outcome.blocked };
  if (!outcome.credential) return { error: 'auth.googleFailed' };

  return acceptGoogleCredential(outcome.credential);
};

/** Kakao JavaScript SDK: the JS key is a public app key, not a secret. */
export const kakaoRedirectUri = () => `${window.location.origin}/kakao/callback`;

/**
 * Kakao Login, authorization-code grant.
 *
 * The JS SDK v2 removed `Kakao.Auth.login()`, and Kakao's token endpoint
 * neither allows browser calls (no CORS) nor accepts the JavaScript key —
 * it wants the REST API key. So the popup collects the code and the dev
 * server's /kakao/exchange middleware trades it for a profile.
 */
export const signInWithKakao = async () => {
  const { kakaoRestKey } = socialConfig();
  if (!kakaoRestKey) return { error: 'auth.notConfigured' };

  const redirectUri = kakaoRedirectUri();
  const state = randomId();

  const authorizeUrl = 'https://kauth.kakao.com/oauth/authorize?' + new URLSearchParams({
    client_id: kakaoRestKey,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    // No `scope`: Kakao then uses the consent items configured on the app,
    // instead of failing when a requested scope was never enabled.
  }).toString();

  const popup = window.open(authorizeUrl, 'kakao-login', 'width=480,height=720,menubar=no,toolbar=no');
  if (!popup) return { error: 'auth.popupBlocked' };

  const relay = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      resolve(value);
    };

    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== 'kakao-login') return;
      if (data.state !== state) return finish({ error: 'auth.kakaoFailed', detail: 'state mismatch' });
      if (data.error) return finish({ error: 'auth.kakaoFailed', detail: data.errorDescription || data.error });
      if (!data.code) return finish({ error: 'auth.kakaoCancelled' });
      finish({ code: data.code });
    };

    window.addEventListener('message', onMessage);

    // The popup being closed by hand is a cancellation, not a hang.
    const closedTimer = setInterval(() => {
      // Kakao renders KOE006 on its own domain and never redirects back, so a
      // closed popup with no code usually means the redirect URI is not
      // registered — say that rather than a bare "cancelled".
      if (popup.closed) finish({ error: 'auth.kakaoNoCode', detail: redirectUri });
    }, 500);

    setTimeout(() => finish({ error: 'auth.kakaoCancelled' }), 3 * 60 * 1000);
  });

  try { popup.close(); } catch (e) { /* already gone */ }

  if (relay.error) return relay;

  let data;
  try {
    const res = await fetch('/kakao/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: relay.code, restKey: kakaoRestKey, redirectUri }),
    });
    data = await res.json();
  } catch (err) {
    return { error: 'auth.kakaoFailed', detail: err.message };
  }

  if (!data?.success) return { error: 'auth.kakaoFailed', detail: data?.error || 'exchange failed' };

  return upsertSocialUser({
    provider: 'kakao',
    providerId: data.profile.id,
    email: data.profile.email,
    name: data.profile.name,
    avatar: data.profile.avatar,
  });
};

export const signOutSocial = () => {
  try {
    window.google?.accounts?.id?.disableAutoSelect?.();
  } catch (e) {
    // Signing out locally must succeed even if a provider SDK misbehaves.
  }
};

/* =========================================================================
   Passkeys (WebAuthn)
   =========================================================================
   The zero-configuration path. No provider to register with, no client ID,
   no redirect: the browser and the OS authenticator do the work, and the
   signature is verified here with WebCrypto against the public key captured
   at sign-up. On a device without a platform authenticator this simply
   reports that it is unavailable and the other methods still work.
   ========================================================================= */

const toBase64Url = (buffer) => toBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const isPasskeySupported = () => (
  typeof window !== 'undefined'
  && !!window.PublicKeyCredential
  && !!navigator.credentials?.create
);

/** True when this device can create a passkey without a roaming security key. */
export const hasPlatformAuthenticator = async () => {
  if (!isPasskeySupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    return false;
  }
};

/**
 * WebAuthn returns ECDSA signatures DER-encoded, while WebCrypto verifies the
 * raw r||s form. Both integers are left-padded to 32 bytes.
 */
export const derToRawEcdsaSignature = (der) => {
  const bytes = new Uint8Array(der);
  if (bytes[0] !== 0x30) throw new Error('Malformed ECDSA signature');

  // Skip the SEQUENCE tag and its (possibly long-form) length.
  let offset = 1;
  offset += (bytes[offset] & 0x80) ? 1 + (bytes[offset] & 0x7f) : 1;

  const readInteger = () => {
    if (bytes[offset] !== 0x02) throw new Error('Malformed ECDSA signature');
    const length = bytes[offset + 1];
    const value = bytes.slice(offset + 2, offset + 2 + length);
    offset += 2 + length;
    return value;
  };

  const pad = (value) => {
    let trimmed = value;
    while (trimmed.length > 32 && trimmed[0] === 0) trimmed = trimmed.slice(1);
    if (trimmed.length > 32) throw new Error('Malformed ECDSA signature');
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return out;
  };

  const r = pad(readInteger());
  const s = pad(readInteger());
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
};

const COSE_ALGORITHMS = {
  '-7': { name: 'ECDSA', importParams: { name: 'ECDSA', namedCurve: 'P-256' }, verifyParams: { name: 'ECDSA', hash: 'SHA-256' }, der: true },
  '-257': { name: 'RSASSA-PKCS1-v1_5', importParams: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, verifyParams: { name: 'RSASSA-PKCS1-v1_5' }, der: false },
};

const concatBytes = (a, b) => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(new Uint8Array(a), 0);
  out.set(new Uint8Array(b), a.byteLength);
  return out;
};

/** Verifies an assertion against the stored SPKI public key. */
export const verifyAssertion = async ({ publicKeySpki, algorithm, authenticatorData, clientDataJSON, signature }) => {
  const spec = COSE_ALGORITHMS[String(algorithm)];
  if (!spec) throw new Error(`Unsupported passkey algorithm ${algorithm}`);

  const key = await crypto.subtle.importKey(
    'spki',
    fromBase64(publicKeySpki),
    spec.importParams,
    false,
    ['verify']
  );

  const clientDataHash = await crypto.subtle.digest('SHA-256', clientDataJSON);
  const signedData = concatBytes(authenticatorData, clientDataHash);
  const sig = spec.der ? derToRawEcdsaSignature(signature) : new Uint8Array(signature);

  return crypto.subtle.verify(spec.verifyParams, key, sig, signedData);
};

const newChallenge = () => randomBytes(32);

export const registerPasskey = async ({ name }) => {
  if (!isPasskeySupported()) return { error: 'auth.passkeyUnsupported' };

  const displayName = (name || '').trim() || 'Passkey user';
  const userId = randomId();
  const challenge = newChallenge();

  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Ollama WebUI', id: window.location.hostname },
        user: {
          id: new TextEncoder().encode(userId),
          name: displayName,
          displayName,
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          residentKey: 'required',      // so sign-in needs no username
          requireResidentKey: true,
          userVerification: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') return { error: 'auth.passkeyCancelled' };
    return { error: 'auth.passkeyFailed', detail: err.message };
  }

  if (!credential) return { error: 'auth.passkeyCancelled' };

  const response = credential.response;
  if (typeof response.getPublicKey !== 'function') return { error: 'auth.passkeyUnsupported' };
  const spki = response.getPublicKey();
  if (!spki) return { error: 'auth.passkeyUnsupported' };

  const user = {
    id: userId,
    provider: 'passkey',
    credentialId: toBase64Url(credential.rawId),
    publicKeySpki: toBase64(spki),
    algorithm: response.getPublicKeyAlgorithm(),
    email: '',
    name: displayName,
    avatar: '',
    createdAt: Date.now(),
  };

  const users = await loadUsers();
  await saveUsers([...users, user]);
  return { user: publicUser(user) };
};

export const signInWithPasskey = async () => {
  if (!isPasskeySupported()) return { error: 'auth.passkeyUnsupported' };

  const users = await loadUsers();
  const passkeyUsers = users.filter(u => u.provider === 'passkey');
  if (passkeyUsers.length === 0) return { error: 'auth.passkeyNone' };

  const challenge = newChallenge();
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: window.location.hostname,
        // Empty list => the browser offers every discoverable passkey for this site.
        allowCredentials: [],
        userVerification: 'preferred',
        timeout: 60000,
      },
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') return { error: 'auth.passkeyCancelled' };
    return { error: 'auth.passkeyFailed', detail: err.message };
  }

  if (!assertion) return { error: 'auth.passkeyCancelled' };

  const credentialId = toBase64Url(assertion.rawId);
  const user = passkeyUsers.find(u => u.credentialId === credentialId);
  if (!user) return { error: 'auth.passkeyUnknown' };

  // Confirm the assertion really was signed by the key we stored, and that the
  // authenticator echoed back the challenge we just generated.
  const clientData = JSON.parse(new TextDecoder().decode(assertion.response.clientDataJSON));
  if (clientData.type !== 'webauthn.get') return { error: 'auth.passkeyFailed' };
  if (clientData.challenge !== toBase64Url(challenge)) return { error: 'auth.passkeyFailed' };

  const valid = await verifyAssertion({
    publicKeySpki: user.publicKeySpki,
    algorithm: user.algorithm,
    authenticatorData: assertion.response.authenticatorData,
    clientDataJSON: assertion.response.clientDataJSON,
    signature: assertion.response.signature,
  });
  if (!valid) return { error: 'auth.passkeyFailed' };

  return { user: publicUser(user) };
};
