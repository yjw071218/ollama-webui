// Data separation between profiles.
//
// The failure this covers was real: sync gathered every profile's chats on the
// machine and restored all of them elsewhere, so signing in published the
// guest's history and pulled other people's onto the next device. For anything
// more than one person on one PC, that is the difference between a toy and
// something usable.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const storeData = new Map();
const storeFor = (name) => {
  if (!storeData.has(name)) storeData.set(name, new Map());
  return storeData.get(name);
};
const instance = (name) => ({
  async getItem(k) { const v = storeFor(name).get(k); return v === undefined ? null : v; },
  async setItem(k, v) { storeFor(name).set(k, v); return v; },
  async removeItem(k) { storeFor(name).delete(k); },
  async iterate(fn) { for (const [k, v] of storeFor(name)) fn(v, k); },
});

const localStorageData = new Map();
globalThis.localStorage = {
  get length() { return localStorageData.size; },
  key: (i) => [...localStorageData.keys()][i] ?? null,
  getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
  setItem: (k, v) => localStorageData.set(k, String(v)),
  removeItem: (k) => localStorageData.delete(k),
};
globalThis.location = { origin: 'http://localhost:5173' };

const stub = path.resolve(HERE, '../node_modules/.localforage-iso-stub.mjs');
fs.writeFileSync(stub, 'export default globalThis.__localforage;\n');

