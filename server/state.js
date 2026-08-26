// The settings and history that belong to an account rather than to a browser.
//
// Everything the app saves normally goes to localStorage and IndexedDB, both of
// which the browser scopes to the origin. Signing in on a phone therefore shows
// nothing, because http://192.168.1.9:5173 is not http://localhost:5173. What
// is kept here follows the account instead, so any device that can sign in gets
// the same setup.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './accounts.js';

const STATE_DIR = path.join(DATA_DIR, 'state');

// Chats carry base64 images, so a blob can grow quickly. Large enough not to be
// hit in ordinary use, small enough that one account cannot fill the disk.
export const MAX_STATE_BYTES = 32 * 1024 * 1024;

const fileFor = (userId) => {
  // The id is a UUID we generated, but it arrives back from a request, so it is
  // validated rather than trusted straight into a path.
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) throw new Error('Bad account id.');
  return path.join(STATE_DIR, `${userId}.json`);
};

export const readState = (userId) => {
  try {
    const file = fileFor(userId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return null;
  }
};

export const writeState = (userId, state) => {
  const file = fileFor(userId);
  const payload = JSON.stringify({ ...state, savedAt: Date.now() });
  if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
    throw new Error(`That is larger than the ${Math.round(MAX_STATE_BYTES / 1024 / 1024)} MB limit for one account.`);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, payload);
  fs.renameSync(temp, file);
  return { savedAt: Date.now(), bytes: Buffer.byteLength(payload) };
};

export const stateInfo = (userId) => {
  try {
    const file = fileFor(userId);
    if (!fs.existsSync(file)) return { exists: false, bytes: 0, savedAt: null };
    const stat = fs.statSync(file);
    const state = readState(userId);
    return { exists: true, bytes: stat.size, savedAt: state?.savedAt || stat.mtimeMs };
  } catch (e) {
    return { exists: false, bytes: 0, savedAt: null };
  }
};
