// The database.
//
// What this replaces was a set of JSON files rewritten whole on every change:
// `users.json` was read from disk on *every authenticated request*, and every
// write was a read-modify-write with nothing holding the two together. Two
// requests arriving close enough — a phone and a laptop, which is exactly the
// case this app is meant to serve — could each read the same array, each append
// to their own copy, and the second write would silently drop the first. Losing
// an account that way is not a hypothetical; it is what read-modify-write on a
// shared file does.
//
// SQLite fixes that by being a database: one file, real transactions, real
// constraints, an index instead of a linear scan. It is built into Node, so
// this costs no dependency and no install step.
//
// The other half of the change is the shape of the synced data. It used to be
// one blob per account, replaced wholesale. Two devices pushing a blob each
// meant last-writer-wins over *everything*: the laptop's upload could erase a
// chat the phone had written a second earlier, and a deletion on one device was
// undone by the next upload from the other, because a blob cannot express "this
// one is gone". Rows can. See records.js.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Required rather than imported, and at first use rather than at load.
//
// An ES module graph is linked before any of it runs, and loading node:sqlite
// is what emits its ExperimentalWarning — so the filter in quiet.js, however
// early it is imported, is installed too late to catch it. A require at call
// time happens after the whole graph has been evaluated, by which point the
// filter is in place. Synchronous, so nothing above has to become async for it.
const loadSqlite = () => createRequire(import.meta.url)('node:sqlite');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where everything lives.
 *
 * Overridable so a test can point at a scratch directory. The tests used to
 * rename the real one aside and put it back afterwards, which failed the moment
 * the server was running — Windows will not move a directory holding an open
 * file — and left the accounts stranded in a half-renamed backup. A test must
 * not be able to touch real data by accident, so it does not go near it.
 */
export const DATA_DIR = process.env.WEBUI_DATA_DIR
  ? path.resolve(process.env.WEBUI_DATA_DIR)
  : path.join(HERE, 'data');

const DB_FILE = path.join(DATA_DIR, 'webui.db');

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  name         TEXT NOT NULL,
  avatar       TEXT,
  provider     TEXT NOT NULL DEFAULT 'password',
  provider_id  TEXT,
  hash         TEXT,
  salt         TEXT,
  iterations   INTEGER,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  -- Bumped on every record write. A device syncs by asking for everything
  -- above the revision it last saw, which is what makes a phone on a slow
  -- connection download one new chat instead of the whole history.
  rev          INTEGER NOT NULL DEFAULT 0
);

-- Two accounts must never share an address, and the check has to be the
-- database's: doing it in JavaScript before an insert is a race, and races over
-- an email address are account takeover.
CREATE UNIQUE INDEX IF NOT EXISTS users_email
  ON users (email) WHERE email IS NOT NULL AND email <> '';
