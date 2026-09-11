// Data separation between accounts.
//
// The failures this covers were real, and there were two of them.
//
// Sync gathered every profile's chats on the machine and restored all of them
// elsewhere, so signing in published the guest's history and pulled other
// people's onto the next device.
//
// And the scope — the thing every store keys off — was derived from two
// sources: a browser-local profile and a server account, whichever was present.
// During boot the local one was available instantly and the server's took a
// round trip, so the same browser produced two different answers seconds apart
// and wrote into both. There is one source now, and a third state — 'we have
// not asked yet' — that is represented rather than guessed at.
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
const alice = await B.collectBackup({ scope: 'srv-alice' });

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
const guest = await B.collectBackup({ scope: '' });
check('a guest payload takes the guest chats', !!guest.sessions['ollama-sessions']);
check('and not the account chats', !guest.sessions['ollama-sessions:srv-alice']);
eq('and only the guest documents', Object.keys(guest.knowledge).join(), 'knowledge:guest');

// A file backup with no scope is still the whole browser, which is the point of one.
const whole = await B.collectBackup({});
eq('an unscoped backup keeps every profile', Object.keys(whole.sessions).length, 3);

// -------------------------------------- restoring a scoped payload leaves others alone
populate();
await B.restoreBackup(alice, { mode: 'merge', primaryKey: 'ollama-sessions:srv-alice' });
eq('the account bucket keeps its own chats',
  storeFor('default').get('ollama-sessions:srv-alice')[0].title, 'Alice chat');
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
check('the old account list is not', !S.isScopedSetting('ollama-users'));
// These carry their own scope suffix. Without excluding them, a key like
// `legacyImportOffered@srv-x` reads back as a setting named
// `legacyImportOffered` belonging to srv-x, and then syncs to every device.
check('the import bookkeeping is not', !S.isScopedSetting('legacyImportOffered'));
check('nor the record of what was imported', !S.isScopedSetting('legacyImportedFrom'));
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
// A new account inherits nothing from whoever was on screen a moment ago.
// Seeding one scope from another made an account's setup depend on which
// machine first signed into it -- the same leak between identities as the rest
// of this, wearing a friendlier hat.
S.setActiveScope('');
S.setActiveScope('srv-bob');
eq('a new account starts from defaults, not from the guest', S.getSetting('systemPrompt'), null);

// The guest now changes their mind. Bob must not follow.
S.setActiveScope('');
S.setSetting('systemPrompt', 'guest changed this later');
eq('the guest sees their own change', S.getSetting('systemPrompt'), 'guest changed this later');
S.setActiveScope('srv-bob');
eq('and an account does not follow the guest', S.getSetting('systemPrompt'), null);

S.setActiveScope('');
S.setSetting('chatFontSize', '20');
S.setActiveScope('srv-bob');
eq('nor picks up a setting added later', S.getSetting('chatFontSize'), null);

S.setSetting('systemPrompt', 'bob prompt');
S.setActiveScope('srv-alice');
eq('and once it writes, alice is unaffected', S.getSetting('systemPrompt'), 'alice prompt');

// What a device restored from the account is the account's own, and activating
// the scope must not disturb it.
S.writeScopeSettings('srv-dave', { systemPrompt: 'from the account', theme: 'dark' });
S.setActiveScope('');
S.setActiveScope('srv-dave');
eq('a synced value survives activation', S.getSetting('systemPrompt'), 'from the account');
eq('and its own settings too', S.getSetting('theme'), 'dark');

// Signing out on a shared computer should not leave the account's settings in
// localStorage for the next person to read.
eq('leaving clears the account cache', S.clearScopeSettings('srv-dave'), 2);
S.setActiveScope('srv-dave');
eq('so nothing of it is left', S.getSetting('systemPrompt'), null);
S.setActiveScope('');
eq('and the guest is untouched', S.getSetting('systemPrompt'), 'guest changed this later');
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

// ------------------------------------------------ whose data is in view
// The bug this pins down: the scope was derived from two disagreeing sources,
// so a signed-in person could be pointed at the guest's storage -- reading it,
// writing to it, deleting from it -- and the sync then uploaded the result.
const acct = { id: 'abc-123' };

eq('an account names its own scope', P.deriveScope(acct), 'srv-abc-123');
eq('signed out is the guest', P.deriveScope(null), '');
eq('an account with no id is not an account', P.deriveScope({}), '');

// The third state, and the reason this file exists. Before the session has been
// resolved the answer is not 'guest' -- it is 'not known yet', and treating the
// two as the same is exactly what pointed one person's writes at another's
// storage for the first few hundred milliseconds of every load.
eq('an unresolved session has no scope at all', P.deriveScope(acct, 'loading'), P.SCOPE_UNKNOWN);
eq('and that is not the guest', P.deriveScope(acct, 'loading') === '', false);
check('nothing may be read or written against it', !P.isResolved(P.deriveScope(acct, 'loading')));
check('while a resolved scope may be', P.isResolved(P.deriveScope(acct)));
check('including the guest, which is a real answer', P.isResolved(P.deriveScope(null)));

const signedIn = P.deriveScope(acct);
const afterSignOut = P.deriveScope(null);
check('signing out changes the scope', P.scopeChanged(signedIn, afterSignOut));
eq('and lands on the guest', afterSignOut, '');

// The stamp on a payload is derived from the scope rather than tracked beside
// it, so the two cannot drift apart -- and drift is what filed one account's
// chats under another's name.
eq('an account scope names its owner', P.ownerOfScope('srv-abc-123'), 'abc-123');
eq('the guest owns nothing syncable', P.ownerOfScope(''), null);
eq('nor does an unresolved scope', P.ownerOfScope(P.SCOPE_UNKNOWN), null);

// The client-side half of the server's owner check. A payload for a different
// account is discarded, never merged: by the time it is here, merging can only
// put one person's chats into another person's list.
check('an account may apply its own state', P.mayApplyState('srv-abc-123', 'abc-123'));
check('but not another account\'s', !P.mayApplyState('srv-abc-123', 'def-456'));
check('the guest may apply nothing', !P.mayApplyState('', 'abc-123'));
check('and an unresolved scope may apply nothing',
  !P.mayApplyState(P.SCOPE_UNKNOWN, 'abc-123'));
// An older client cannot send a stamp; only a stamp naming somebody else lies.
check('an unstamped payload is accepted', P.mayApplyState('srv-abc-123', null));

// The stores really are separate buckets, so the two can never overlap.
reset();
storeFor('default').set('ollama-sessions', [{ id: 1, title: 'Guest', updatedAt: 1, messages: [] }]);
storeFor('default').set('ollama-sessions:srv-abc-123', [{ id: 2, title: 'Account', updatedAt: 2, messages: [] }]);

const guestPayload = await B.collectBackup({ scope: afterSignOut });
const acctPayload = await B.collectBackup({ scope: signedIn });
eq('the guest payload holds only guest chats',
  Object.keys(guestPayload.sessions).join(), 'ollama-sessions');
eq('the account payload holds only account chats',
  Object.keys(acctPayload.sessions).join(), 'ollama-sessions:srv-abc-123');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
