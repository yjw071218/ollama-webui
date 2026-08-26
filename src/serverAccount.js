// Talking to the server's own accounts, and keeping this browser's state in
// step with the one that belongs to the signed-in account.
//
// The problem this solves: localStorage and IndexedDB are scoped to the origin,
// so a phone reaching the app as http://192.168.1.9:5173 sees none of what was
// saved at http://localhost:5173. Signing in to the server and syncing through
// it makes the settings follow the person instead of the address.

import { collectBackup, restoreBackup, describeBackup } from './backup.js';

const json = async (path, options = {}) => {
  const res = await fetch(path, {
    // The session is an HttpOnly cookie, so it has to be sent explicitly.
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`HTTP ${res.status}`);
  return data;
};

/**
 * The app's public identity, served by the backend rather than compiled in.
 *
 * A client ID names the application, not the user, so serving it at runtime is
 * safe and means any origin the backend answers on gets a working sign-in
 * button. The Kakao client secret is never part of this.
 */
export const fetchServerConfig = async () => {
  try {
    return await json('/api/config');
  } catch (e) {
    // No backend, or an older one: the app still works, just without this.
    return null;
  }
};

export const serverMe = async () => {
  try {
    return await json('/api/account/me');
  } catch (e) {
    return null;
  }
};

export const serverRegister = (name, email, password) =>
  json('/api/account/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });

export const serverLogin = (email, password) =>
  json('/api/account/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const serverLogout = () => json('/api/account/logout', { method: 'POST' });

export const serverUpdateProfile = (patch) =>
  json('/api/account/profile', { method: 'POST', body: JSON.stringify(patch) });

// ---- sync ----

/** Send this browser's state up. Accounts stay local — they are per device. */
export const pushState = async () => {
  const state = await collectBackup({ includeAccounts: false });
  const result = await json('/api/account/state', { method: 'PUT', body: JSON.stringify(state) });
  if (!result.success) throw new Error(result.error || 'The server refused the upload.');
  return { ...result, summary: describeBackup(state) };
};

/**
 * Bring the account's state down.
 *
 * Merge by default: a device that already has chats keeps them, and the account
 * adds what is missing. Replace is for making a new device match exactly.
 */
export const pullState = async ({ mode = 'merge' } = {}) => {
  const result = await json('/api/account/state');
  if (!result.success) throw new Error(result.error || 'Could not read the account state.');
  if (!result.state) return { restored: null, summary: null };
  const restored = await restoreBackup(result.state, { mode, includeAccounts: false });
  return { restored, summary: describeBackup(result.state) };
};

/**
 * A push that waits for the dust to settle.
 *
 * Settings change on every keystroke in a textarea, and the state blob is the
 * whole history. Coalescing avoids uploading it once per character.
 */
export const createSyncScheduler = ({ delay = 4000, onResult, onError } = {}) => {
  let timer = null;
  let running = false;
  let queued = false;

  const run = async () => {
    if (running) { queued = true; return; }
    running = true;
    try {
      onResult?.(await pushState());
    } catch (e) {
      onError?.(e);
    } finally {
      running = false;
      if (queued) { queued = false; schedule(); }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay);
  };

  return {
    schedule,
    flush: async () => { if (timer) clearTimeout(timer); timer = null; await run(); },
    cancel: () => { if (timer) clearTimeout(timer); timer = null; },
  };
};
