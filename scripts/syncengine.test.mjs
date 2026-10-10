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
S.setSetting('systemPrompt', 'Initial default');
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
S.setSetting('systemPrompt', 'Default from a newly installed phone');
check('a device that never synced needs the first sync', E.needsInitialSync(SCOPE) === true);
check('a guest never waits for a first sync', E.needsInitialSync('guest') === false);
E.markInitialSync('srv-empty', false);
check('completed empty account does not wait on every launch', E.needsInitialSync('srv-empty') === false);
E.resetSyncPosition('srv-empty');
check('explicit reset requires initial sync again', E.needsInitialSync('srv-empty') === true);
E.markInitialSync(SCOPE, true);
const progress = [];
result = await E.syncFully(SCOPE, { onProgress: p => progress.push(p) });
check('the first sync reports progress', progress.length > 0 && progress.at(-1).complete === true);
eq('and ends at 100%', E.syncPercent(progress.at(-1).rev, progress.at(-1).rev, progress.at(-1).complete), 100);
check('still pending until the app marks it done', E.needsInitialSync(SCOPE) === true);
E.markInitialSync(SCOPE, false);
check('then the device no longer waits', E.needsInitialSync(SCOPE) === false);
eq('percent is the cursor over the target', E.syncPercent(250, 1000, false), 25);
eq('an unfinished sync never shows 100%', E.syncPercent(1000, 1000, false), 99);
eq('an unknown target shows 0%', E.syncPercent(5, 0, false), 0);
eq('the phone downloads the account', result.applied.chats, 2);
eq('and the settings with it', result.applied.settings, 1);
eq('sync identifies precisely the settings to refresh without reload', JSON.stringify(result.applied.settingKeys), JSON.stringify(['systemPrompt']));

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

/* ============================================ two galleries, both of them true

   Reported as the Studio not syncing, and the half nobody saw was worse than
   the half they did: the gallery is a whole-list record, so whichever device
   wrote last replaced the other's outright. A phone with an empty Studio was
   enough to take an afternoon's pictures off a desktop.

   The panel has always merged what arrived with what it held -- but only while
   it was on screen, and the sync writes to storage whether anybody is looking
   or not. Sitting in a conversation was enough to lose them. So the merge is
   part of the write now. */

const JOBS = `studioHistory:${SCOPE}`;
const job = (id, state, at) => ({ id, state, startedAt: at, prompt: `p-${id}`, outputs: [{ media: 'image' }] });
/* As `saveHistory` writes it: every job carries when it last changed, because
   each is a record of its own on the wire and a record whose timestamp never
   moves cannot report that its state did. */
const writeJobs = (list) => {
  localStorage.setItem(JOBS, JSON.stringify(list.map(j => ({ ...j, savedAt: Date.now() }))));
  S.stampSetting(SCOPE, JOBS);
};
const jobsHere = () => JSON.parse(localStorage.getItem(JOBS) || '[]');

on(laptop);
await new Promise(r => setTimeout(r, 3));
writeJobs([job('a', 'done', 100), job('b', 'done', 200)]);
await E.syncFully(SCOPE);

// The phone makes one of its own, and keeps what the desktop made.
on(phone);
await E.syncFully(SCOPE);
eq('a second device receives the gallery', jobsHere().length, 2);
await new Promise(r => setTimeout(r, 3));
writeJobs([...jobsHere(), job('c', 'done', 300)]);
await E.syncFully(SCOPE);

/* And the desktop, which has meanwhile made one more and is not looking at the
   Studio at all, keeps its own and gains the phone's. This is the assertion
   the whole change exists for: before it, `d` was simply gone. */
on(laptop);
await new Promise(r => setTimeout(r, 3));
writeJobs([...jobsHere(), job('d', 'running', 400)]);
result = await E.syncFully(SCOPE);
const ids = jobsHere().map(j => j.id).sort();
eq('neither gallery replaces the other', ids.join(','), 'a,b,c,d');
eq('  and they are newest first', jobsHere()[0].id, 'd');
check('  counted as a studio change, which re-reads rather than reloads',
  result.applied.studio >= 1, JSON.stringify(result.applied));

