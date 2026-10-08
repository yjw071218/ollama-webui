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
export { DB_FILE };

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

-- Devices an account has been confirmed on. A sign-in from a device not in
-- here waits until a device that is says it was really the owner.
CREATE TABLE IF NOT EXISTS known_devices (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

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
  CHECK (
    (deleted = 1 AND payload IS NULL)
    OR
    (deleted = 0 AND payload IS NOT NULL AND json_valid(payload))
  ),
  PRIMARY KEY (user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_by_rev ON records (user_id, rev);

-- Append-only safety net for every replaced row. The current-record table is
-- optimized for sync, while this table makes an accidental overwrite
-- recoverable instead of making the newest value the only copy.
CREATE TABLE IF NOT EXISTS record_history (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  id         TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL,
  payload    TEXT,
  CHECK (
    (deleted = 1 AND payload IS NULL)
    OR
    (deleted = 0 AND payload IS NOT NULL AND json_valid(payload))
  ),
  PRIMARY KEY (user_id, kind, id, rev)
);
-- (No separate index: the primary key already is (user_id, kind, id, rev).
-- The old record_history_user duplicated it and is dropped by migration 1.)

-- Large strings out of record_history, stored once by their hash.
--
-- A chat carrying a picture is several megabytes of base64, and history keeps
-- a whole copy per edit: one afternoon of chatting under one picture was 150 MB
-- of the same image, 27 times. History rows now hold a marker in its place and
-- the picture lives here once. See server/recordHistory.js.
CREATE TABLE IF NOT EXISTS history_blobs (
  hash TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL
);

-- Keys for the OpenAI-compatible API (server/openaiCompat.js). Stored hashed,
-- like session tokens: the key is shown once, when it is made, and a copy of
-- this file does not hand out working keys.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id);

-- Telegram chats linked to an account (server/telegram.js). One Telegram chat
-- belongs to one account and talks into one of its conversations.
CREATE TABLE IF NOT EXISTS telegram_links (
  tg_chat_id   TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id      TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS telegram_links_user ON telegram_links (user_id);

-- Rows that cannot be safely shown or synchronized are kept here for
-- diagnosis and manual recovery, never silently coerced into a live record.
CREATE TABLE IF NOT EXISTS record_quarantine (
  user_id       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  id            TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL,
  payload       TEXT,
  reason        TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS record_quarantine_user
  ON record_quarantine (user_id, quarantined_at);

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

/* Where to send "your picture is ready" when the app is not open anywhere.
   One row per browser, not per account: a phone and a laptop are two
   subscriptions and a notification is meant for both. user_id is '' for the
   guest, which is the same scope the rest of the app gives a browser that has
   not signed in. Deleted with the account, and deleted by the server the
   moment a push service says the endpoint is gone -- a subscription outlives
   the browser that made it and nothing else ever cleans them up. */
/* What this server has queued and believes is still being made.
   In the database rather than in memory because the work outlives the process:
   ComfyUI keeps drawing across a restart of this app, and a register that did
   not survive left a phone watching a card for a job nobody could name any
   more, and a completion notification that never fired. Reconciled against
   ComfyUI's own queue at startup -- see reconcileLiveJobs. */
CREATE TABLE IF NOT EXISTS live_jobs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT '',
  chat       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'image',
  prompt     TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  aspect     REAL,
  started_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_jobs_chat ON live_jobs (user_id, chat);

/* An account's schedules, run by this server rather than by a browser.
   Here rather than in the synced records because exactly one thing may run
   each one: synced to every device, each would fire it at the same minute.
   last_run_at doubles as the claim -- a runner takes a due slot by moving it
   forward only if it still holds the value it read, so two processes against
   one database cannot both answer. See server/serverSchedules.js. */
CREATE TABLE IF NOT EXISTS server_schedules (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  chat        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  every       TEXT NOT NULL DEFAULT 'day',
  at          TEXT NOT NULL DEFAULT '08:00',
  model       TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS server_schedules_user ON server_schedules (user_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL DEFAULT '',
  /* What to say, in the reader's language. A push carries no payload -- see
     server/push.js -- so the worker asks this server what just finished, and
     the worker has no translations of its own. The app knows them, so it hands
     the sentence over when it subscribes. */
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  failed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions (user_id);

/* RisuAI sync (server/risuSync.js). Declared here so the whole schema lives in
   one place; risuSync.js still says CREATE IF NOT EXISTS for databases it is
   handed directly in tests. Asset bytes live in files; the bytes column only
   holds rows not yet migrated out. */
CREATE TABLE IF NOT EXISTS risu_snapshots (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  payload  BLOB NOT NULL,
  updated  INTEGER NOT NULL,
  PRIMARY KEY (user_id, revision)
);
CREATE TABLE IF NOT EXISTS risu_assets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash    TEXT NOT NULL,
  bytes   BLOB NOT NULL,
  size    INTEGER,
  created INTEGER,
  PRIMARY KEY (user_id, hash)
);
`;

/**
 * Numbered, one-way schema changes, tracked in PRAGMA user_version.
 *
 * SCHEMA above only ever creates what is missing; anything that changes or
 * removes existing structure goes here instead, so a database records how far
 * it has been brought and each step runs exactly once, in its own transaction.
 * Append only -- never edit or reorder a step that has shipped.
 */
const MIGRATIONS = [
  // 1: record_history_user was column-for-column the primary key: pure
  //    write cost and disk space. Also pick up the risu_assets columns on
  //    databases whose table predates them.
  (h) => {
    h.exec('DROP INDEX IF EXISTS record_history_user');
    const cols = h.prepare('PRAGMA table_info(risu_assets)').all().map(c => c.name);
    if (!cols.includes('size')) h.exec('ALTER TABLE risu_assets ADD COLUMN size INTEGER');
    if (!cols.includes('created')) h.exec('ALTER TABLE risu_assets ADD COLUMN created INTEGER');
  },
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const runMigrations = () => {
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    throw new Error(`Database schema v${version} is newer than this server (v${MIGRATIONS.length}).`);
  }
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[version](db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (rollbackError) { /* already unwound */ }
      throw new Error(`Schema migration ${version + 1} failed: ${e.message}`);
    }
  }
};

/**
 * A column added after the table was first created.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added to the schema above never appears on a database made before
 * it -- and the failure is an INSERT that says "no column named label" long
 * after the deploy. SQLite has no `ADD COLUMN IF NOT EXISTS`, so the columns
 * are read and the one that is missing is added.
 */
const addColumn = (table, column, definition) => {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

/** The connection, opened and migrated on first use. */
export const database = () => {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { DatabaseSync } = loadSqlite();
  db = new DatabaseSync(DB_FILE);
  db.exec(SCHEMA);
  // What to say when a push wakes the worker; see server/push.js.
  addColumn('push_subscriptions', 'label', "TEXT NOT NULL DEFAULT ''");
  // A folder a scheduled CLI turn works in; see server/cliProject.js.
  addColumn('server_schedules', 'project', "TEXT NOT NULL DEFAULT ''");
  addColumn('server_schedules', 'project_mode', "TEXT NOT NULL DEFAULT 'plan'");
  // New-device confirmation; see server/devices.js.
  addColumn('sessions', 'pending', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('sessions', 'device_id', "TEXT NOT NULL DEFAULT ''");
  migrateRecordIntegrity();
  runMigrations();
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
const RECORD_INTEGRITY_MARK = 'record-integrity-v1';

/**
 * Install the invariant on databases created before records had a CHECK.
 *
 * SQLite cannot add a CHECK to an existing table. Rebuilding it inside one
 * transaction makes the change atomic. Rows that were already malformed are
 * quarantined with their metadata instead of being silently presented as
 * empty chats or discarded.
 */
const migrateRecordIntegrity = () => {
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get(RECORD_INTEGRITY_MARK)) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS record_quarantine (
        user_id       TEXT NOT NULL,
        kind          TEXT NOT NULL,
        id            TEXT NOT NULL,
        rev           INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        deleted       INTEGER NOT NULL,
        payload       TEXT,
        reason        TEXT NOT NULL,
        quarantined_at INTEGER NOT NULL
      );
    `);

    const bad = db.prepare(`
      SELECT user_id, kind, id, rev, updated_at, deleted, payload
        FROM records
       WHERE deleted NOT IN (0, 1)
          OR (deleted = 1 AND payload IS NOT NULL)
          OR (deleted = 0 AND (payload IS NULL OR NOT json_valid(payload)))
    `).all();
    const quarantine = db.prepare(`
      INSERT INTO record_quarantine
        (user_id, kind, id, rev, updated_at, deleted, payload, reason, quarantined_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    for (const row of bad) {
      const reason = row.deleted === 0
        ? (row.payload == null ? 'live record has no payload' : 'live record has invalid JSON')
        : 'deleted record carries a payload';
      quarantine.run(
        row.user_id, row.kind, row.id, row.rev, row.updated_at,
        row.deleted, row.payload, reason, Date.now(),
      );
    }

    db.exec(`
      CREATE TABLE records_integrity (
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        id         TEXT NOT NULL,
        rev        INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted    INTEGER NOT NULL DEFAULT 0,
        payload    TEXT,
        CHECK (
          (deleted = 1 AND payload IS NULL)
          OR
          (deleted = 0 AND payload IS NOT NULL AND json_valid(payload))
        ),
        PRIMARY KEY (user_id, kind, id)
      );
    `);
    db.exec(`
      INSERT INTO records_integrity
        (user_id, kind, id, rev, updated_at, deleted, payload)
      SELECT user_id, kind, id, rev, updated_at, deleted, payload
        FROM records
       WHERE deleted = 1 AND payload IS NULL
          OR deleted = 0 AND payload IS NOT NULL AND json_valid(payload)
    `);
    db.exec('DROP TABLE records');
    db.exec('ALTER TABLE records_integrity RENAME TO records');
    db.exec('CREATE INDEX records_by_rev ON records (user_id, rev)');
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run(RECORD_INTEGRITY_MARK, JSON.stringify({ at: Date.now(), quarantined: bad.length }));
    db.exec('COMMIT');
    if (bad.length) {
      console.warn(`[db] quarantined ${bad.length} malformed record(s); inspect record_quarantine.`);
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (rollbackError) { /* already unwound */ }
    throw new Error(`Could not enforce record integrity: ${e.message}`);
  }
};

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
