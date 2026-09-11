// The account. Singular, on the server, in a database.
//
// There used to be two of these. One lived in the browser's IndexedDB with its
// own ids and its own PBKDF2; this one lived on the server. Every screen had to
// decide which was authoritative, and the answer changed halfway through boot —
// which is how a chat ended up written into another account's storage.
//
// There is one now, and as of this version it is in SQLite rather than a JSON
// file. That is not tidiness. `users.json` was read whole on every
// authenticated request and rewritten whole on every change, with nothing
// holding the read and the write together: two requests arriving close enough
// each read the same array, each appended to their own copy, and the second
// write dropped the first. Losing an account that way is simply what
// read-modify-write on a shared file does. A unique index and a transaction do
// not have that failure mode.

import crypto from 'node:crypto';
import { database, transaction, DATA_DIR } from './db.js';

export { DATA_DIR };

// OWASP's 2023 floor for PBKDF2-SHA512. Slow on purpose.
const ITERATIONS = 210000;
const KEY_LENGTH = 64;

export const MIN_PASSWORD_LENGTH = 8;

/**
 * An error the client can act on without reading English.
 *
 * The message is still the honest one — it goes in logs and is what a curl
 * shows — but the code is what the UI translates, so a Korean user does not get
 * a sentence written for a developer.
 */
const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
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

export const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normaliseEmail(email));

const countCredentials = (userId) =>
  database().prepare('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?').get(userId)?.n ?? 0;

/**
 * What a client is allowed to see about a user.
 *
 * Never the hash, the salt, or a credential's key material. `hasPassword` and
 * `passkeys` are here because the profile screen has to know which sign-in
 * methods exist without being told what they are — offering "change password"
 * to an account that has never had one is the kind of thing that used to
 * produce a confusing error instead of a hidden button.
 */
export const publicUser = (row) => row && ({
  id: row.id,
  name: row.name,
  email: row.email || '',
  avatar: row.avatar || null,
  provider: row.provider || 'password',
  hasPassword: !!row.hash,
  passkeys: countCredentials(row.id),
  createdAt: row.created_at,
});

const userRow = (userId) =>
  database().prepare('SELECT * FROM users WHERE id = ?').get(userId) ?? null;

export const findUser = (userId) => publicUser(userRow(userId));

export const listUsers = () =>
  database().prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser);

export const countUsers = () =>
  database().prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;

/* -------------------------------------------------------------- registration */

