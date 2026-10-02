import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { DB_FILE, DATA_DIR, database } from './db.js';

const loadSqlite = () => createRequire(import.meta.url)('node:sqlite');
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION = 14;
const DEFAULT_DAILY_RETENTION = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const timestamp = (date = new Date()) =>
  date.toISOString().replace(/[:.]/g, '-');

const sqlPath = (file) => `'${String(file).replaceAll("'", "''")}'`;

/* VACUUM INTO + verification on a worker thread; see dbBackupWorker.js. */
const inWorker = (source, target) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./dbBackupWorker.js', import.meta.url), { workerData: { source, target } });
  let settled = false;
  worker.once('message', (m) => { settled = true; m.ok ? resolve({ integrity: m.integrity, foreignKeys: m.foreignKeys }) : reject(new Error(m.error)); });
  worker.once('error', (e) => { settled = true; reject(e); });
  worker.once('exit', (code) => { if (!settled) reject(new Error(`backup worker exited with ${code}`)); });
});

export const checkBackup = (file) => {
  const { DatabaseSync } = loadSqlite();
  const copy = new DatabaseSync(file);
  try {
    copy.exec('PRAGMA foreign_keys = ON');
    const integrity = copy.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity || 'no result'}`);
    const foreignKeys = copy.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length) throw new Error(`foreign_key_check: ${foreignKeys.length} violation(s)`);
    return { integrity, foreignKeys: foreignKeys.length };
  } finally {
    copy.close();
  }
};

const listBackups = (directory) => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^webui-\d{4}-\d{2}-\d{2}T.*\.db$/.test(name))
    .map(name => ({
      name,
      path: path.join(directory, name),
      mtime: fs.statSync(path.join(directory, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
};

/**
 * Keep the newest `retention` backups, and besides them the newest backup of
 * each of the last `dailyRetention` days.
 *
 * A count alone is not a period of time. Every restart used to take a backup,
 * so on a day of restarting the server fourteen copies covered an afternoon
 * and the backup from yesterday -- the one a mistake is usually discovered
 * against -- was already gone.
 */
export const removeOldBackups = (directory, retention, dailyRetention = DEFAULT_DAILY_RETENTION, now = Date.now()) => {
  const files = listBackups(directory);
  const keep = new Set(files.slice(0, Math.max(0, retention)).map(f => f.path));
  const days = new Set();
  const tz = new Date().getTimezoneOffset() * 60 * 1000;
  for (const file of files) {
    if (now - file.mtime > dailyRetention * DAY_MS) continue;
    const day = Math.floor((file.mtime - tz) / DAY_MS);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(file.path);
  }
  for (const file of files) {
    if (!keep.has(file.path)) fs.rmSync(file.path, { force: true });
  }
  return keep.size;
};

/** When the newest finished backup was written, or 0 when there is none. */
export const newestBackupAt = (directory = path.join(DATA_DIR, 'backups')) =>
  listBackups(directory)[0]?.mtime || 0;

let backupInFlight = null;

/**
 * Create and verify a consistent online SQLite backup.
 *
 * VACUUM INTO reads a transactionally consistent snapshot while the server
 * remains open. The destination is verified before it becomes visible as a
 * completed backup, and retention only removes verified, named backups.
 */
export const backupDatabase = async ({
  directory = path.join(DATA_DIR, 'backups'),
  retention = DEFAULT_RETENTION,
  dailyRetention = DEFAULT_DAILY_RETENTION,
} = {}) => {
  if (backupInFlight) return backupInFlight;

  backupInFlight = (async () => {
    const keep = Math.max(1, Math.floor(Number(retention) || DEFAULT_RETENTION));
    fs.mkdirSync(directory, { recursive: true });
    const finalPath = path.join(directory, `webui-${timestamp()}.db`);
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

    try {
      database(); // make sure the file exists and is migrated
      const verification = await inWorker(DB_FILE, temporaryPath);
      fs.renameSync(temporaryPath, finalPath);
      const days = Math.max(0, Math.floor(Number(dailyRetention) || 0));
      const retained = removeOldBackups(directory, keep, days);
      return {
        source: DB_FILE,
        file: finalPath,
        bytes: fs.statSync(finalPath).size,
        retained,
        ...verification,
      };
    } finally {
      try { if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true }); } catch (e) { /* best effort cleanup */ }
    }
  })();

  try {
    return await backupInFlight;
  } finally {
    backupInFlight = null;
  }
};

/**
 * Back up every `intervalMs`, counted from the last backup that exists.
 *
 * It used to back up the moment the server started, and then every interval
 * from there. Each restart was therefore a full copy of the database -- six
 * one-gigabyte files on one day of restarting -- and the retention count was
 * spent on minutes instead of days. Now a restart only backs up when the
 * newest copy on disk is already due.
 */
export const startDatabaseBackupScheduler = ({
  directory,
  retention,
  dailyRetention,
  intervalMs = DEFAULT_INTERVAL_MS,
  log = console,
  now = Date.now,
} = {}) => {
  const every = Math.max(60 * 1000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  const dir = directory || path.join(DATA_DIR, 'backups');
  let stopped = false;
  let timer = null;
  let first = null;

  const run = async () => {
    if (stopped) return;
    try {
      const result = await backupDatabase({ directory: dir, retention, dailyRetention });
      log.info(`[db-backup] verified ${result.file} (${result.bytes} bytes)`);
    } catch (error) {
      log.error(`[db-backup] failed: ${error.message}`);
    }
  };

  const since = now() - newestBackupAt(dir);
  const firstDelay = Math.max(0, every - since);
  first = setTimeout(() => {
    void run();
    timer = setInterval(run, every);
    timer.unref?.();
  }, firstDelay);
  first.unref?.();

  return () => {
    stopped = true;
    clearTimeout(first);
    if (timer) clearInterval(timer);
    timer = null;
  };
};

export const BACKUP_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  retention: DEFAULT_RETENTION,
  dailyRetention: DEFAULT_DAILY_RETENTION,
};
