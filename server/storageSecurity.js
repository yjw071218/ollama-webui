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
/** Every 1-, 2- and 3-character run of a text, once each. One pass, by code point. */
export function gramSet(text) {
  const grams = new Set();
  let a = '';
  let b = '';
  for (const ch of normaliseSearch(text)) {
    grams.add(ch);
    if (b !== '') {
      grams.add(b + ch);
      if (a !== '') grams.add(a + b + ch);
    }
    a = b;
    b = ch;
  }
  return grams;
}
export function searchGrams(text, query = false) {
  if (!query) return [...gramSet(text)];
  const chars = [...normaliseSearch(text)];
  const grams = new Set();
  const size = Math.min(3, chars.length);
  if (size) for (let i = 0; i <= chars.length - size; i++) grams.add(chars.slice(i, i + size).join(''));
  return [...grams];
}

/* What the search index holds for the chats written lately: per chat, the set
   of grams its rows stand for. See webui_search_delta below. Forgotten whenever
   a transaction is rolled back, since what it describes may not have happened. */
const indexedGrams = new Map();
const INDEXED_CHATS = 8;
let lastDelta = null;
export const forgetSearchState = () => { indexedGrams.clear(); lastDelta = null; };
export function initialiseStorageSecurity(db, directory) {
  const mark = db.prepare("SELECT value FROM meta WHERE key = 'storage-security-v1'").get();
  const cipher = storageCipher(loadKey(directory, !!mark));
  // Fail before serving any requests if a different key was supplied.
  if (mark) cipher.decrypt(mark.value);
  db.function('webui_decrypt', value => cipher.decrypt(value));
  db.function('webui_encrypt', value => cipher.encrypt(value));
  db.function('webui_search_hash', value => cipher.hash(value));
  /* A gram's hash, remembered: a chat is saved whole every second or two
     while an answer streams, and its grams are nearly all the ones hashed a
     second ago. */
  const hashes = new Map();
  const hashOf = (term) => {
    let hash = hashes.get(term);
    if (hash === undefined) {
      if (hashes.size >= 400000) hashes.clear();
      hash = cipher.hash(term);
      hashes.set(term, hash);
    }
    return hash;
  };
  db.function('webui_search_tokens', value => {
    if (!value) return '[]';
    return JSON.stringify(searchGrams(chatText(cipher.decrypt(value))).map(hashOf));
  });
  /* What a save changes in the index, as {"full":0|1,"add":[..],"del":[..]}.
   *
   * The index was kept by SQL alone: on every save, all of the chat's tokens
   * were deleted and inserted again -- 106,000 rows for one long chat, six
   * seconds in which the server answered nobody, for one more sentence. Even
   * comparing them all in SQL is a second. But this process wrote the previous
   * version too, so it can know which grams are already there and hand over
   * only the difference: usually a handful.
   *
   * It is only believed when the index agrees: `count`, the number of rows the
   * chat has right now, must be the number remembered. Otherwise (first save
   * since the start, a rollback, a deletion, another process) the answer is
   * "full": `add` is every token, and the trigger removes whatever is not in it.
   * Asked several times per save by the trigger, so the last answer is kept. */
  forgetSearchState();
  db.function('webui_search_delta', (userId, id, payload, deleted, count) => {
    const key = `${userId}\u0000${id}`;
    const gone = !!deleted || !payload;
    if (lastDelta && lastDelta.key === key && lastDelta.gone === gone && lastDelta.payload === payload) return lastDelta.json;
    const next = gone ? new Set() : gramSet(chatText(cipher.decrypt(payload)));
    const held = indexedGrams.get(key);
    let delta;
    if (held && held.size === Number(count)) {
      const add = [];
      const del = [];
      for (const gram of next) if (!held.has(gram)) add.push(hashOf(gram));
      for (const gram of held) if (!next.has(gram)) del.push(hashOf(gram));
      delta = { full: 0, add, del };
    } else {
      delta = { full: 1, add: [...next].map(hashOf), del: [] };
    }
    indexedGrams.delete(key);
    indexedGrams.set(key, next);
    if (indexedGrams.size > INDEXED_CHATS) indexedGrams.delete(indexedGrams.keys().next().value);
    lastDelta = { key, gone, payload, json: JSON.stringify(delta) };
    return lastDelta.json;
  });
  /* The answer just given, for the trigger's later statements: asking again
     would count the chat's rows again each time. Nothing to do if it is
     somehow not this chat's -- the next save then finds the count off. */
  db.function('webui_search_last', (userId, id) =>
    (lastDelta && lastDelta.key === `${userId}\u0000${id}` ? lastDelta.json : '{"full":0,"add":[],"del":[]}'));
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
    /* Keeping the index in step with a save; see webui_search_delta above.
       TEMP triggers, belonging to this connection rather than to the file: the
       body calls a function only this version registers, and a trigger stored
       in the file would make every save fail under an older server that opens
       it. The stored ones are dropped; an older server puts its own back. */
    const delta = 'webui_search_last(NEW.user_id,NEW.id)';
    for (const event of ['INSERT', 'UPDATE OF payload,deleted']) {
      const name = `search_record_${event.startsWith('INSERT') ? 'insert' : 'update'}`;
      db.exec(`DROP TRIGGER IF EXISTS main.${name};
      DROP TRIGGER IF EXISTS temp.${name};
      CREATE TEMP TRIGGER ${name} AFTER ${event} ON main.records
      WHEN NEW.kind='chat' AND (NEW.payload IS NULL OR substr(NEW.payload,1,${PREFIX.length}) <> '{"$webuiEncrypted":1,')
      BEGIN
      -- worked out once, against the number of rows the chat has now
      SELECT webui_search_delta(NEW.user_id,NEW.id,NEW.payload,NEW.deleted,
        (SELECT COUNT(*) FROM record_search WHERE user_id=NEW.user_id AND id=NEW.id));
      -- the usual case: the few tokens the chat no longer has
      DELETE FROM record_search WHERE user_id=NEW.user_id
        AND id=(SELECT CASE WHEN json_extract(${delta},'$.full') THEN NULL ELSE NEW.id END)
        AND token IN (SELECT value FROM json_each(${delta},'$.del'));
      -- "full": everything the chat's new text does not account for
      DELETE FROM record_search WHERE user_id=NEW.user_id
        AND id=(SELECT CASE WHEN json_extract(${delta},'$.full') THEN NEW.id END)
        AND token NOT IN (SELECT value FROM json_each(${delta},'$.add'));
      -- NOT EXISTS rather than OR IGNORE: inside a trigger the conflict rule
      -- is the firing statement's, and the upsert that fires this one aborts.
      INSERT INTO record_search(user_id,token,id)
        SELECT DISTINCT NEW.user_id,value,NEW.id FROM json_each(${delta},'$.add')
         WHERE NOT EXISTS (SELECT 1 FROM record_search s WHERE s.user_id=NEW.user_id AND s.token=value AND s.id=NEW.id);
      END;`);
    }
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
