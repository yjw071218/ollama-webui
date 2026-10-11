import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PREFIX = '{"$webuiEncrypted":1,';
const protectedValue = value => typeof value === 'string' && value.startsWith(PREFIX);
const dpapi = (bytes, protect) => {
  const action = protect ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${action}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Windows 계정으로 DB 암호화 키를 해제하지 못했습니다. 서버 실행 계정을 확인해 주세요.');
  return Buffer.from(result.stdout.trim(), 'base64');
};

function loadKey(directory, required) {
  const supplied = process.env.WEBUI_DB_KEY;
  if (supplied) {
    const key = Buffer.from(supplied, 'base64');
    if (key.length !== 32) throw new Error('WEBUI_DB_KEY must be a base64-encoded 32-byte key.');
    return key;
  }
  const file = process.env.WEBUI_DB_KEY_FILE || path.join(directory, 'storage.key');
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bytes = Buffer.from(saved.key, 'base64');
    const key = saved.protection === 'windows-dpapi' ? dpapi(bytes, false) : bytes;
    if (key.length !== 32) throw new Error('Invalid database encryption key.');
    return key;
  }
  if (required) throw new Error('DB 암호화 키가 없습니다. 기존 storage.key 또는 WEBUI_DB_KEY를 복원해 주세요.');
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const windows = process.platform === 'win32';
  try {
    fs.writeFileSync(file, JSON.stringify({ protection: windows ? 'windows-dpapi' : 'file-mode-600', key: (windows ? dpapi(key, true) : key).toString('base64') }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return loadKey(directory, required);
    throw error;
  }
  return key;
}

export function storageCipher(key) {
  return {
    encrypt(value) {
      if (value == null || protectedValue(value)) return value;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from('ollama-webui/storage/v1'));
      const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return JSON.stringify({ $webuiEncrypted: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    },
    decrypt(value) {
      if (value == null || !protectedValue(value)) return value;
      const data = JSON.parse(value);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
      decipher.setAAD(Buffer.from('ollama-webui/storage/v1'));
      decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8');
    },
    hash(value) { return crypto.createHmac('sha256', key).update('search/v1\0').update(value).digest('base64url'); },
  };
}

export const normaliseSearch = value => String(value || '').normalize('NFKC').toLowerCase();
export const chatText = payload => {
  const chat = JSON.parse(payload);
  return normaliseSearch([chat?.title, ...(Array.isArray(chat?.messages) ? chat.messages : []).map(m => m?.content)].filter(v => typeof v === 'string').join('\n'));
};
export function searchGrams(text, query = false) {
  const chars = [...normaliseSearch(text)];
  const grams = new Set();
  const sizes = query ? [Math.min(3, chars.length)] : [1, 2, 3];
  for (const size of sizes) if (size) for (let i = 0; i <= chars.length - size; i++) grams.add(chars.slice(i, i + size).join(''));
  return [...grams];
}

export function initialiseStorageSecurity(db, directory) {
  const mark = db.prepare("SELECT value FROM meta WHERE key = 'storage-security-v1'").get();
  const cipher = storageCipher(loadKey(directory, !!mark));
  // Fail before serving any requests if a different key was supplied.
  if (mark) cipher.decrypt(mark.value);
  db.function('webui_decrypt', value => cipher.decrypt(value));
  db.function('webui_encrypt', value => cipher.encrypt(value));
  db.function('webui_search_hash', value => cipher.hash(value));
  db.function('webui_search_tokens', value => {
    if (!value) return '[]';
    return JSON.stringify(searchGrams(chatText(cipher.decrypt(value))).map(term => cipher.hash(term)));
  });
  db.exec('PRAGMA secure_delete = ON');
  // Read views keep all consumers (history, server turns, sync) on the same codec.
  const tables = { records: 'payload', record_history: 'payload', history_blobs: 'data', record_quarantine: 'payload', shares: 'payload' };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, column] of Object.entries(tables)) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      db.exec(`CREATE VIEW IF NOT EXISTS readable_${table} AS SELECT rowid, ${columns.map(c => c === column ? `webui_decrypt(${c}) AS ${c}` : c).join(',')} FROM ${table}`);
      for (const event of ['INSERT', 'UPDATE']) db.exec(`CREATE TRIGGER IF NOT EXISTS protect_${table}_${event} AFTER ${event} ON ${table}
        WHEN NEW.${column} IS NOT NULL AND substr(NEW.${column},1,${PREFIX.length}) <> '{"$webuiEncrypted":1,'
        BEGIN UPDATE ${table} SET ${column} = webui_encrypt(NEW.${column}) WHERE rowid = NEW.rowid; END;`);
      if (!mark) db.exec(`UPDATE ${table} SET ${column} = webui_encrypt(${column}) WHERE ${column} IS NOT NULL`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS record_search (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(user_id, token, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS record_search_chat ON record_search(user_id,id);
    CREATE TRIGGER IF NOT EXISTS search_record_delete AFTER DELETE ON records BEGIN
      DELETE FROM record_search WHERE user_id=OLD.user_id AND id=OLD.id AND OLD.kind='chat'; END;`);
    for (const event of ['INSERT', 'UPDATE OF payload,deleted']) db.exec(`CREATE TRIGGER IF NOT EXISTS search_record_${event.startsWith('INSERT') ? 'insert' : 'update'} AFTER ${event} ON records
      WHEN NEW.kind='chat' AND (NEW.payload IS NULL OR substr(NEW.payload,1,${PREFIX.length}) <> '{"$webuiEncrypted":1,')
      BEGIN
      DELETE FROM record_search WHERE user_id=NEW.user_id AND id=NEW.id;
      INSERT OR IGNORE INTO record_search(user_id,token,id)
        SELECT NEW.user_id,value,NEW.id FROM json_each(webui_search_tokens(NEW.payload)) WHERE NEW.deleted=0;
      END;`);
    if (!mark) {
      db.exec(`INSERT OR IGNORE INTO record_search(user_id,token,id)
        SELECT r.user_id,t.value,r.id FROM records r, json_each(webui_search_tokens(r.payload)) t WHERE r.kind='chat' AND r.deleted=0`);
      db.prepare("INSERT INTO meta(key,value) VALUES('storage-security-v1',?)").run(cipher.encrypt('storage key check'));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (!mark) {
    // Remove old plaintext from free pages and the WAL after the atomic migration.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
}