// What this device added has to go back up, or the other never learns of it.
await E.syncFully(SCOPE);
on(phone);
await E.syncFully(SCOPE);
eq('the job made while looking elsewhere reaches the other device',
  jobsHere().map(j => j.id).sort().join(','), 'a,b,c,d');

/* Where both know a job, the one further along wins: "done" never turns back
   into "running". The phone still thinks `d` is running; the desktop has
   finished it. */
on(laptop);
await new Promise(r => setTimeout(r, 3));
writeJobs(jobsHere().map(j => (j.id === 'd' ? { ...j, state: 'done' } : j)));
await E.syncFully(SCOPE);
on(phone);
await E.syncFully(SCOPE);
eq('a finished job is not undone by a device that saw it running',
  jobsHere().find(j => j.id === 'd').state, 'done');

/* Forgetting one. A whole-list record could not say this at all -- a job
   missing from a list is indistinguishable from a list written by a device
   that never had it -- which is the other half of why this is per job. */
on(laptop);
await new Promise(r => setTimeout(r, 3));
writeJobs(jobsHere().filter(j => j.id !== 'a'));
await E.syncFully(SCOPE);
on(phone);
await E.syncFully(SCOPE);
check('a job forgotten on one device is forgotten on the other',
  !jobsHere().some(j => j.id === 'a'), jobsHere().map(j => j.id).join(','));
eq('  and the rest are still there', jobsHere().map(j => j.id).sort().join(','), 'b,c,d');

// Two devices that already agree must not bounce the record between them.
const galleryBefore = localStorage.getItem(JOBS);
result = await E.syncFully(SCOPE);
eq('an agreed gallery is no change at all', result.applied.studio, 0);
eq('  and storage is untouched', localStorage.getItem(JOBS), galleryBefore);
on(laptop);

/* ================================================ what the account will take

   Reported as "the pictures do not reach my phone". Two things were true at
   once, and each on its own is enough to stop an account syncing altogether.

   The browser has a list of the whole-list records it uploads, and the server
   has a list of the record kinds it accepts, and they were not the same list:
   `studio` and `studioJobs` were added to the first and never to the second.
   The server did not merely drop them -- validation threw, outside the
   transaction, so the entire upload failed. A device that had ever opened the
   Studio stopped syncing everything: chats, settings, documents.

   And a generated picture is kept in a chat as a base64 PNG, around thirteen
   megabytes, where one record may be eight. So a conversation with a picture
   in it was refused for its size -- which, before the fix above, also took the
   whole batch with it. */

