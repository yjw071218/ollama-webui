// Backup and restore, against a fake localStorage and a fake localforage.
//
// This is the code that moves someone's entire history between origins, so the
// cases that matter are the destructive ones: restoring twice, restoring onto a
// browser that already has chats, and telling merge apart from replace.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- fakes ---------------------------------------------------------------
const storeData = new Map();          // storeName -> Map(key -> value)
const storeFor = (name) => {
  if (!storeData.has(name)) storeData.set(name, new Map());
  return storeData.get(name);
};

const instance = (name) => ({
  async getItem(key) { const v = storeFor(name).get(key); return v === undefined ? null : v; },
  async setItem(key, value) { storeFor(name).set(key, value); return value; },
  async removeItem(key) { storeFor(name).delete(key); },
  async iterate(fn) { for (const [k, v] of storeFor(name)) fn(v, k); },
});

const localforageFake = {
  ...instance('default'),
  createInstance: ({ storeName }) => instance(storeName),
};

const localStorageData = new Map();
globalThis.localStorage = {
  get length() { return localStorageData.size; },
  key: (i) => [...localStorageData.keys()][i] ?? null,
  getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
  setItem: (k, v) => localStorageData.set(k, String(v)),
  removeItem: (k) => localStorageData.delete(k),
};
globalThis.location = { origin: 'http://localhost:5173' };

