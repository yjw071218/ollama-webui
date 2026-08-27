// Accounts that live on the server rather than in a browser.
//
// The existing accounts are device-local: PBKDF2 hashes in IndexedDB, scoped to
// one origin. That is fine for keeping two people's chats apart on one PC, and
// useless for "sign in on my phone and see my settings", because the phone
// reaches the app as a different origin and therefore a different store.
//
// These accounts are the server's, so any device that can reach the server can
// sign in to the same one. Everything is a JSON file under server/data, which
// is gitignored — no database to install for something this small.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// OWASP's 2023 floor for PBKDF2-SHA512. Slow on purpose.
const ITERATIONS = 210000;
const KEY_LENGTH = 64;
const SESSION_DAYS = 30;

const ensureDir = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); };

const readJson = (file, fallback) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fallback;
  }
};

const writeJson = (file, value) => {
  ensureDir();
  // Write then rename: a crash mid-write must not leave a truncated user list.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
};

const hashPassword = (password, salt) =>
  new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LENGTH, 'sha512', (err, key) => {
      if (err) reject(err); else resolve(key.toString('base64'));
    });
  });

// Comparing hashes, not passwords, but still constant time: a timing signal on
// the hash is a timing signal on the password.
const sameHash = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

export const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

const loadUsers = () => readJson(USERS_FILE, []);
const saveUsers = (users) => writeJson(USERS_FILE, users);

const loadSessions = () => readJson(SESSIONS_FILE, {});
const saveSessions = (sessions) => writeJson(SESSIONS_FILE, sessions);

/** What a client is allowed to see about a user: never the hash or the salt. */
export const publicUser = (user) => user && ({
  id: user.id,
  name: user.name,
  email: user.email,
  avatar: user.avatar || null,
  provider: user.provider || 'server',
  createdAt: user.createdAt,
});

export const listUsers = () => loadUsers().map(publicUser);

export const registerUser = async ({ name, email, password }) => {
  const cleanEmail = normaliseEmail(email);
  const cleanName = String(name || '').trim().slice(0, 60);

  if (!cleanName) throw new Error('A name is required.');
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('A valid email address is required.');
  }
  if (String(password || '').length < 8) {
    throw new Error('The password must be at least 8 characters.');
  }

  const users = loadUsers();
  if (users.some(u => u.email === cleanEmail)) {
    throw new Error('An account with that email already exists.');
  }

  const salt = crypto.randomBytes(16).toString('base64');
  const user = {
    id: crypto.randomUUID(),
    name: cleanName,
    email: cleanEmail,
    salt,
    hash: await hashPassword(password, salt),
    iterations: ITERATIONS,
    createdAt: Date.now(),
  };

  saveUsers([...users, user]);
  return publicUser(user);
};

export const verifyPassword = async (email, password) => {
  const cleanEmail = normaliseEmail(email);
  const user = loadUsers().find(u => u.email === cleanEmail);

  // Hash anyway when the account does not exist, so a missing account and a
  // wrong password take the same time and cannot be told apart.
  const salt = user ? user.salt : crypto.randomBytes(16).toString('base64');
  const attempt = await hashPassword(password, salt);

  if (!user || !sameHash(attempt, user.hash)) return null;
  return publicUser(user);
};

export const updateUser = async (userId, patch) => {
  const users = loadUsers();
  const index = users.findIndex(u => u.id === userId);
  if (index === -1) throw new Error('No such account.');

  const user = { ...users[index] };
  if (patch.name !== undefined) user.name = String(patch.name).trim().slice(0, 60) || user.name;
  if (patch.avatar !== undefined) user.avatar = patch.avatar || null;

  if (patch.password) {
    if (String(patch.password).length < 8) throw new Error('The password must be at least 8 characters.');
    user.salt = crypto.randomBytes(16).toString('base64');
    user.hash = await hashPassword(patch.password, user.salt);
  }

  users[index] = user;
  saveUsers(users);
  return publicUser(user);
};

// ---- sessions ----

const pruneSessions = (sessions) => {
  const now = Date.now();
  const kept = {};
  for (const [token, entry] of Object.entries(sessions)) {
    if (entry && entry.expires > now) kept[token] = entry;
  }
  return kept;
};

export const createSession = (userId) => {
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = pruneSessions(loadSessions());
  sessions[token] = { userId, expires: Date.now() + SESSION_DAYS * 86400_000 };
  saveSessions(sessions);
  return token;
};

export const userForSession = (token) => {
  if (!token) return null;
  const sessions = loadSessions();
  const entry = sessions[token];
  if (!entry || entry.expires <= Date.now()) return null;
  const user = loadUsers().find(u => u.id === entry.userId);
  return user ? publicUser(user) : null;
};

export const destroySession = (token) => {
  if (!token) return;
  const sessions = loadSessions();
  if (sessions[token]) {
    delete sessions[token];
    saveSessions(sessions);
  }
};

/**
 * The account behind a verified social identity, creating it on first sight.
 *
 * This is what stops there being two separate notions of "your account". A
 * Google or Kakao sign-in already proves who you are; without this the person
 * would have to discover a second password in a settings tab before their
 * settings followed them anywhere.
 *
 * `identity` must come from a check the *server* performed. An identity posted
 * by a browser is a claim, and honouring claims would let anyone sign in as
 * anyone by sending a different email address.
 */
export const findOrCreateSocialUser = (identity) => {
  const { provider, providerId, email, name, avatar, emailVerified } = identity || {};
  if (!provider || !providerId) throw new Error('That identity names no account.');

  const users = loadUsers();
  const cleanEmail = normaliseEmail(email);

  // Same person signing in again.
  let index = users.findIndex(u => u.provider === provider && u.providerId === String(providerId));

  // A password account with the same address is the same person only if the
  // provider actually verified that address. Adopting an unverified one would
  // let anyone take over an account by claiming its email at their provider.
  if (index === -1 && cleanEmail && emailVerified) {
    index = users.findIndex(u => u.email === cleanEmail);
  }

  if (index !== -1) {
    const merged = {
      ...users[index],
      provider,
      providerId: String(providerId),
      name: users[index].name || name || cleanEmail,
      avatar: avatar || users[index].avatar || null,
      lastSeenAt: Date.now(),
    };
    users[index] = merged;
    saveUsers(users);
    return publicUser(merged);
  }

  const user = {
    id: crypto.randomUUID(),
    name: String(name || cleanEmail || 'User').trim().slice(0, 60),
    email: cleanEmail,
    provider,
    providerId: String(providerId),
    avatar: avatar || null,
    // No salt or hash: this account is only reachable through its provider.
    createdAt: Date.now(),
  };
  saveUsers([...users, user]);
  return publicUser(user);
};
