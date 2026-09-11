// The browser half of a passkey. Only the half a browser is allowed to do.
//
// What this file no longer contains is the interesting part. It used to
// generate its own challenge, store the public key in IndexedDB, and verify the
// resulting signature with WebCrypto — all in the page. That is a relying party
// implemented inside the thing it is meant to be authenticating: anyone who can
// run script here could write a record saying they were anybody, and the
// "verification" would agree.
//
// So the ceremony is the server's now. This asks for options, hands the
// authenticator's answer back, and does no checking of its own, because there
// is nothing it could check that an attacker in this position could not fake.

import { api } from './session.jsx';

const toBase64Url = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (text) => {
  const base64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const isPasskeySupported = () => (
  typeof window !== 'undefined'
  && !!window.PublicKeyCredential
  && !!navigator.credentials?.create
);

/** True when this device can make a passkey without a plugged-in security key. */
export const hasPlatformAuthenticator = async () => {
  if (!isPasskeySupported()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) {
    return false;
  }
};

/**
 * Whether the browser can fill a passkey straight into the sign-in form.
 *
 * This is what makes passkeys feel like nothing at all: the field offers the
 * credential the way it offers a saved password, with no button to find first.
 */
export const supportsAutofill = async () => {
  if (!isPasskeySupported()) return false;
  try {
    return await window.PublicKeyCredential.isConditionalMediationAvailable?.() ?? false;
  } catch (e) {
    return false;
  }
};

// The server sends base64url; `navigator.credentials` wants ArrayBuffers.
const decodeOptions = (publicKey) => ({
  ...publicKey,
  challenge: fromBase64Url(publicKey.challenge),
  ...(publicKey.user ? { user: { ...publicKey.user, id: fromBase64Url(publicKey.user.id) } } : {}),
  ...(publicKey.excludeCredentials ? {
    excludeCredentials: publicKey.excludeCredentials.map(c => ({ ...c, id: fromBase64Url(c.id) })),
  } : {}),
  ...(publicKey.allowCredentials ? {
    allowCredentials: publicKey.allowCredentials.map(c => ({ ...c, id: fromBase64Url(c.id) })),
  } : {}),
});

const friendly = (err) => {
  if (err?.name === 'NotAllowedError') return { error: 'auth.passkeyCancelled' };
  if (err?.name === 'InvalidStateError') return { error: 'auth.passkeyDuplicate' };
  if (err?.name === 'SecurityError') return { error: 'auth.passkeyOrigin', detail: err.message };
  return { error: 'auth.passkeyFailed', detail: err?.message || String(err) };
};

/**
 * Add a passkey to the account that is already signed in.
 *
 * Registration requires a session, which is the whole difference from before:
 * a passkey is a second way into an existing account, not a way to conjure one.
 */
export const addPasskey = async ({ label = '' } = {}) => {
  if (!isPasskeySupported()) return { error: 'auth.passkeyUnsupported' };

  let options;
  try {
    options = await api('/api/auth/passkey/register/options', { method: 'POST' });
  } catch (e) {
    return { error: 'auth.passkeyFailed', detail: e.message };
  }

  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: decodeOptions(options.publicKey) });
  } catch (err) {
    return friendly(err);
  }
  if (!credential) return { error: 'auth.passkeyCancelled' };

  try {
    const result = await api('/api/auth/passkey/register/verify', {
      method: 'POST',
      body: {
        challengeId: options.challengeId,
        credentialId: toBase64Url(credential.rawId),
        attestationObject: toBase64Url(credential.response.attestationObject),
        clientDataJSON: toBase64Url(credential.response.clientDataJSON),
        label,
      },
    });
    return { user: result.user, passkeys: result.passkeys };
  } catch (e) {
    return { error: 'auth.passkeyFailed', detail: e.message };
  }
};

/**
 * Sign in with a passkey.
 *
 * No username is asked for and none is sent. The credential itself names the
 * account, which is both nicer to use and means this cannot be used to find out
 * whether an address is registered.
 *
 * `conditional` is the autofill form: the prompt is attached to the sign-in
 * fields instead of interrupting, and it must be abandoned when the user starts
 * typing a password instead — hence the AbortSignal.
 */
export const signInWithPasskey = async ({ conditional = false, signal } = {}) => {
  if (!isPasskeySupported()) return { error: 'auth.passkeyUnsupported' };

  let options;
  try {
    options = await api('/api/auth/passkey/login/options', { method: 'POST' });
  } catch (e) {
    return { error: 'auth.passkeyFailed', detail: e.message };
  }

  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: decodeOptions(options.publicKey),
      ...(conditional ? { mediation: 'conditional' } : {}),
      signal,
    });
  } catch (err) {
    // An aborted conditional request is the user choosing another method, not
    // a failure to report.
    if (err?.name === 'AbortError') return { aborted: true };
    return friendly(err);
  }
  if (!assertion) return { error: 'auth.passkeyCancelled' };

  try {
    const result = await api('/api/auth/passkey/login/verify', {
      method: 'POST',
      body: {
        challengeId: options.challengeId,
        credentialId: toBase64Url(assertion.rawId),
        authenticatorData: toBase64Url(assertion.response.authenticatorData),
        clientDataJSON: toBase64Url(assertion.response.clientDataJSON),
        signature: toBase64Url(assertion.response.signature),
      },
    });
    return { session: result };
  } catch (e) {
    // The server checked the signature, the origin, the RP id and the counter.
    // Whatever it says here is the real reason.
    return { error: 'auth.passkeyRejected', detail: e.message };
  }
};

export const listPasskeys = () => api('/api/auth/passkey/list');

export const removePasskey = (id) =>
  api('/api/auth/passkey/remove', { method: 'POST', body: { id } });