export const registerUser = async ({ name, email, password }) => {
  const cleanEmail = normaliseEmail(email);
  const cleanName = String(name || '').trim().slice(0, 60);

  if (!cleanName) throw fail('name-required', 'A name is required.');
  if (!isValidEmail(cleanEmail)) throw fail('invalid-email', 'A valid email address is required.');
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw fail('weak-password', `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const salt = crypto.randomBytes(16).toString('base64');
  const hash = await hashPassword(password, salt);
  const id = crypto.randomUUID();

  try {
    database().prepare(`
      INSERT INTO users (id, email, name, avatar, provider, hash, salt, iterations, created_at, rev)
      VALUES (?,?,?,NULL,'password',?,?,?,?,0)
    `).run(id, cleanEmail, cleanName, hash, salt, ITERATIONS, Date.now());
  } catch (e) {
    // The unique index decides this, not a lookup beforehand: checking and then
    // inserting is a race, and a race over an email address is two accounts
    // claiming one identity.
    if (/UNIQUE/i.test(e.message)) {
      throw fail('email-taken', 'An account with that email already exists.');
    }
    throw e;
  }

  return findUser(id);
};

export const verifyPassword = async (email, password) => {
  const cleanEmail = normaliseEmail(email);
  const row = database().prepare(
    'SELECT * FROM users WHERE email = ? AND hash IS NOT NULL'
  ).get(cleanEmail);

  // Hash anyway when the account does not exist, so a missing account and a
  // wrong password take the same time and cannot be told apart.
  const salt = row ? row.salt : crypto.randomBytes(16).toString('base64');
  const attempt = await hashPassword(String(password || ''), salt);

  if (!row || !sameHash(attempt, row.hash)) return null;
  return publicUser(row);
};

/* ------------------------------------------------------------------ profile */

export const updateUser = async (userId, patch) => {
  const row = userRow(userId);
  if (!row) throw fail('no-account', 'No such account.');

  const next = { name: row.name, email: row.email, avatar: row.avatar };

  if (patch.name !== undefined) {
    const name = String(patch.name).trim().slice(0, 60);
    if (!name) throw fail('name-required', 'A display name is required.');
    next.name = name;
  }

  if (patch.email !== undefined) {
    const cleanEmail = normaliseEmail(patch.email);
    if (cleanEmail && !isValidEmail(cleanEmail)) throw fail('invalid-email', 'Enter a valid email address.');
    next.email = cleanEmail || null;
  }

  if (patch.avatar !== undefined) next.avatar = patch.avatar || null;

  try {
    database().prepare('UPDATE users SET name = ?, email = ?, avatar = ? WHERE id = ?')
      .run(next.name, next.email, next.avatar, userId);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      throw fail('email-taken', 'An account with that email already exists.');
    }
    throw e;
  }

  return findUser(userId);
};

/**
 * Change a password, proving the old one first.
 *
 * Proving it is not a formality: without it, anyone who finds an unlocked
 * browser takes the account permanently rather than until the tab closes. The
 * caller is expected to end the account's other sessions afterwards, which is
 * the other half of what a password change is for.
 */
export const changePassword = async (userId, currentPassword, nextPassword) => {
  const row = userRow(userId);
  if (!row) throw fail('no-account', 'No such account.');

  if (String(nextPassword || '').length < MIN_PASSWORD_LENGTH) {
    throw fail('weak-password', `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (row.hash) {
    const attempt = await hashPassword(String(currentPassword || ''), row.salt);
    if (!sameHash(attempt, row.hash)) throw fail('wrong-password', 'The current password is not correct.');
  } else if (!row.provider_id && countCredentials(userId) === 0) {
    // Neither a password, a provider, nor a passkey: nothing to prove with.
    throw fail('no-proof', 'This account cannot set a password here.');
  }

  // A new salt every time, so the stored hash never repeats even if the
  // password does.
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = await hashPassword(nextPassword, salt);
  database().prepare('UPDATE users SET hash = ?, salt = ?, iterations = ? WHERE id = ?')
    .run(hash, salt, ITERATIONS, userId);

  return findUser(userId);
};

/** Deleting cascades: credentials, sessions, records and tokens go with it. */
export const deleteAccount = (userId) =>
  database().prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;

/* -------------------------------------------------------------- social sign-in */

/**
 * The account behind a verified social identity, creating it on first sight.
 *
 * `identity` must come from a check the *server* performed. An identity posted
 * by a browser is a claim, and honouring claims would let anyone sign in as
 * anyone by sending a different email address.
 */
export const findOrCreateSocialUser = (identity) => {
  const { provider, providerId, email, name, avatar, emailVerified } = identity || {};
  if (!provider || !providerId) throw fail('bad-identity', 'That identity names no account.');

  const cleanEmail = normaliseEmail(email);
  const subject = String(providerId);

  return transaction((handle) => {
    // The same person signing in again.
    let row = handle.prepare(
      'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
    ).get(provider, subject);

    // An existing account with the same address is the same person only if the
    // provider actually verified that address. Adopting an unverified one would
    // let anyone take over an account by claiming its email at their provider.
    if (!row && cleanEmail && emailVerified) {
      row = handle.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    }

    if (row) {
      // The provider is recorded but does not overwrite a password login: an
      // account can have both, and flattening it to the last one used would
      // hide the password field from someone who still has a password.
      handle.prepare(`
        UPDATE users SET
          provider_id = ?,
          provider = CASE WHEN hash IS NOT NULL THEN provider ELSE ? END,
          name = CASE WHEN name IS NULL OR name = '' THEN ? ELSE name END,
          avatar = COALESCE(?, avatar),
          last_seen_at = ?
        WHERE id = ?
      `).run(subject, provider, name || cleanEmail || 'User', avatar || null, Date.now(), row.id);
      return publicUser(handle.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
    }

    // The address is not ours to take. It was not verified — so it could not
    // adopt the existing account above — and storing it anyway would either
    // collide outright or leave two accounts asserting one identity. The new
    // account is real and reachable through its provider; it simply has no
    // email until one is proven.
    const taken = cleanEmail
      ? handle.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)
      : null;

    const id = crypto.randomUUID();
    handle.prepare(`
      INSERT INTO users (id, email, name, avatar, provider, provider_id, created_at, last_seen_at, rev)
      VALUES (?,?,?,?,?,?,?,?,0)
    `).run(
      id,
      taken ? null : (cleanEmail || null),
      String(name || cleanEmail || 'User').trim().slice(0, 60),
      avatar || null,
      provider,
      subject,
      Date.now(),
      Date.now(),
    );
    return publicUser(handle.prepare('SELECT * FROM users WHERE id = ?').get(id));
  });
};

/* --------------------------------------------------------------- passkeys */

/**
 * Attach a passkey to an account.
 *
 * The record holds a public key and a counter. There is nothing secret in it —
 * that is the appeal of the scheme — but a credential id is unique across
 * accounts, because it is what a sign-in resolves an account *from*. The
 * primary key enforces that; scanning for it beforehand would be a race.
 */
export const addCredential = (userId, credential) => {
  try {
    database().prepare(`
      INSERT INTO credentials
        (credential_id, user_id, public_key_jwk, algorithm, sign_count, label, aaguid, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      credential.credentialId, userId, JSON.stringify(credential.publicKeyJwk),
      credential.algorithm, credential.signCount || 0,
      credential.label || null, credential.aaguid || null, Date.now(),
    );
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(e.message)) {
      throw fail('passkey-exists', 'That passkey is already registered.');
    }
    throw e;
  }
  return findUser(userId);
};

/** Who a presented credential id belongs to, with the stored key beside it. */
export const findByCredentialId = (credentialId) => {
  const row = database().prepare(
    'SELECT * FROM credentials WHERE credential_id = ?'
  ).get(String(credentialId || ''));
  if (!row) return null;
  return {
    user: findUser(row.user_id),
    credential: {
      credentialId: row.credential_id,
      publicKeyJwk: JSON.parse(row.public_key_jwk),
      algorithm: row.algorithm,
      signCount: row.sign_count,
    },
  };
};

/**
 * Record the counter an assertion reported.
 *
 * A counter is only useful if it is kept: comparing every assertion against a
 * value that never moves detects nothing.
 */
export const touchCredential = (userId, credentialId, { signCount }) =>
  database().prepare(
    'UPDATE credentials SET sign_count = ?, last_used_at = ? WHERE credential_id = ? AND user_id = ?'
  ).run(signCount, Date.now(), credentialId, userId).changes > 0;

/** What the profile screen shows: never the key, only enough to tell them apart. */
export const listCredentials = (userId) =>
  database().prepare(
    'SELECT credential_id, label, created_at, last_used_at FROM credentials WHERE user_id = ? ORDER BY created_at'
  ).all(userId).map(row => ({
    id: row.credential_id.slice(0, 12),
    label: row.label || '',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
  }));

/**
 * The full credential ids an account holds.
 *
 * Distinct from `listCredentials`, which truncates them for display. WebAuthn's
 * `excludeCredentials` needs the real thing: a shortened id decodes to
 * different bytes, so the authenticator would fail to recognise a key it
 * already holds and would silently make a second one for the same account.
 */
export const credentialIds = (userId) =>
  database().prepare('SELECT credential_id FROM credentials WHERE user_id = ?')
    .all(userId).map(row => row.credential_id);

/**
 * Remove a passkey.
 *
 * Refused when it is the only way into the account, because an account nobody
 * can sign in to is not a safer account, it is a lost one.
 */
export const removeCredential = (userId, shortId) => transaction((handle) => {
  const row = handle.prepare(
    'SELECT credential_id FROM credentials WHERE user_id = ? AND credential_id LIKE ?'
  ).get(userId, `${String(shortId || '')}%`);
  if (!row) throw fail('no-passkey', 'No such passkey.');

  const user = handle.prepare('SELECT hash, provider_id FROM users WHERE id = ?').get(userId);
  const remaining = handle.prepare(
    'SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?'
  ).get(userId).n - 1;

  if (remaining === 0 && !user?.hash && !user?.provider_id) {
    throw fail('last-credential', 'That is the only way into this account. Set a password first.');
  }

  handle.prepare('DELETE FROM credentials WHERE credential_id = ?').run(row.credential_id);
  return publicUser(handle.prepare('SELECT * FROM users WHERE id = ?').get(userId));
});