{
  const { KINDS } = await import(pathToFileURL(path.join(HERE, '../server/records.js')).href);
  const source = fs.readFileSync(path.join(HERE, '../src/syncEngine.js'), 'utf8');
  const lists = /const WHOLE_LISTS = \[([^\]]*)\]/.exec(source)[1]
    .split(',').map(word => word.trim().replace(/'/g, '')).filter(Boolean);
  const sends = ['chat', 'document', 'memory', 'setting', ...lists];
  const unknown = sends.filter(kind => !KINDS.has(kind));
  eq('every kind the browser uploads is a kind the account stores', unknown.join(', '), '');
  check('  including the Studio\'s two', KINDS.has('studio') && KINDS.has('studioJobs'));

  /* One unacceptable record must not take the batch with it. Checked on the
     source because the alternative is standing up a database here; what
     matters is that validation is per record and inside a list, not a `map`
     that throws on the first one. */
  const records = fs.readFileSync(path.join(HERE, '../server/records.js'), 'utf8');
  check('a record that cannot be stored is refused, not thrown',
    /const refused = \[\];/.test(records)
    && /try \{\s*clean\.push\(validate\(record\)\);/.test(records)
    && !/^\s*const clean = records\.map\(validate\);/m.test(records));
  check('and what was refused is reported back', /refused: refused\.slice/.test(records));
}

/* -------------------------------------------- a picture, by address

   The bytes are already on the machine serving the app, and `/studio/view`
   hands them back by name. So what goes up is the address; an `<img src>` and
   a `fetch()` cannot tell the two apart. */

{
  const bytes = `data:image/png;base64,${'A'.repeat(400)}`;
  const chat = {
    id: 'c1',
    updatedAt: 5,
    messages: [
      { role: 'user', content: 'draw me one', images: ['AAAA'] },
      {
        role: 'assistant',
        generated: [
          { dataUrl: bytes, filename: 'mtx1_00001_.png', prompt: '1girl' },
          { dataUrl: bytes, filename: 'mtx2_00001_.png', url: '/studio/view?filename=mtx2_00001_.png&subfolder=webui&type=output' },
        ],
      },
    ],
  };
  const sent = E.withoutPictureBytes(chat);
  const shown = sent.messages[1].generated;
  check('a picture goes up as an address, not as itself', !shown[0].dataUrl.startsWith('data:'));
  eq('  built from the name it was saved under', shown[0].dataUrl,
    '/studio/view?filename=mtx1_00001_.png&subfolder=webui&type=output');
  eq('  or the one it already knows', shown[1].dataUrl,
    '/studio/view?filename=mtx2_00001_.png&subfolder=webui&type=output');
  eq('  and everything else about it is untouched', shown[0].prompt, '1girl');
  check('the chat it came from is not changed', chat.messages[1].generated[0].dataUrl === bytes);
  /* A picture the reader attached has no copy on the server, so there is no
     address to give: it goes up as it is, or not at all. */
  eq('a picture the reader attached is left alone', sent.messages[0].images[0], 'AAAA');

  // The one a redraw was made instead of is a whole picture of its own.
  const withOriginal = E.withoutPictureBytes({
    id: 'c2',
    messages: [{
      generated: [{
        dataUrl: bytes,
        filename: 'new.png',
        retouch: { region: 'hands', other: { dataUrl: bytes, filename: 'old.png' } },
      }],
    }],
  });
  const one = withOriginal.messages[0].generated[0];
  check('the picture kept beside a redraw goes by address too',
    !one.retouch.other.dataUrl.startsWith('data:'));
  eq('  and still says what it was', one.retouch.region, 'hands');

  // Nothing to say, nothing changed: the same object back, so nothing re-uploads.
  const plain = { id: 'c3', messages: [{ role: 'user', content: 'hello' }] };
  check('a chat with no pictures is the chat it was', E.withoutPictureBytes(plain) === plain);
  const nameless = { id: 'c4', messages: [{ generated: [{ dataUrl: bytes }] }] };
  check('and a picture with no name keeps its bytes, since nothing can fetch them',
    E.withoutPictureBytes(nameless).messages[0].generated[0].dataUrl === bytes);
  eq('a picture that cannot be addressed says so', E.pictureUrl({}), '');

  /* Twice is once: a device that received a chat by address and uploads it
     again must not wrap the address in another address. */
  check('sending an already-addressed chat changes nothing',
    E.withoutPictureBytes(sent) === sent);
}

/* And the whole point of it: a chat with a picture in it is small enough to
   store. Measured against the server's own limit rather than a number written
   out here, so raising one raises the other. */
{
  const { MAX_RECORD_BYTES } = await import(pathToFileURL(path.join(HERE, '../server/records.js')).href);
  // A 9.5 MB PNG, which is what these workflows save at their finished size.
  const real = `data:image/png;base64,${'A'.repeat(Math.round(9.5 * 1024 * 1024 * 4 / 3))}`;
  const heavy = {
    id: 'c5',
    messages: [{ generated: [{ dataUrl: real, filename: 'big.png' }] }],
  };
  check('one finished picture is past what a record may be',
    Buffer.byteLength(JSON.stringify(heavy)) > MAX_RECORD_BYTES);
  check('and by address the same chat fits with room to spare',
    Buffer.byteLength(JSON.stringify(E.withoutPictureBytes(heavy))) < 4096);
}

/* And the reason that matters for more than the upload.

   Reported as "leaving it open a long time and running the models many times
   makes it very laggy". It was not a leak. `persistSessions` -- the one door
   to storage -- reads the whole chat store, merges it, and writes the whole
   store back, and the save timer runs it every 400 to 800 milliseconds for
   the entire length of every reply. With the bytes in it, ten pictures made
   that a hundred and ten megabytes read and a hundred and ten written, twice
   a second, through IndexedDB's structured clone, on the main thread -- for
   an edit to one message. So the same transform guards that door too, and
   this pins it there rather than leaving it to the upload alone. */
{
  const app = fs.readFileSync(path.join(HERE, '../src/App.jsx'), 'utf8');
  check('the one door to storage writes pictures by address',
    /list = persistable\(list\)\.map\(withoutPictureBytes\)(?:\.map\(dedupeSession\))?;/.test(app));
  check('  using this transform, not a second one of its own',
    /withoutPictureBytes[\s\S]{0,600}from '\.\/syncEngine\.js'/.test(app));

  /* And the tab itself stops holding them, which is the other half of the
     same report: a finished result goes into the message as its address, not
     as eleven megabytes of base64 that storage then has to be told to strip
     out again. `withoutPictureBytes` stays where it is -- a chat that came
     from an older version, or a picture the reader attached, still goes
     through it -- but on this path there is now nothing left for it to do. */
  check('a finished picture goes into the message as its address',
    /const outputAddress = async \(url, signal\) => \{/.test(app)
    && /const dataUrl = await outputAddress\(output\.url, signal\);/.test(app));
  check('  and nothing turns a result into base64 any more',
    !/outputAsDataUrl/.test(app));
  check('  while what really needs the bytes fetches them back',
    /asBase64\(picture\.dataUrl\)/.test(app) && /await asDataUrl\(/.test(app));
  check('  including an export, which has to open on another machine',
    /sessionToHtml\(await sessionWithPictures\(target\)\)/.test(app)
    && /sessionToMarkdown\(await sessionWithPictures\(target\)\)/.test(app)
    && /sessionToPrintableHtml\(await sessionWithPictures\(target\)\)/.test(app));
}

{
  const browser = makeBrowser(); on(browser);
  const originalFetch = globalThis.fetch;
  await current.forage.setItem(CHATS, [{ id: 'inflight-edit', updatedAt: 100, messages: ['old'] }]);
  let intercept = true;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (intercept && args[0] === '/api/auth/sync') {
      intercept = false;
      await current.forage.setItem(CHATS, [{ id: 'inflight-edit', updatedAt: 200, messages: ['old', 'latest reply'] }]);
    }
    return response;
  };
  await E.syncOnce(SCOPE);
  globalThis.fetch = originalFetch;
  await E.syncOnce(SCOPE);
  eq('an edit during upload is sent on the next sync', server.rows.get('chat:inflight-edit').updatedAt, 200);
  eq('the final reply reaches the server', server.rows.get('chat:inflight-edit').payload.messages.at(-1), 'latest reply');

  await current.forage.setItem(CHATS, [{ id: 'legacy-unsent', updatedAt: 300, messages: ['previously skipped'] }]);
  localStorage.setItem(`syncSent@${SCOPE}`, JSON.stringify({ 'chat:legacy-unsent': 300 }));
  localStorage.removeItem(`syncSentAckVersion@${SCOPE}`);
  await E.syncOnce(SCOPE);
  eq('upgrade recovers chats incorrectly marked as already uploaded', server.rows.get('chat:legacy-unsent')?.updatedAt, 300);
}

{
  const huge = { kind: 'chat', id: 'oversized', updatedAt: 999, payload: 'x'.repeat(9 * 1024 * 1024) };
  const small = Array.from({ length: 205 }, (_, i) => ({ kind: 'chat', id: String(i), updatedAt: i, payload: 'small' }));
  const limited = E.uploadBatch([huge, ...small]);
  eq('oversized history does not block ordinary chats', limited.batch.length, 100);
  eq('oversized chat is explicitly reported', limited.refused.length, 1);
  eq('upload prioritizes newest chats', limited.batch[0].id, '204');
  eq('remaining upload pages are tracked', limited.remaining, 105);
  const moderate = Array.from({ length: 8 }, (_, i) => ({ kind: 'chat', id: String(i), updatedAt: i, payload: 'x'.repeat(5 * 1024 * 1024) }));
  check('large recovery is split below the request limit', JSON.stringify(E.uploadBatch(moderate).batch).length < 9 * 1024 * 1024);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