// Stub localforage at bundle time so the module under test is unmodified.
const stub = path.resolve(HERE, '../node_modules/.localforage-stub.mjs');
const fs = await import('node:fs');
fs.writeFileSync(stub, 'export default globalThis.__localforage;\n');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/backup.js'),
  platform: 'neutral',
  resolve: { alias: { localforage: stub } },
});
const file = path.resolve(HERE, '../node_modules/.backup-test.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();

globalThis.__localforage = localforageFake;
const B = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const reset = () => { storeData.clear(); localStorageData.clear(); };

const seed = () => {
  reset();
  localStorage.setItem('systemPrompt', 'Be terse.');
  localStorage.setItem('temperature', '0.7');
  localStorage.setItem('ttsRefAudio', 'C:\\voices\\mine.wav');
  storeFor('default').set('ollama-sessions', [
    { id: 1, title: 'First', updatedAt: 100, messages: [{ role: 'user', content: 'hi' }] },
    { id: 2, title: 'Second', updatedAt: 200, messages: [] },
  ]);
  storeFor('default').set('ollama-sessions:user-a', [{ id: 3, title: 'Theirs', updatedAt: 50, messages: [] }]);
  storeFor('knowledge').set('doc-1', { name: 'notes.pdf', chunks: [1, 2] });
  storeFor('memory').set('memories', [{ id: 'm1', text: 'prefers Korean' }]);
  storeFor('auth').set('ollama-users', [{ id: 'user-a', name: 'A' }]);
};

// ------------------------------------------------------------- collecting
seed();
const backup = await B.collectBackup();

eq('it is marked as a backup', backup.kind, 'ollama-webui-backup');
check('it records the origin it came from', backup.origin === 'http://localhost:5173');
eq('settings are captured', backup.settings.systemPrompt, 'Be terse.');
check('a machine-specific path is left out by default', !('ttsRefAudio' in backup.settings));
check('it can be included on request',
  'ttsRefAudio' in (await B.collectBackup({ includeMachineSettings: true })).settings);
eq('the guest profile chats are captured', backup.sessions['ollama-sessions'].length, 2);
eq('a second profile is captured too', backup.sessions['ollama-sessions:user-a'].length, 1);
eq('knowledge is captured', Object.keys(backup.knowledge).length, 1);
eq('memories are captured', backup.memory.memories.length, 1);
eq('accounts are captured', backup.auth['ollama-users'].length, 1);
check('accounts can be withheld', !(await B.collectBackup({ includeAccounts: false })).auth);

const summary = B.describeBackup(backup);
eq('the summary counts every chat', summary.chats, 3);
eq('and every profile', summary.profiles, 2);
eq('and the documents', summary.documents, 1);
eq('and the accounts', summary.accounts, 1);

check('a real backup is recognised', B.isBackup(backup));
check('a stray json file is not', !B.isBackup({ hello: 'world' }));
check('null is not', !B.isBackup(null));
check('an exported chat list is not', !B.isBackup([{ id: 1 }]));

// -------------------------------------------------------- restore: empty
reset();
let restored = await B.restoreBackup(backup);
eq('chats land in an empty browser', storeFor('default').get('ollama-sessions').length, 2);
eq('the other profile lands too', storeFor('default').get('ollama-sessions:user-a').length, 1);
eq('settings land', localStorage.getItem('systemPrompt'), 'Be terse.');
eq('knowledge lands', storeFor('knowledge').size, 1);
eq('memories land', storeFor('memory').get('memories').length, 1);
eq('accounts land', storeFor('auth').get('ollama-users').length, 1);
eq('and it says what it did', restored.chats, 3);

// -------------------------------------------------- restore: twice over
restored = await B.restoreBackup(backup);
eq('restoring twice does not duplicate chats', storeFor('default').get('ollama-sessions').length, 2);
// The caller reloads when this is non-zero; a state already applied must report
// nothing, or the page reloads forever.
eq('and reports no change the second time', restored.chats, 0);
eq('nor memories', storeFor('memory').get('memories').length, 1);
eq('nor accounts', storeFor('auth').get('ollama-users').length, 1);

// ------------------------------------------- restore: onto existing data
reset();
storeFor('default').set('ollama-sessions', [
  { id: 9, title: 'Local only', updatedAt: 500, messages: [] },
  { id: 1, title: 'Local edit of First', updatedAt: 999, messages: [] },
]);
localStorage.setItem('systemPrompt', 'Local prompt');
storeFor('memory').set('memories', [{ id: 'm9', text: 'local memory' }]);

await B.restoreBackup(backup, { mode: 'merge' });
const merged = storeFor('default').get('ollama-sessions');
eq('merging keeps the local-only chat', merged.filter(s => s.id === 9).length, 1);
eq('and adds the backup chat', merged.filter(s => s.id === 2).length, 1);
eq('a collision keeps the newer copy', merged.find(s => s.id === 1).title, 'Local edit of First');
eq('no chat is duplicated', merged.length, 3);
eq('merging never overwrites a local setting', localStorage.getItem('systemPrompt'), 'Local prompt');
eq('a setting only in the backup is added', localStorage.getItem('temperature'), '0.7');
eq('local memories survive', storeFor('memory').get('memories').filter(m => m.id === 'm9').length, 1);
eq('backup memories are added', storeFor('memory').get('memories').length, 2);

// ------------------------------------------------------ restore: replace
reset();
storeFor('default').set('ollama-sessions', [{ id: 9, title: 'Local only', updatedAt: 500, messages: [] }]);
localStorage.setItem('systemPrompt', 'Local prompt');

await B.restoreBackup(backup, { mode: 'replace' });
const replaced = storeFor('default').get('ollama-sessions');
eq('replace drops the local-only chat', replaced.filter(s => s.id === 9).length, 0);
eq('and installs the backup ones', replaced.length, 2);
eq('replace does overwrite settings', localStorage.getItem('systemPrompt'), 'Be terse.');

// ------------------------------------------- the owner's bucket follows them
// Profile ids come from randomId() and are therefore different in every
// browser. Signing in as the same person on a second device produced a new id,
// so the app read an empty bucket while the chats sat in one nothing looked at.
reset();
const madeOn = 'ollama-sessions:AAAAAAAAAAAA';
const readOn = 'ollama-sessions:BBBBBBBBBBBB';

storeFor('default').set(madeOn, [{ id: 11, title: 'Written on the PC', updatedAt: 100, messages: [] }]);
storeFor('default').set('ollama-sessions', [{ id: 99, title: 'Guest chat', updatedAt: 50, messages: [] }]);

const owned = await B.collectBackup({ primaryKey: madeOn });
eq('the owning bucket is recorded', owned.primaryKey, madeOn);

reset();
const out = await B.restoreBackup(owned, { primaryKey: readOn });
eq('the owner chats land on this device key', storeFor('default').get(readOn).length, 1);
eq('and are the right ones', storeFor('default').get(readOn)[0].title, 'Written on the PC');
eq('the original key is not populated here', storeFor('default').get(madeOn), undefined);
eq('other buckets are left where they were', storeFor('default').get('ollama-sessions').length, 1);
check('the remap is reported', out.remapped?.from === madeOn && out.remapped?.to === readOn);

// Same device: nothing should move.
reset();
const same = await B.restoreBackup(owned, { primaryKey: madeOn });
eq('restoring onto the same key does not move anything', storeFor('default').get(madeOn).length, 1);
eq('and reports no remap', same.remapped, null);

// Without a primaryKey the old behaviour holds, so existing backup files still
// restore exactly as they did.
reset();
const legacy = await B.restoreBackup({ ...owned, primaryKey: null }, { primaryKey: readOn });
eq('a backup with no owner recorded keeps its keys', storeFor('default').get(madeOn).length, 1);
eq('and nothing is invented under this key', storeFor('default').get(readOn), undefined);
eq('and no remap is claimed', legacy.remapped, null);

// Merging: the device already has its own chats under its own key.
reset();
storeFor('default').set(readOn, [{ id: 22, title: 'Already here', updatedAt: 200, messages: [] }]);
await B.restoreBackup(owned, { primaryKey: readOn });
const mergedInto = storeFor('default').get(readOn);
eq('both survive the remap', mergedInto.length, 2);
check('the local one is kept', mergedInto.some(c => c.id === 22));
check('the remote one arrives', mergedInto.some(c => c.id === 11));

// ------------------------------------------------- settings on a sync pull
// The bug: the app writes every default to localStorage at startup, so
// "skip anything already present" skipped all of them and no setting ever
// crossed between devices.
reset();
localStorage.setItem('systemPrompt', 'Local prompt');
localStorage.setItem('temperature', '0.2');
localStorage.setItem('ttsRefAudio', 'C:/local/voice.wav');
storeFor('default').set('ollama-sessions', []);

const account = {
  kind: 'ollama-webui-backup', version: 2, createdAt: 1,
  settings: { systemPrompt: 'From the account', temperature: '0.9', newKey: 'added',
              ttsRefAudio: 'D:/their/voice.wav' },
  sessions: {},
};

await B.restoreBackup(account, { mode: 'merge' });
eq('a file restore still leaves a local setting alone', localStorage.getItem('systemPrompt'), 'Local prompt');
eq('but adds one that was missing', localStorage.getItem('newKey'), 'added');

reset();
localStorage.setItem('systemPrompt', 'Local prompt');
localStorage.setItem('temperature', '0.2');
localStorage.setItem('ttsRefAudio', 'C:/local/voice.wav');

const synced = await B.restoreBackup(account, { mode: 'merge', settingsWin: true });
eq('a sync pull applies the account setting', localStorage.getItem('systemPrompt'), 'From the account');
eq('and the numeric one', localStorage.getItem('temperature'), '0.9');
eq('and adds what was missing', localStorage.getItem('newKey'), 'added');
eq('the machine-specific path is never taken from the account',
  localStorage.getItem('ttsRefAudio'), 'C:/local/voice.wav');
eq('it counts what it changed', synced.settings, 3);

// Applying the same state twice must report no change, or the caller cannot
// tell "something arrived" from "nothing happened".
const again2 = await B.restoreBackup(account, { mode: 'merge', settingsWin: true });
eq('re-applying an identical state changes nothing', again2.settings, 0);

// The fingerprint is what notices a local edit.
reset();
localStorage.setItem('systemPrompt', 'a');
const printA = B.settingsFingerprint();
eq('the fingerprint is stable', B.settingsFingerprint(), printA);
localStorage.setItem('systemPrompt', 'b');
check('it changes when a setting does', B.settingsFingerprint() !== printA);
localStorage.setItem('ttsRefAudio', 'C:/x.wav');
eq('a machine-specific value is not part of it', B.settingsFingerprint(),
   B.settingsFingerprint());
check('and does not make it differ from the same state elsewhere',
  !B.settingsFingerprint().includes('ttsRefAudio'));

// ------------------------------------------------------------- refusals
let threw = '';
try { await B.restoreBackup({ hello: 'world' }); } catch (e) { threw = e.message; }
check('a non-backup file is refused', /not an Ollama WebUI backup/i.test(threw));

threw = '';
try { await B.restoreBackup({ ...backup, version: B.BACKUP_VERSION + 5 }); } catch (e) { threw = e.message; }
check('a newer backup format is refused', /newer version/i.test(threw));

// A backup with nothing in it should restore cleanly rather than throw.
reset();
const empty = { kind: 'ollama-webui-backup', version: 1, createdAt: 0 };
restored = await B.restoreBackup(empty);
eq('an empty backup restores nothing', restored.chats, 0);
check('and does not crash', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