const load = async (entry, out) => {
  const bundle = await rolldown({
    input: path.resolve(HERE, entry),
    platform: 'neutral',
    resolve: { alias: { localforage: stub } },
  });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

globalThis.__localforage = { ...instance('default'), createInstance: ({ storeName }) => instance(storeName) };
const B = await load('../src/backup.js', '../node_modules/.iso-backup.mjs');
const S = await load('../src/settingsStore.js', '../node_modules/.iso-settings.mjs');
const P = await load('../src/profileScope.js', '../node_modules/.iso-scope.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const reset = () => { storeData.clear(); localStorageData.clear(); };

// A machine with a guest, an account, and somebody else's profile on it.
const populate = () => {
  reset();
  storeFor('default').set('ollama-sessions', [{ id: 1, title: 'Guest chat', updatedAt: 10, messages: [] }]);
  storeFor('default').set('ollama-sessions:srv-alice', [{ id: 2, title: 'Alice chat', updatedAt: 20, messages: [] }]);
  storeFor('default').set('ollama-sessions:bob-local', [{ id: 3, title: 'Bob chat', updatedAt: 30, messages: [] }]);

  storeFor('knowledge').set('knowledge:guest', [{ id: 'g' }]);
  storeFor('knowledge').set('knowledge:srv-alice', [{ id: 'a' }]);
  storeFor('knowledge').set('knowledge:bob-local', [{ id: 'b' }]);

  storeFor('memory').set('memory:guest', [{ id: 'mg' }]);
  storeFor('memory').set('memory:srv-alice', [{ id: 'ma' }]);
  storeFor('memory').set('memory:bob-local', [{ id: 'mb' }]);

  localStorage.setItem('chatFolders', '["guest folder"]');
  localStorage.setItem('chatFolders:srv-alice', '["alice folder"]');
  localStorage.setItem('chatFolders:bob-local', '["bob folder"]');
  localStorage.setItem('samplingPresets:srv-alice', '["alice preset"]');
  localStorage.setItem('samplingPresets:bob-local', '["bob preset"]');
  localStorage.setItem('systemPrompt', 'shared setting');
};

// ------------------------------------------------- a scoped payload is one person's
populate();
const alice = await B.collectBackup({ scope: 'srv-alice', includeAccounts: false });

eq('only the account chats are gathered', Object.keys(alice.sessions).length, 1);
check('and they are the right ones', !!alice.sessions['ollama-sessions:srv-alice']);
check('the guest chats are not published', !alice.sessions['ollama-sessions']);
check("another profile's chats are not published", !alice.sessions['ollama-sessions:bob-local']);

eq('only the account documents', Object.keys(alice.knowledge).join(), 'knowledge:srv-alice');
eq('only the account memories', Object.keys(alice.memory).join(), 'memory:srv-alice');

check('the account folders travel', 'chatFolders:srv-alice' in alice.settings);
check("the guest's folders do not", !('chatFolders' in alice.settings));
check("another profile's folders do not", !('chatFolders:bob-local' in alice.settings));
check("another profile's presets do not", !('samplingPresets:bob-local' in alice.settings));

// The guest is a profile too and must be equally contained.
const guest = await B.collectBackup({ scope: '', includeAccounts: false });
check('a guest payload takes the guest chats', !!guest.sessions['ollama-sessions']);
check('and not the account chats', !guest.sessions['ollama-sessions:srv-alice']);
eq('and only the guest documents', Object.keys(guest.knowledge).join(), 'knowledge:guest');

// A file backup with no scope is still the whole browser, which is the point of one.
const whole = await B.collectBackup({ includeAccounts: false });
eq('an unscoped backup keeps every profile', Object.keys(whole.sessions).length, 3);

// -------------------------------------- restoring a scoped payload leaves others alone
populate();
await B.restoreBackup(alice, { mode: 'merge', primaryKey: 'ollama-sessions:srv-alice' });
eq('the guest chats are untouched', storeFor('default').get('ollama-sessions').length, 1);
eq('and still the guest ones', storeFor('default').get('ollama-sessions')[0].title, 'Guest chat');
eq("another profile's chats are untouched", storeFor('default').get('ollama-sessions:bob-local')[0].title, 'Bob chat');
eq("another profile's documents survive", storeFor('knowledge').get('knowledge:bob-local').length, 1);

// ------------------------------------------------------------- settings per profile
// Settings used to share bare keys across every profile, so two tabs with two
// accounts overwrote each other continuously. They carry the scope now.
reset();

check('a setting is scoped', S.isScopedSetting('systemPrompt'));
check('the chat store is not', !S.isScopedSetting('ollama-sessions'));
check('the account list is not', !S.isScopedSetting('ollama-users'));
check("another profile's folders are not", !S.isScopedSetting('chatFolders:srv-alice'));
check('a machine-local path is not', !S.isScopedSetting('ttsRefAudio'));

eq('the guest keeps the bare key', S.scopedKey('systemPrompt', ''), 'systemPrompt');
eq('an account gets its own', S.scopedKey('systemPrompt', 'srv-alice'), 'systemPrompt@srv-alice');
eq('a machine-local key is never scoped', S.scopedKey('ttsRefAudio', 'srv-alice'), 'ttsRefAudio');

// Two profiles writing the same setting must not meet.
S.setActiveScope('');
S.setSetting('systemPrompt', 'guest prompt');
S.setActiveScope('srv-alice');
S.setSetting('systemPrompt', 'alice prompt');

eq('alice reads her own', S.getSetting('systemPrompt'), 'alice prompt');
S.setActiveScope('');
eq('the guest still reads theirs', S.getSetting('systemPrompt'), 'guest prompt');
// Inheritance happens once, at first activation, and never again. As a
// read-time fallback it meant every profile that had not overridden a setting
// kept reading the guest's — so changing something as the guest changed it
// everywhere, which is exactly what was reported.
S.setActiveScope('');
S.setActiveScope('srv-bob');
eq('a new profile inherits the setup that was on screen', S.getSetting('systemPrompt'), 'guest prompt');
check('and is marked as seeded', S.isSeeded('srv-bob'));

// The guest now changes their mind. Bob must not follow.
S.setActiveScope('');
S.setSetting('systemPrompt', 'guest changed this later');
eq('the guest sees their own change', S.getSetting('systemPrompt'), 'guest changed this later');
S.setActiveScope('srv-bob');
eq('a seeded profile does not follow the guest', S.getSetting('systemPrompt'), 'guest prompt');

// A setting the guest changes that bob never had is still not inherited.
S.setActiveScope('');
S.setSetting('chatFontSize', '20');
S.setActiveScope('srv-bob');
eq('nor does it pick up a setting added later', S.getSetting('chatFontSize'), null);

S.setSetting('systemPrompt', 'bob prompt');
S.setActiveScope('srv-alice');
eq("and once it writes, alice is unaffected", S.getSetting('systemPrompt'), 'alice prompt');
eq('re-seeding an already seeded profile does nothing', S.seedScope('srv-bob', ''), 0);

// Seeding must fill in around what a profile already has, not write over it:
// those values may have just been restored from the account.
S.writeScopeSettings('srv-dave', { systemPrompt: 'from the account', theme: 'dark' });
S.setActiveScope('');
S.setActiveScope('srv-dave');
eq('a synced value survives seeding', S.getSetting('systemPrompt'), 'from the account');
eq('and its own settings too', S.getSetting('theme'), 'dark');
S.setActiveScope('');

const aliceSettings = S.readScopeSettings('srv-alice');
eq('a scope reads back its own settings', aliceSettings.systemPrompt, 'alice prompt');
check("and not another's", !Object.values(aliceSettings).includes('bob prompt'));

const guestSettings = S.readScopeSettings('');
eq('the guest reads back the bare keys', guestSettings.systemPrompt, 'guest changed this later');
check('and not a scoped one', !Object.values(guestSettings).includes('alice prompt'));

eq('writing a scope reports what changed', S.writeScopeSettings('srv-carol', { systemPrompt: 'carol' }), 1);
eq('and writing the same twice reports nothing', S.writeScopeSettings('srv-carol', { systemPrompt: 'carol' }), 0);
S.setActiveScope('srv-carol');
eq('carol reads what was written for her', S.getSetting('systemPrompt'), 'carol');
S.setActiveScope('');

// ------------------------------------------------ which profile is in view
// The bug this pins down: signing out left the server session attached, so the
// scope still named the account. The guest was then reading, writing and
// DELETING the account's chats, and the sync uploaded those deletions -- so
// signing back in showed nothing.
const acct = { id: 'abc-123' };
const localUser = { id: 'local-9' };

eq('an account wins', P.deriveScope(acct, localUser), 'srv-abc-123');
eq('the local profile is next', P.deriveScope(null, localUser), 'local-9');
eq('neither is the guest', P.deriveScope(null, null), '');
eq('an account with no id is not an account', P.deriveScope({}, localUser), 'local-9');

const signedIn = P.deriveScope(acct, localUser);
const afterSignOut = P.deriveScope(null, null);
check('signing out leaves the account scope', P.scopeChanged(signedIn, afterSignOut));
eq('and lands on the guest', afterSignOut, '');

// The regression itself: keeping the session is what produced the data loss.
eq('a kept session would still name the account', P.deriveScope(acct, null), 'srv-abc-123');
check('which is exactly what must not survive a sign-out',
  P.deriveScope(acct, null) !== afterSignOut);

check('the guest may never keep a server session', !P.mayKeepServerSession(acct, null));
check('nor may a sign-out with no account', !P.mayKeepServerSession(null, null));

// The stores really are separate buckets, so the two can never overlap.
reset();
storeFor('default').set('ollama-sessions', [{ id: 1, title: 'Guest', updatedAt: 1, messages: [] }]);
storeFor('default').set('ollama-sessions:srv-abc-123', [{ id: 2, title: 'Account', updatedAt: 2, messages: [] }]);

const guestPayload = await B.collectBackup({ scope: afterSignOut, includeAccounts: false });
const acctPayload = await B.collectBackup({ scope: signedIn, includeAccounts: false });
eq('the guest payload holds only guest chats',
  Object.keys(guestPayload.sessions).join(), 'ollama-sessions');
eq('the account payload holds only account chats',
  Object.keys(acctPayload.sessions).join(), 'ollama-sessions:srv-abc-123');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
