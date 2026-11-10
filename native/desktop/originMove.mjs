import { BrowserWindow } from 'electron';

/* Moves a server's page storage from one app origin to another.

   Windows (Hyper-V/WSL/Docker) can reserve the port a server's origin was
   built on, and then nothing may listen there again. The origin is what the
   browser keys IndexedDB and localStorage by, so a new port alone would start
   from empty. Both origins are instead served from inside the app for a
   moment — no socket is opened, so the reservation does not matter — and a
   page on the new origin copies everything out of a frame on the old one.
   Cookies are keyed by host, not port, and come along by themselves. The old
   origin's data is left where it is. */

const PATH = '/__origin-move';

const source = to => `<!doctype html><meta charset="utf-8"><script>
const TO = ${JSON.stringify(to)};
let acked;
addEventListener('message', e => { if (e.origin === TO && e.data && e.data.ack) acked?.(); });
// One message in flight: the receiving page writes before the next is read.
const send = m => new Promise(resolve => { acked = resolve; parent.postMessage(m, TO); });
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
function batch(db, name, after) {
  return new Promise((resolve, reject) => {
    const rows = [], tx = db.transaction(name, 'readonly');
    const cursor = tx.objectStore(name).openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return resolve({ rows, more: false });
      rows.push([c.primaryKey, c.value]);
      if (rows.length >= 200) resolve({ rows, more: true }); else c.continue();
    };
    tx.onerror = () => reject(tx.error);
  });
}
(async () => {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); entries.push([k, localStorage.getItem(k)]); }
  await send({ type: 'local', entries });
  let records = 0;
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await request(indexedDB.open(name));
    const names = [...db.objectStoreNames];
    const stores = [];
    if (names.length) {
      const tx = db.transaction(names, 'readonly');
      for (const n of names) {
        const s = tx.objectStore(n);
        stores.push({ name: n, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: [...s.indexNames].map(i => { const x = s.index(i); return { name: i, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }; }) });
      }
    }
    await send({ type: 'db', name, version: db.version, stores });
    for (const store of stores) {
      let after, more = true;
      while (more) {
        const part = await batch(db, store.name, after);
        more = part.more;
        if (!part.rows.length) break;
        after = part.rows[part.rows.length - 1][0];
        records += part.rows.length;
        await send({ type: 'rows', db: name, store: store.name, inline: store.keyPath !== null, rows: part.rows });
      }
    }
    db.close();
  }
  await send({ type: 'done', records });
})().catch(error => parent.postMessage({ type: 'error', message: String(error?.message || error) }, TO));
</script>`;

const target = from => `<!doctype html><meta charset="utf-8"><body><script>
const FROM = ${JSON.stringify(from)};
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const dbs = new Map();
async function apply(m) {
  if (m.type === 'local') { localStorage.clear(); for (const [k, v] of m.entries) localStorage.setItem(k, v); return; }
  if (m.type === 'db') {
    const open = indexedDB.open(m.name, m.version);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of m.stores) {
        const store = db.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    dbs.set(m.name, await request(open));
    return;
  }
  if (m.type === 'rows') {
    const tx = dbs.get(m.db).transaction(m.store, 'readwrite'), store = tx.objectStore(m.store);
    for (const [key, value] of m.rows) m.inline ? store.put(value) : store.put(value, key);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
  }
}
window.moved = new Promise((resolve, reject) => {
  let chain = Promise.resolve();
  addEventListener('message', e => {
    if (e.origin !== FROM || !e.data) return;
    const m = e.data;
    if (m.type === 'error') return reject(new Error(m.message));
    chain = chain.then(() => apply(m)).then(() => {
      if (m.type === 'done') { for (const db of dbs.values()) db.close(); resolve({ records: m.records, databases: dbs.size }); }
      else e.source.postMessage({ ack: true }, FROM);
    }, reject);
  });
  const frame = document.createElement('iframe');
  frame.src = FROM + ${JSON.stringify(PATH)};
  document.body.append(frame);
});
</script></body>`;

export async function moveOrigin(ses, from, to, timeoutMs = 10 * 60 * 1000) {
  // Not cookies: they belong to the host, not the port, so clearing the new
  // origin's would sign the old one out too.
  await ses.clearStorageData({ origin: to, storages: ['filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'] });
  const page = html => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  ses.protocol.handle('http', req => {
    const url = new URL(req.url);
    if (url.pathname === PATH && url.origin === to) return page(target(from));
    if (url.pathname === PATH && url.origin === from) return page(source(to));
    return new Response('', { status: 404 });
  });
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let timer;
  try {
    await win.loadURL(to + PATH);
    return await Promise.race([
      win.webContents.executeJavaScript('window.moved', true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!win.isDestroyed()) win.destroy();
    ses.protocol.unhandle('http');
  }
}
