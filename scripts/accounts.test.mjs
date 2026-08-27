// Server-side accounts and the per-account state store.
//
// This is the code that holds passwords and one person's whole history, so the
// cases that matter are the ones where getting it wrong leaks something:
// enumerating accounts, reading someone else's state, storing a password.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Point the modules at a scratch directory before importing them: DATA_DIR is
// resolved at module load, so the real server/data must not be touched.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-accounts-'));
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const serverDir = path.resolve(HERE, '../server');

// The modules write to <server>/data; redirect by loading copies from a temp
// directory that sits next to a `data` folder we own.
const stage = path.join(scratch, 'server');
fs.mkdirSync(stage, { recursive: true });
for (const file of ['accounts.js', 'state.js']) {
  fs.copyFileSync(path.join(serverDir, file), path.join(stage, file));
}

const A = await import(pathToFileURL(path.join(stage, 'accounts.js')).href);
const S = await import(pathToFileURL(path.join(stage, 'state.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- register
const alice = await A.registerUser({ name: 'Alice', email: ' Alice@Example.COM ', password: 'correct-horse' });
eq('the account is created', alice.name, 'Alice');
eq('the email is normalised', alice.email, 'alice@example.com');
check('an id is assigned', typeof alice.id === 'string' && alice.id.length > 10);
check('the public shape has no hash', !('hash' in alice) && !('salt' in alice));

let threw = '';
try { await A.registerUser({ name: 'A', email: 'ALICE@example.com', password: 'another-one' }); }
catch (e) { threw = e.message; }
check('a duplicate email is refused, case-insensitively', /already exists/i.test(threw));

threw = '';
try { await A.registerUser({ name: 'B', email: 'b@example.com', password: 'short' }); }
catch (e) { threw = e.message; }
check('a short password is refused', /8 characters/i.test(threw));

threw = '';
try { await A.registerUser({ name: 'B', email: 'not-an-email', password: 'long-enough' }); }
catch (e) { threw = e.message; }
check('a malformed email is refused', /valid email/i.test(threw));

threw = '';
try { await A.registerUser({ name: '   ', email: 'c@example.com', password: 'long-enough' }); }
catch (e) { threw = e.message; }
check('an empty name is refused', /name is required/i.test(threw));

// ------------------------------------------------------------------ login
check('the right password verifies', !!(await A.verifyPassword('alice@example.com', 'correct-horse')));
check('the email is case-insensitive at login', !!(await A.verifyPassword('ALICE@EXAMPLE.COM', 'correct-horse')));
eq('a wrong password does not', await A.verifyPassword('alice@example.com', 'wrong'), null);
eq('an unknown account does not', await A.verifyPassword('nobody@example.com', 'correct-horse'), null);
eq('an empty password does not', await A.verifyPassword('alice@example.com', ''), null);

// The stored file is the thing an attacker would read.
const stored = JSON.parse(fs.readFileSync(path.join(stage, 'data', 'users.json'), 'utf-8'));
check('the password is not stored', !JSON.stringify(stored).includes('correct-horse'));
check('a salt is stored', typeof stored[0].salt === 'string' && stored[0].salt.length > 10);
check('two accounts get different salts',
  (await (async () => {
    await A.registerUser({ name: 'Bob', email: 'bob@example.com', password: 'correct-horse' });
    const all = JSON.parse(fs.readFileSync(path.join(stage, 'data', 'users.json'), 'utf-8'));
    return all[0].salt !== all[1].salt;
  })()));
check('the same password gives different hashes', (() => {
  const all = JSON.parse(fs.readFileSync(path.join(stage, 'data', 'users.json'), 'utf-8'));
  return all[0].hash !== all[1].hash;
})());

// --------------------------------------------------------------- sessions
const token = A.createSession(alice.id);
check('a session token is long enough to matter', token.length >= 32);
eq('the session resolves to its user', A.userForSession(token)?.id, alice.id);
eq('an unknown token resolves to nothing', A.userForSession('nope'), null);
eq('an empty token resolves to nothing', A.userForSession(''), null);
check('two sessions differ', A.createSession(alice.id) !== token);

A.destroySession(token);
eq('a destroyed session stops working', A.userForSession(token), null);

// ------------------------------------------------------------------ state
const bob = (await A.verifyPassword('bob@example.com', 'correct-horse'));

eq('a new account has no state', S.readState(alice.id), null);
eq('and reports as much', S.stateInfo(alice.id).exists, false);

S.writeState(alice.id, { settings: { systemPrompt: 'Be terse.' }, sessions: { 'ollama-sessions': [{ id: 1 }] } });
eq('state round-trips', S.readState(alice.id).settings.systemPrompt, 'Be terse.');
check('it is stamped', typeof S.readState(alice.id).savedAt === 'number');
check('the info reports a size', S.stateInfo(alice.id).bytes > 0);

S.writeState(bob.id, { settings: { systemPrompt: "Bob's" } });
eq('one account cannot see another', S.readState(alice.id).settings.systemPrompt, 'Be terse.');
eq('and the other keeps its own', S.readState(bob.id).settings.systemPrompt, "Bob's");

// A user id arrives from a request, so it must never reach a path unchecked.
for (const bad of ['../../etc/passwd', 'a/../../x', '', null, 'not-a-uuid', '../users']) {
  // readState swallows and returns null; writeState is the dangerous one.
  let writeRefused = false;
  try { S.writeState(bad, { x: 1 }); } catch (e) { writeRefused = true; }
  check(`a path-shaped id is refused: ${JSON.stringify(bad)}`, writeRefused);
}

threw = '';
try {
  // A blob past the cap must be refused rather than filling the disk.
  S.writeState(alice.id, { blob: 'x'.repeat(S.MAX_STATE_BYTES + 1024) });
} catch (e) { threw = e.message; }
check('an oversized blob is refused', /limit/i.test(threw));
eq('and the old state survives', S.readState(alice.id).settings.systemPrompt, 'Be terse.');

// ----------------------------------------------------------------- update
const renamed = await A.updateUser(alice.id, { name: 'Alice B' });
eq('the name can change', renamed.name, 'Alice B');
await A.updateUser(alice.id, { password: 'a-new-long-password' });
check('the new password works', !!(await A.verifyPassword('alice@example.com', 'a-new-long-password')));
eq('the old one stops working', await A.verifyPassword('alice@example.com', 'correct-horse'), null);

threw = '';
try { await A.updateUser('no-such-id', { name: 'x' }); } catch (e) { threw = e.message; }
check('updating a missing account is refused', /no such account/i.test(threw));

// ------------------------------------------------- social identities
// This is where account takeover would hide: adopting an existing account on
// the strength of an email address the provider never verified.

const google = (over = {}) => ({
  provider: 'google', providerId: 'g-1', email: 'social@example.com',
  emailVerified: true, name: 'Social User', avatar: null, ...over,
});

const first = A.findOrCreateSocialUser(google());
eq('a social sign-in creates an account', first.email, 'social@example.com');
eq('and records the provider', first.provider, 'google');
check('with no password material', !('hash' in first) && !('salt' in first));

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

for (const bad of [null, {}, { provider: 'google' }, { providerId: 'x' }]) {
  let refused = false;
  try { A.findOrCreateSocialUser(bad); } catch (e) { refused = true; }
  check(`an identity with no provider pair is refused: ${JSON.stringify(bad)}`, refused);
}

// A social account can hold state like any other.
S.writeState(first.id, { settings: { systemPrompt: 'From the phone' } });
eq('a social account carries state', S.readState(first.id).settings.systemPrompt, 'From the phone');
eq('and it is its own', S.readState(other.id), null);

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
