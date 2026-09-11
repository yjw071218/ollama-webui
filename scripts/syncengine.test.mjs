// The client half of syncing: turning browser storage into records and back.
//
// The server's half is checked over real HTTP in auth.test.mjs. This is the
// part that has to be right for any of that to help — because a record with a
// wrong or missing timestamp cannot win or lose a conflict correctly, and a
// deletion that is never noticed locally never becomes a tombstone at all.
//
// Two devices are simulated by two independent localStorage/IndexedDB pairs
// talking to one in-memory record store that behaves like the server.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------- a browser, per device */

const makeBrowser = () => {
  const local = new Map();
  const stores = new Map();
  const inst = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async getItem(k) { return m.has(k) ? m.get(k) : null; },
      async setItem(k, v) { m.set(k, v); return v; },
      async removeItem(k) { m.delete(k); },
      async iterate(fn) { for (const [k, v] of m) fn(v, k); },
      createInstance: ({ storeName }) => inst(storeName),
    };
  };
  return {
    localStorage: {
      get length() { return local.size; },
      key: (i) => [...local.keys()][i] ?? null,
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k),
    },
    forage: inst('default'),
    raw: { local, stores },
  };
};

// The module reads these off globalThis at call time, so swapping them between
// calls is what makes one process behave as two devices.
let current = makeBrowser();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true, get: () => current.localStorage,
});
globalThis.location = { origin: 'http://localhost:5173' };

const forageStub = path.resolve(HERE, '../node_modules/.localforage-engine-stub.mjs');
fs.writeFileSync(forageStub, `
const proxy = new Proxy({}, {
  get(_, prop) {
    const target = globalThis.__forage;
    const value = target[prop];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
export default proxy;
`);
Object.defineProperty(globalThis, '__forage', {
  configurable: true, get: () => current.forage,
});

/* ------------------------------------------------- a server, in memory */

// Deliberately a re-implementation of the rules rather than an import of them:
// a client test that shares the server's code proves the two agree, not that
// either is right.
const server = {
  rev: 0,
  rows: new Map(),   // "kind:id" -> { kind, id, rev, updatedAt, deleted, payload }
  apply(records) {
    let applied = 0, rejected = 0;
    for (const r of records) {
      const key = `${r.kind}:${r.id}`;
      const current = this.rows.get(key);
      if (current && current.updatedAt > r.updatedAt) { rejected++; continue; }
      if (current && current.updatedAt === r.updatedAt && current.deleted && !r.deleted) {
        rejected++; continue;
      }
      this.rev++;
      this.rows.set(key, {
        kind: r.kind, id: r.id, rev: this.rev,
        updatedAt: r.updatedAt, deleted: !!r.deleted,
        payload: r.deleted ? null : r.payload,
      });
      applied++;
    }
    return { applied, rejected };
  },
  since(rev) {
    return [...this.rows.values()].filter(r => r.rev > rev).sort((a, b) => a.rev - b.rev);
  },
};

let calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push(url);
  const method = options.method || 'GET';
  let body = {};
  if (method === 'POST') {
    const sent = JSON.parse(options.body);
    const { applied, rejected } = server.apply(sent.records || []);
    body = {
      success: true, ownerId: 'abc', applied, rejected,
      records: server.since(sent.since || 0), rev: server.rev, complete: true,
    };
  } else if (url.startsWith('/api/auth/stats')) {
    body = { success: true, ownerId: 'abc', rev: server.rev, chats: 0, savedAt: 1 };
  } else {
    const since = Number(new URL(url, 'http://x').searchParams.get('since') || 0);
    body = { success: true, ownerId: 'abc', records: server.since(since), rev: server.rev, complete: true };
  }
  return { ok: true, status: 200, json: async () => body };
};

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/syncEngine.js'),
  external: ['react', 'react/jsx-runtime', 'lucide-react'],
  platform: 'neutral',
  resolve: { alias: { localforage: forageStub } },
});
const file = path.resolve(HERE, '../node_modules/.syncengine-test.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();

const E = await import(pathToFileURL(file).href);
const settingsFile = path.resolve(HERE, '../node_modules/.syncengine-settings.mjs');
const settingsBundle = await rolldown({
  input: path.resolve(HERE, '../src/settingsStore.js'), platform: 'neutral',
});
await settingsBundle.write({ file: settingsFile, format: 'esm' });
await settingsBundle.close();
const S = await import(pathToFileURL(settingsFile).href);

// Bundled so the folder tests below go through the real save path rather than
// a reimplementation of it -- the bug was in that path, not in the sync.
const foldersFile = path.resolve(HERE, '../node_modules/.syncengine-folders.mjs');
const foldersBundle = await rolldown({
  input: path.resolve(HERE, '../src/folders.js'), platform: 'neutral',
});
await foldersBundle.write({ file: foldersFile, format: 'esm' });
await foldersBundle.close();
const F = await import(pathToFileURL(foldersFile).href);

let pass = 0, fail = 0;
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n}  -> ${d}`); }
};
const eq = (n, got, want) => check(n, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const SCOPE = 'srv-abc';
const CHATS = `ollama-sessions:${SCOPE}`;

/* ----------------------------------------------------- records from storage */

const laptop = makeBrowser();
const phone = makeBrowser();
const on = (browser) => { current = browser; };

on(laptop);
await current.forage.setItem(CHATS, [
  { id: 1, title: 'First', updatedAt: 1000, messages: [] },
  { id: 2, title: 'Second', updatedAt: 2000, messages: [] },
]);
S.setActiveScope(SCOPE);
S.setSetting('systemPrompt', 'Be terse.');

let records = await E.collectLocal(SCOPE);
eq('both chats become records', records.filter(r => r.kind === 'chat').length, 2);
eq('a chat carries its own timestamp',
  records.find(r => r.kind === 'chat' && r.id === '2').updatedAt, 2000);

const setting = records.find(r => r.kind === 'setting' && r.id === 'systemPrompt');
check('a setting becomes a record', !!setting);
check('and carries a timestamp of its own', setting.updatedAt > 0);
eq('with its value', setting.payload, 'Be terse.');

// The bookkeeping must never be mistaken for a setting and shipped to every
// device — a synced `syncRev` would tell each device it was somewhere it is not.
check('the sync cursor is not a setting',
  !records.some(r => r.kind === 'setting' && r.id.startsWith('syncRev')));
check('nor are the stamps themselves',
  !records.some(r => r.kind === 'setting' && r.id.startsWith('settingStamps')));

/* ------------------------------------------------------- the first sync up */

let result = await E.syncFully(SCOPE);
eq('the laptop uploads what it has', result.sent, 3);
check('and records where it got to', E.readRev(SCOPE) > 0);
eq('the account now holds the chats', server.since(0).filter(r => r.kind === 'chat').length, 2);

// A second sync with nothing changed must send nothing. Without the record of
// what was already uploaded, every sync would re-send the whole store.
calls = [];
result = await E.syncFully(SCOPE);
eq('an unchanged device sends nothing', result.sent, 0);

/* ------------------------------------------------ a second device, from empty */

on(phone);
S.setActiveScope(SCOPE);
result = await E.syncFully(SCOPE);
eq('the phone downloads the account', result.applied.chats, 2);
eq('and the settings with it', result.applied.settings, 1);

const phoneChats = await current.forage.getItem(CHATS);
eq('the chats really landed', phoneChats.length, 2);
eq('with their content', phoneChats.find(c => String(c.id) === '1').title, 'First');
eq('and the setting is readable', S.getSetting('systemPrompt'), 'Be terse.');

/* --------------------------------------------- each device writes its own */

on(phone);
await current.forage.setItem(CHATS, [
  ...(await current.forage.getItem(CHATS)),
  { id: 3, title: 'Written on the phone', updatedAt: 3000, messages: [] },
]);
await E.syncFully(SCOPE);

// The step a blob got wrong: the laptop has never seen chat 3, and syncs.
on(laptop);
result = await E.syncFully(SCOPE);
const laptopChats = await current.forage.getItem(CHATS);
eq('the laptop receives the chat it never had', laptopChats.length, 3);
check('and keeps its own', laptopChats.some(c => c.title === 'First'));
check("as well as the phone's", laptopChats.some(c => c.title === 'Written on the phone'));

/* ------------------------------------------------------------- a deletion */

on(laptop);
await current.forage.setItem(CHATS,
  (await current.forage.getItem(CHATS)).filter(c => String(c.id) !== '1'));
result = await E.syncFully(SCOPE);
eq('deleting locally sends a tombstone', result.sent, 1);
check('and the account records it as deleted', server.rows.get('chat:1').deleted === true);

// The phone still holds chat 1. Under a blob its next upload put the chat
// back; the tombstone is newer, so instead the phone loses it too.
on(phone);
result = await E.syncFully(SCOPE);
const afterDelete = await current.forage.getItem(CHATS);
check('the deletion reaches the other device', !afterDelete.some(c => String(c.id) === '1'));
eq('and nothing else was disturbed', afterDelete.length, 2);

/* ------------------------------------------------------- deleting, undone */

// A deletion now goes up the moment it happens rather than four seconds later,
// because a reload inside those four seconds pulled the chat straight back —
// which on a phone is the ordinary case, refreshing being how you return to the
// app. The cost of not waiting is that Undo has a tombstone to beat.
//
// A restore carrying the chat's *original* timestamp cannot beat it: the
// tombstone is stamped with the moment of deletion and is therefore newer. So
// the restore is stamped with when it was restored, and this is the check that
// says so — get it wrong and Undo appears to work, then the chat vanishes again
// on the next sync.
on(laptop);
const doomed = { id: 7, title: 'Deleted then restored', updatedAt: 5000, messages: [] };
await current.forage.setItem(CHATS, [...(await current.forage.getItem(CHATS)), doomed]);
await E.syncFully(SCOPE);
check('a chat to delete reaches the account', !!server.rows.get('chat:7'));

await current.forage.setItem(CHATS,
  (await current.forage.getItem(CHATS)).filter(c => String(c.id) !== '7'));
await E.syncFully(SCOPE);
check('deleting it leaves a tombstone', server.rows.get('chat:7').deleted === true);

// Undo, done the wrong way: the record goes back exactly as it was.
await current.forage.setItem(CHATS, [...(await current.forage.getItem(CHATS)), doomed]);
await E.syncFully(SCOPE);
check('a restore stamped with the old time loses to the tombstone',
  server.rows.get('chat:7').deleted === true);

// Undo, done the way the app does it.
await current.forage.setItem(CHATS, [
  ...(await current.forage.getItem(CHATS)).filter(c => String(c.id) !== '7'),
  { ...doomed, updatedAt: Date.now() + 1000 },
]);
await E.syncFully(SCOPE);
eq('a restore stamped with now wins', server.rows.get('chat:7').deleted, false);
eq('and the chat is whole', server.rows.get('chat:7').payload.title, 'Deleted then restored');

// And the other device is told, rather than keeping the tombstone.
on(phone);
await E.syncFully(SCOPE);
check('the restore reaches the other device',
  (await current.forage.getItem(CHATS)).some(c => String(c.id) === '7'));

on(laptop);

/* ------------------------------------------- the same chat, edited on both */

on(laptop);
let chats = await current.forage.getItem(CHATS);
await current.forage.setItem(CHATS, chats.map(c => (
  String(c.id) === '3' ? { ...c, title: 'laptop edit', updatedAt: 9000 } : c
)));
await E.syncFully(SCOPE);

on(phone);
chats = await current.forage.getItem(CHATS);
await current.forage.setItem(CHATS, chats.map(c => (
  String(c.id) === '3' ? { ...c, title: 'phone edit, older', updatedAt: 4000 } : c
)));
await E.syncFully(SCOPE);

eq('the later edit wins', server.rows.get('chat:3').payload.title, 'laptop edit');
const settled = await current.forage.getItem(CHATS);
eq('and the losing device is corrected',
  settled.find(c => String(c.id) === '3').title, 'laptop edit');

/* ---------------------------------------------- settings, changed on each */

on(laptop);
S.setActiveScope(SCOPE);
S.setSetting('theme', 'dark');
await E.syncFully(SCOPE);

on(phone);
S.setActiveScope(SCOPE);
S.setSetting('chatFontSize', 'large');
await E.syncFully(SCOPE);

eq('the phone keeps its own setting', S.getSetting('chatFontSize'), 'large');
eq('and receives the other device\'s', S.getSetting('theme'), 'dark');

on(laptop);
S.setActiveScope(SCOPE);
await E.syncFully(SCOPE);
eq('and the laptop receives the phone\'s', S.getSetting('chatFontSize'), 'large');
eq('while keeping its own', S.getSetting('theme'), 'dark');

/* ----------------------------------------------------- a full re-download */

on(phone);
E.resetSyncPosition(SCOPE);
eq('resetting forgets the position', E.readRev(SCOPE), 0);
result = await E.syncFully(SCOPE, { full: true });
check('a full sync brings the account down again', result.received > 0);
check('and the chats are still right',
  (await current.forage.getItem(CHATS)).some(c => c.title === 'laptop edit'));

/* ------------------------------------------------------ the owner check */

let mismatch = '';
// Put back afterwards: everything below this talks to the in-memory server,
// and a test that leaves every later sync answering as another account makes
// each of those fail for a reason that has nothing to do with them.
const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ success: true, ownerId: 'someone-else', records: [], rev: 1, complete: true }),
  });
  await E.syncFully(SCOPE);
} catch (e) { mismatch = e.name; }
globalThis.fetch = realFetch;
eq('an answer for another account is refused, not merged', mismatch, 'OwnerMismatch');

/* ------------------------------------------- a folder deleted on one device */

// The whole folder list travels as one record, and the sync decides whether a
// device has anything to say by comparing that record's timestamp with the one
// it last sent. `saveFolders` wrote the list and did not move the timestamp,
// so the answer was always "nothing has changed".
//
// The first save still went up -- there was no previous timestamp to match --
// and nothing ever did again. Deleting was the case that showed: a folder
// removed on the laptop stayed on the phone through every sync and every
// reload, because as far as the account was concerned the laptop had not
// touched its folders since the day it created them.
on(laptop);
F.saveFolders(SCOPE, [{ id: 'f1', name: 'Work', systemPrompt: '', createdAt: 1 }]);
const folderCreate = (await E.collectLocal(SCOPE)).find(r => r.kind === 'folders');
check('the folder list becomes a record', !!folderCreate);
check('and carries a real timestamp, not zero', folderCreate && folderCreate.updatedAt > 0,
  String(folderCreate && folderCreate.updatedAt));

// A second write has to be visibly newer or the sync cannot tell the two
// apart. The wait is because Date.now() has millisecond resolution and these
// writes would otherwise land inside the same one.
await new Promise(r => setTimeout(r, 3));
F.saveFolders(SCOPE, []);
const folderDelete = (await E.collectLocal(SCOPE)).find(r => r.kind === 'folders');
check('deleting a folder moves the timestamp forward',
  folderDelete.updatedAt > folderCreate.updatedAt,
  `${folderCreate.updatedAt} -> ${folderDelete.updatedAt}`);
eq('and the record carries the emptied list', folderDelete.payload, '[]');

// Renaming is the same shape and would have failed the same way.
await new Promise(r => setTimeout(r, 3));
F.saveFolders(SCOPE, [{ id: 'f1', name: 'Renamed', systemPrompt: '', createdAt: 1 }]);
const folderRename = (await E.collectLocal(SCOPE)).find(r => r.kind === 'folders');
check('renaming one moves it forward too', folderRename.updatedAt > folderDelete.updatedAt);

/* ============================ the Studio's own upload, coming back to it

   The server returns a device's own writes in the same response that accepts
   them. Every other kind here checks that an incoming record is genuinely
   newer; the whole-list branch did not, and did not check whether anything had
   changed either. So a Studio write went up, came back as a copy of what was
   uploaded — which can be seconds older than what has been typed since —
   overwrote the newer local value, was counted as a change, and the count
   reloaded the page into that older copy. The reported symptom was the main
   prompt missing from the picture: typed, then gone before Generate. */

const STUDIO = `studioSettings:${SCOPE}`;
const writeStudio = (prompt) => {
  localStorage.setItem(STUDIO, JSON.stringify({ 'anima-base': { prompt } }));
  S.stampSetting(SCOPE, STUDIO);
};

on(laptop);
await new Promise(r => setTimeout(r, 3));
writeStudio('lead only');
result = await E.syncFully(SCOPE);
eq('an own upload coming back is not a studio change', result.applied.studio, 0);
eq('nor an ordinary list change', result.applied.lists, 0);
eq('and the value is untouched', JSON.parse(localStorage.getItem(STUDIO))['anima-base'].prompt, 'lead only');

/* The bug itself: something newer is typed after the upload was taken, and the
   older copy comes back. `full` forces the account's whole state down — which
   is exactly the stale copy — without uploading the newer one first. */
await new Promise(r => setTimeout(r, 3));
writeStudio('lead only, plus the main prompt');
result = await E.syncFully(SCOPE, { full: true });
eq('a stale copy does not overwrite what was typed since',
  JSON.parse(localStorage.getItem(STUDIO))['anima-base'].prompt, 'lead only, plus the main prompt');
eq('and is not counted as a change', result.applied.studio, 0);

// Once the newer one has gone up, another device receives it — reported as a
// Studio change, which re-reads in place, not a list change, which reloads.
result = await E.syncFully(SCOPE);
on(phone);
result = await E.syncFully(SCOPE);
eq('another device gets the newer prompt',
  JSON.parse(localStorage.getItem(STUDIO) || '{}')['anima-base']?.prompt, 'lead only, plus the main prompt');
check('reported as a studio change', result.applied.studio >= 1, JSON.stringify(result.applied));

// The same content arriving again, newer only by the clock, changes nothing.
const studioBefore = localStorage.getItem(STUDIO);
result = await E.syncFully(SCOPE);
eq('arriving again is no change', result.applied.studio, 0);
eq('and leaves storage exactly as it was', localStorage.getItem(STUDIO), studioBefore);
on(laptop);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
