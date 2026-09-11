// Accounts, sessions and the record store, against the real database.
//
// This is the code that holds passwords and one person's whole history, so the
// cases that matter are the ones where getting it wrong leaks or loses
// something: enumerating accounts, reading someone else's data, storing a
// password, and — since the storage layer moved to SQLite — the constraints
// that a JSON file could not enforce.
//
// The modules resolve their data directory at load time, from WEBUI_DATA_DIR,
// so a test points them at a scratch one and never goes near real accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A scratch data directory, set before anything imports the database. Renaming
// the real one aside and putting it back — which is what this used to do —
// failed whenever the server was running, and left real accounts stranded in a
// half-renamed backup directory. A test should not be able to reach production
// data at all, so it does not.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-accounts-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase, database } = await import('../server/db.js');

process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const A = await import('../server/accounts.js');
const Sess = await import('../server/session.js');
const R = await import('../server/records.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

let threw = '';
const catching = async (fn) => {
  threw = '';
  try { await fn(); } catch (e) { threw = e.message; }
  return threw;
};

/* ---------------------------------------------------------------- register */

const alice = await A.registerUser({ name: 'Alice', email: ' Alice@Example.COM ', password: 'correct-horse' });
eq('the account is created', alice.name, 'Alice');
eq('the email is normalised', alice.email, 'alice@example.com');
check('an id is assigned', typeof alice.id === 'string' && alice.id.length > 10);
check('the public shape has no hash', !('hash' in alice) && !('salt' in alice));
eq('it reports having a password', alice.hasPassword, true);
eq('and no passkeys yet', alice.passkeys, 0);

await catching(() => A.registerUser({ name: 'A', email: 'ALICE@example.com', password: 'another-one' }));
check('a duplicate email is refused, case-insensitively', /already exists/i.test(threw));

await catching(() => A.registerUser({ name: 'B', email: 'b@example.com', password: 'short' }));
check('a short password is refused', /8 characters/i.test(threw));

await catching(() => A.registerUser({ name: 'B', email: 'not-an-email', password: 'long-enough' }));
check('a malformed email is refused', /valid email/i.test(threw));

await catching(() => A.registerUser({ name: '   ', email: 'c@example.com', password: 'long-enough' }));
check('an empty name is refused', /name is required/i.test(threw));

// The uniqueness is the database's, not a lookup followed by an insert. That
// distinction is the whole reason for the storage change: a check-then-write
// over a shared file is a race, and a race over an email address is two
// accounts claiming one identity.
const races = await Promise.allSettled(
  Array.from({ length: 8 }, () => A.registerUser({
    name: 'Racer', email: 'race@example.com', password: 'a-long-password',
  })),
);
eq('exactly one of eight simultaneous registrations wins',
  races.filter(r => r.status === 'fulfilled').length, 1);
eq('and the account exists once',
  database().prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('race@example.com').n, 1);

/* ------------------------------------------------------------------- login */

check('the right password verifies', !!(await A.verifyPassword('alice@example.com', 'correct-horse')));
check('the email is case-insensitive at login', !!(await A.verifyPassword('ALICE@EXAMPLE.COM', 'correct-horse')));
eq('a wrong password does not', await A.verifyPassword('alice@example.com', 'wrong'), null);
eq('an unknown account does not', await A.verifyPassword('nobody@example.com', 'correct-horse'), null);
eq('an empty password does not', await A.verifyPassword('alice@example.com', ''), null);

// The stored row is the thing an attacker would read.
const stored = database().prepare('SELECT * FROM users WHERE email = ?').get('alice@example.com');
check('the password is not stored', !JSON.stringify(stored).includes('correct-horse'));
check('a salt is stored', typeof stored.salt === 'string' && stored.salt.length > 10);

const bob = await A.registerUser({ name: 'Bob', email: 'bob@example.com', password: 'correct-horse' });
const bobRow = database().prepare('SELECT * FROM users WHERE id = ?').get(bob.id);
check('two accounts get different salts', bobRow.salt !== stored.salt);
check('the same password gives different hashes', bobRow.hash !== stored.hash);

/* ---------------------------------------------------------------- sessions */

const token = Sess.createSession(alice.id);
check('a session token is long enough to matter', token.length >= 32);
eq('the session resolves to its user', Sess.readSession(token)?.userId, alice.id);
eq('an unknown token resolves to nothing', Sess.readSession('nope'), null);
eq('an empty token resolves to nothing', Sess.readSession(''), null);
check('two sessions differ', Sess.createSession(alice.id) !== token);
check('every session carries a CSRF token', (Sess.readSession(token).csrf || '').length >= 32);
check('and two sessions do not share it',
  Sess.readSession(token).csrf !== Sess.readSession(Sess.createSession(alice.id)).csrf);

// The cookie value is never what lands in the table, so a leaked database
// cannot simply be replayed as a login.
const rows = database().prepare('SELECT token_hash FROM sessions').all().map(r => r.token_hash);
check('the token itself is not stored', !rows.includes(token));
check('a hash of it is', rows.some(k => /^[0-9a-f]{64}$/.test(k)));

// Rotation: a browser that arrives holding a session id must not keep it.
const rotated = Sess.rotateSession(token, { userId: alice.id });
check('rotating produces a different id', rotated !== token);
eq('the old id stops resolving', Sess.readSession(token), null);
eq('and the new one names the same account', Sess.readSession(rotated)?.userId, alice.id);

Sess.destroySession(rotated);
eq('a destroyed session stops working', Sess.readSession(rotated), null);

Sess.destroyUserSessions(alice.id);   // clear what the checks above left behind
const laptop = Sess.createSession(alice.id);
const phone = Sess.createSession(alice.id);
eq('both devices resolve', Sess.readSession(laptop)?.userId, Sess.readSession(phone)?.userId);
eq('ending the others keeps this one', Sess.destroyUserSessions(alice.id, { keepToken: laptop }), 1);
check('so the kept one still works', !!Sess.readSession(laptop));
eq('and the other does not', Sess.readSession(phone), null);
eq('the list shows the survivor', Sess.listUserSessions(alice.id, laptop).length, 1);
check('and marks it as the current one', Sess.listUserSessions(alice.id, laptop)[0].current);
Sess.destroyUserSessions(alice.id);
eq('and they can all be ended', Sess.listUserSessions(alice.id).length, 0);

// CSRF: a state-changing request has to prove it came from this app, not merely
// that the browser attached a cookie.
const guarded = Sess.createSession(alice.id);
const live = Sess.readSession(guarded);
const req = (method, headers = {}) => ({ method, headers });
check('a GET needs no token', Sess.csrfOk(req('GET'), live));
check('a POST with the right token passes', Sess.csrfOk(req('POST', { 'x-csrf-token': live.csrf }), live));
check('a POST with no token is refused', !Sess.csrfOk(req('POST'), live));
check('a POST with the wrong token is refused', !Sess.csrfOk(req('POST', { 'x-csrf-token': 'nope' }), live));
check("a POST with another session's token is refused",
  !Sess.csrfOk(req('POST', { 'x-csrf-token': Sess.readSession(Sess.createSession(alice.id)).csrf }), live));
check('a request with no session is exempt, since there is nothing to ride on',
  Sess.csrfOk(req('POST'), null));

// Guessing a password over the network has to get slower.
for (let i = 0; i < 10; i++) Sess.recordFailedLogin('10.0.0.1', 'alice@example.com');
check('repeated failures are throttled', Sess.throttleState('10.0.0.1', 'alice@example.com').blocked);
check('a different account from the same address is not',
  !Sess.throttleState('10.0.0.1', 'bob@example.com').blocked);
check('nor the same account from elsewhere',
  !Sess.throttleState('10.0.0.2', 'alice@example.com').blocked);
Sess.clearFailedLogins('10.0.0.1', 'alice@example.com');
check('a successful sign-in clears it', !Sess.throttleState('10.0.0.1', 'alice@example.com').blocked);

// Secure is set only where the browser would keep it. Hardcoding it means a
// LAN install over plain HTTP loses the cookie and loops forever with no error.
check('a plain HTTP request is not treated as secure', !Sess.isSecureRequest({ socket: {}, headers: {} }));
check('a TLS socket is', Sess.isSecureRequest({ socket: { encrypted: true }, headers: {} }));
check('and so is a proxy that says so',
  Sess.isSecureRequest({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }));

/* ----------------------------------------------------------------- records */

const chat = (id, updatedAt, title) => ({ kind: 'chat', id, updatedAt, payload: { id, title } });

eq('a new account holds nothing', R.currentRev(alice.id), 0);
eq('and reports as much', R.accountStats(alice.id).exists, false);

R.applyChanges(alice.id, { records: [chat('c1', 1000, 'first')] });
eq('a record lands', R.changesSince(alice.id, 0).records.length, 1);
check('and the revision moved', R.currentRev(alice.id) > 0);
eq('the stats name the owner', R.accountStats(alice.id).ownerId, alice.id);
eq('and count the chats', R.accountStats(alice.id).chats, 1);

// One account cannot see another's. This is the property the whole owner check
// exists to preserve.
R.applyChanges(bob.id, { records: [chat('c1', 1000, "bob's own")] });
eq('the same id in two accounts is two records',
  R.changesSince(alice.id, 0).records[0].payload.title, 'first');
eq('and each keeps its own', R.changesSince(bob.id, 0).records[0].payload.title, "bob's own");

let mismatch = '';
try { R.applyChanges(alice.id, { ownerId: bob.id, records: [chat('c9', 1, 'x')] }); }
catch (e) { mismatch = e.name; }
eq("a batch claiming another account is refused", mismatch, 'OwnerMismatch');

// Deltas: the point of the revision counter.
const afterFirst = R.currentRev(alice.id);
R.applyChanges(alice.id, { records: [chat('c2', 2000, 'second')] });
const delta = R.changesSince(alice.id, afterFirst);
eq('a delta carries only what changed', delta.records.length, 1);
eq('and it is the right one', delta.records[0].id, 'c2');
eq('a device that is up to date gets nothing',
  R.changesSince(alice.id, R.currentRev(alice.id)).records.length, 0);

// Last write wins, per record, by the record's own clock.
R.applyChanges(alice.id, { records: [chat('c1', 3000, 'edited later')] });
eq('a newer edit is applied',
  R.changesSince(alice.id, 0).records.find(r => r.id === 'c1').payload.title, 'edited later');

const stale = R.applyChanges(alice.id, { records: [chat('c1', 500, 'stale')] });
eq('an older edit arriving late is rejected', stale.rejected, 1);
eq('and nothing was applied', stale.applied, 0);
eq('so the newer version stands',
  R.changesSince(alice.id, 0).records.find(r => r.id === 'c1').payload.title, 'edited later');

// A rejected-only batch must not inflate the revision, or every device is told
// to re-sync for nothing.
eq('a batch that changed nothing does not move the revision',
  R.currentRev(alice.id), stale.rev);

// Deletions. A blob could not express one; a tombstone is a write and travels.
R.applyChanges(alice.id, { records: [{ kind: 'chat', id: 'c1', updatedAt: 4000, deleted: true }] });
const tomb = R.changesSince(alice.id, 0).records.find(r => r.id === 'c1');
check('a deletion becomes a tombstone', tomb.deleted === true);
eq('carrying no payload', tomb.payload, null);
eq('and the chat count drops', R.accountStats(alice.id).chats, 1);

// A device that still has the chat tries to upload it again, as it would after
// being offline. The tombstone is newer, so the chat stays deleted.
const resurrect = R.applyChanges(alice.id, { records: [chat('c1', 3500, 'back from the dead')] });
eq('an older copy cannot resurrect a deleted record', resurrect.applied, 0);
check('and it is still a tombstone',
  R.changesSince(alice.id, 0).records.find(r => r.id === 'c1').deleted === true);

// A genuinely newer write may bring it back — that is a real edit, not an echo.
R.applyChanges(alice.id, { records: [chat('c1', 5000, 'deliberately restored')] });
eq('a newer write does restore it',
  R.changesSince(alice.id, 0).records.find(r => r.id === 'c1').payload.title, 'deliberately restored');

// Unknown kinds never reach the table.
let refused = '';
try { R.applyChanges(alice.id, { records: [{ kind: 'malware', id: 'x', updatedAt: 1, payload: {} }] }); }
catch (e) { refused = e.message; }
check('an unknown kind is refused', /Unknown record kind/i.test(refused));

// Paging, so a first sync of a large account does not have to arrive at once.
const many = Array.from({ length: 12 }, (_, i) => chat(`p${i}`, 6000 + i, `page ${i}`));
R.applyChanges(alice.id, { records: many });
const firstPage = R.changesSince(alice.id, 0, 5);
eq('a page is capped', firstPage.records.length, 5);
check('and says it is not the whole answer', firstPage.complete === false);
check('the revision reported is the one actually reached',
  firstPage.rev < R.currentRev(alice.id));

/* ------------------------------------------------------------------ update */

const renamed = await A.updateUser(alice.id, { name: 'Alice B' });
eq('the name can change', renamed.name, 'Alice B');

await catching(() => A.changePassword(alice.id, 'not-it', 'a-new-long-password'));
check('changing a password without the old one is refused', /not correct/i.test(threw));

await A.changePassword(alice.id, 'correct-horse', 'a-new-long-password');
check('the new password works', !!(await A.verifyPassword('alice@example.com', 'a-new-long-password')));
eq('the old one stops working', await A.verifyPassword('alice@example.com', 'correct-horse'), null);

await catching(() => A.updateUser('no-such-id', { name: 'x' }));
check('updating a missing account is refused', /no such account/i.test(threw));

await catching(() => A.updateUser(bob.id, { email: 'alice@example.com' }));
check('taking another account\'s address is refused', /already exists/i.test(threw));

/* ------------------------------------------------- social identities */

const google = (over = {}) => ({
  provider: 'google', providerId: 'g-1', email: 'social@example.com',
  emailVerified: true, name: 'Social User', avatar: null, ...over,
});

const first = A.findOrCreateSocialUser(google());
eq('a social sign-in creates an account', first.email, 'social@example.com');
eq('and records the provider', first.provider, 'google');
check('with no password material', !('hash' in first) && !('salt' in first));
eq('and no password', first.hasPassword, false);

const again = A.findOrCreateSocialUser(google({ name: 'Renamed' }));
eq('signing in again is the same account', again.id, first.id);

const other = A.findOrCreateSocialUser(google({ providerId: 'g-2', email: 'other@example.com' }));
check('a different provider id is a different account', other.id !== first.id);

// A password account, then the same address arriving from a provider.
const pw = await A.registerUser({ name: 'Carol', email: 'carol@example.com', password: 'a-long-password' });

const unverified = A.findOrCreateSocialUser(
  google({ providerId: 'g-3', email: 'carol@example.com', emailVerified: false }));
check('an unverified email does NOT adopt an existing account', unverified.id !== pw.id);

const verified = A.findOrCreateSocialUser(
  google({ providerId: 'g-4', email: 'carol@example.com', emailVerified: true }));
eq('a verified email does adopt it', verified.id, pw.id);
check('and the password still works afterwards',
  !!(await A.verifyPassword('carol@example.com', 'a-long-password')));
eq('and the account still reports having one', A.findUser(pw.id).hasPassword, true);

for (const bad of [null, {}, { provider: 'google' }, { providerId: 'x' }]) {
  let bounced = false;
  try { A.findOrCreateSocialUser(bad); } catch (e) { bounced = true; }
  check(`an identity with no provider pair is refused: ${JSON.stringify(bad)}`, bounced);
}

/* --------------------------------------------------------------- deletion */

// Everything an account owns goes with it, by foreign key rather than by
// somebody remembering to clean up.
Sess.createSession(bob.id);
A.deleteAccount(bob.id);
eq('the account is gone', A.findUser(bob.id), null);
eq('its records are gone',
  database().prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').get(bob.id).n, 0);
eq('its sessions are gone',
  database().prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(bob.id).n, 0);
eq("and alice's records were untouched", R.accountStats(alice.id).chats > 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