CREATE UNIQUE INDEX IF NOT EXISTS users_provider
  ON users (provider, provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS credentials (
  credential_id  TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key_jwk TEXT NOT NULL,
  algorithm      INTEGER NOT NULL,
  sign_count     INTEGER NOT NULL DEFAULT 0,
  label          TEXT,
  aaguid         TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);
CREATE INDEX IF NOT EXISTS credentials_user ON credentials (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash         TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  csrf               TEXT NOT NULL,
  user_agent         TEXT,
  ip                 TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- One row per thing, not one blob per account.
--
-- "rev" is the account revision at which this row last changed, and is what a
-- delta sync selects on. "updated_at" is the client's own clock for the record
-- and is what decides a conflict: two devices editing the same chat offline is
-- a real situation, and the later edit should win rather than whichever device
-- happened to reconnect second.
--
-- "deleted" is why deletions finally propagate. A tombstone is a write like any
-- other, so it travels to the other devices; under the old blob it simply
-- looked like the record was missing, and the next upload from a device that
-- still had it put it straight back.
CREATE TABLE IF NOT EXISTS records (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  payload    TEXT,
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_by_rev ON records (user_id, rev);

CREATE TABLE IF NOT EXISTS kakao_tokens (
  user_id                 TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token            TEXT,
  refresh_token           TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope                   TEXT
);

-- A conversation published as a read-only link.
--
-- The row holds a *snapshot*, not a reference to the chat. That is the whole
-- safety of the feature: carrying on the conversation afterwards, or attaching
-- something private to it, cannot change what a link already handed out. What
-- was shared is what was shared.
--
-- The token is stored hashed, the way session tokens are. Anyone holding the
-- token can read the snapshot — that is what the link is for — but a copy of
-- this file does not hand out working links. The "id" column is the non-secret
-- handle the owner uses to list and revoke; it is safe to show on screen.
CREATE TABLE IF NOT EXISTS shares (
  token_hash     TEXT PRIMARY KEY,
  id             TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id        TEXT NOT NULL,
  title          TEXT,
  payload        TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  revoked        INTEGER NOT NULL DEFAULT 0,
  views          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS shares_id ON shares (user_id, id);
CREATE INDEX IF NOT EXISTS shares_user ON shares (user_id, created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/** The connection, opened and migrated on first use. */
export const database = () => {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { DatabaseSync } = loadSqlite();
  db = new DatabaseSync(DB_FILE);
  db.exec(SCHEMA);
  importLegacyJson();
  return db;
};

/**
 * Run a function inside a transaction.
 *
 * Every multi-statement write goes through this. It is the whole reason for
 * moving off JSON files: "read the array, change it, write it back" cannot be
 * made safe, and this does not have to be — either all of it lands or none of
 * it does, and a concurrent writer waits rather than overwriting.
 */
export const transaction = (fn) => {
  const handle = database();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(handle);
    handle.exec('COMMIT');
    return result;
  } catch (e) {
    try { handle.exec('ROLLBACK'); } catch (rollbackError) { /* already unwound */ }
    throw e;
  }
};

export const query = (sql, ...params) => database().prepare(sql).all(...params);
export const one = (sql, ...params) => database().prepare(sql).get(...params) ?? null;
export const run = (sql, ...params) => database().prepare(sql).run(...params);

/**
 * Claim the next revision for an account.
 *
 * Called inside the same transaction as the writes it stamps, so a reader can
 * never see a record at a revision the account has not reached — which would
 * make that record invisible to every future delta sync.
 */
export const nextRev = (handle, userId) => {
  handle.prepare('UPDATE users SET rev = rev + 1 WHERE id = ?').run(userId);
  return handle.prepare('SELECT rev FROM users WHERE id = ?').get(userId)?.rev ?? 0;
};

/* ------------------------------------------------------------- migration */

const LEGACY_MARK = 'legacy-json-imported';

/**
 * Bring the JSON files forward, once.
 *
 * Nobody should lose an account or a conversation because the storage layer was
 * rebuilt. The old files are left on disk untouched — renamed, not deleted — so
 * a mistake here is recoverable by hand.
 */
const importLegacyJson = () => {
  const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_MARK);
  if (done) return;

  const usersFile = path.join(DATA_DIR, 'users.json');
  const sessionsFile = path.join(DATA_DIR, 'sessions.json');
  const stateDir = path.join(DATA_DIR, 'state');

  const readJson = (file, fallback) => {
    try {
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback;
    } catch (e) {
      return fallback;
    }
  };

  const legacyUsers = readJson(usersFile, []);
  const imported = { users: 0, credentials: 0, records: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const user of legacyUsers) {
      if (!user?.id) continue;
      db.prepare(`
        INSERT OR IGNORE INTO users
          (id, email, name, avatar, provider, provider_id, hash, salt, iterations, created_at, last_seen_at, rev)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
      `).run(
        user.id,
        user.email || null,
        user.name || user.email || 'User',
        user.avatar || null,
        user.provider || 'password',
        user.providerId != null ? String(user.providerId) : null,
        user.hash || null,
        user.salt || null,
        user.iterations || null,
        user.createdAt || Date.now(),
        user.lastSeenAt || null,
      );
      imported.users++;

      for (const c of user.credentials || []) {
        if (!c?.credentialId) continue;
        db.prepare(`
          INSERT OR IGNORE INTO credentials
            (credential_id, user_id, public_key_jwk, algorithm, sign_count, label, aaguid, created_at, last_used_at)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(
          c.credentialId, user.id, JSON.stringify(c.publicKeyJwk || {}),
          c.algorithm || -7, c.signCount || 0, c.label || null, c.aaguid || null,
          c.createdAt || Date.now(), c.lastUsedAt || null,
        );
        imported.credentials++;
      }

      // The account's state blob becomes rows. This is the migration that
      // matters: it is what turns "one file that replaces everything" into
      // records a second device can merge with instead of overwrite.
      const blob = readJson(path.join(stateDir, `${user.id}.json`), null);
      if (blob) imported.records += importBlobRecords(user.id, blob);
    }

    // Old session records are a different format and cannot be looked up
    // against the new hashed scheme, so they are deliberately not carried
    // over: everyone signs in once more, which is the correct outcome for a
    // change to how sessions are stored.
    void sessionsFile;

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(LEGACY_MARK, JSON.stringify({ at: Date.now(), ...imported }));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`Could not import the existing accounts: ${e.message}`);
  }

  if (imported.users > 0) {
    console.log(`[db] imported ${imported.users} accounts, ${imported.records} records from the JSON store.`);
    // Kept, not deleted. A storage migration that destroys its own source is
    // one bug away from being unrecoverable.
    for (const file of [usersFile, sessionsFile]) {
      try {
        if (fs.existsSync(file)) fs.renameSync(file, `${file}.imported`);
      } catch (e) { /* leaving it in place is harmless */ }
    }
    try {
      if (fs.existsSync(stateDir)) fs.renameSync(stateDir, `${stateDir}.imported`);
    } catch (e) { /* likewise */ }
  }
};

const SESSION_PREFIX = 'ollama-sessions';

/** Turn one legacy state blob into rows, all at revision 1. */
const importBlobRecords = (userId, blob) => {
  const now = Date.now();
  let count = 0;

  const put = (kind, id, payload, updatedAt) => {
    db.prepare(`
      INSERT OR REPLACE INTO records (user_id, kind, id, rev, updated_at, deleted, payload)
      VALUES (?,?,?,1,?,0,?)
    `).run(userId, kind, String(id), updatedAt || now, JSON.stringify(payload));
    count++;
  };

  // Only the bucket that belongs to this account. A blob could hold several,
  // because the old collector sometimes swept the whole browser.
  const own = blob.primaryKey || `${SESSION_PREFIX}:srv-${userId}`;
  for (const [key, chats] of Object.entries(blob.sessions || {})) {
    if (key !== own) continue;
    for (const chat of chats || []) {
      if (chat?.id == null) continue;
      put('chat', chat.id, chat, chat.updatedAt);
    }
  }

  for (const [key, value] of Object.entries(blob.settings || {})) {
    // Folders and presets carry their own suffixed keys; they become records of
    // their own kind so they are not mistaken for ordinary settings.
    if (key.startsWith('chatFolders')) { put('folders', 'all', value, blob.savedAt); continue; }
    if (key.startsWith('samplingPresets')) { put('presets', 'all', value, blob.savedAt); continue; }
    put('setting', key, value, blob.savedAt);
  }

  for (const docs of Object.values(blob.knowledge || {})) {
    for (const doc of docs || []) {
      if (doc?.id == null) continue;
      put('document', doc.id, doc, doc.addedAt);
    }
  }

  for (const memories of Object.values(blob.memory || {})) {
    for (const memory of memories || []) {
      if (memory?.id == null) continue;
      put('memory', memory.id, memory, memory.createdAt);
    }
  }

  if (count > 0) db.prepare('UPDATE users SET rev = 1 WHERE id = ?').run(userId);
  return count;
};

/** Close and forget the handle. Tests open a fresh database per run. */
export const closeDatabase = () => {
  if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  db = null;
};
