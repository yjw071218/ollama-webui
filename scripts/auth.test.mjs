// The login, exercised over real HTTP against the real routes.
//
// Everything this covers is something that was actually wrong, or something
// whose absence made the other things possible:
//
//   * the session cookie is opaque, HttpOnly, and its value is not what the
//     server stores
//   * signing in replaces the session id, so a planted cookie is worthless
//   * a state-changing request without the CSRF token is refused
//   * password guessing gets throttled
//   * a state upload stamped with the wrong owner is refused instead of
//     overwriting somebody else's chats -- the failure the whole rework is for
//   * a passkey is verified by the server, against a key the server stored,
//     with the challenge, origin, RP id and counter all checked
//   * signing out ends the session on the server, not merely in the browser

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A scratch data directory, set before anything imports the database. The
// alternative — renaming the real one aside and putting it back — failed
// whenever the server was running and left real accounts stranded in a
// half-renamed backup. A test should not be able to reach production data at
// all, so it does not.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-auth-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase } = await import('../server/db.js');

process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const { createApiRoutes } = await import('../server/api.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------ server */

const routes = createApiRoutes({ VITE_GOOGLE_CLIENT_ID: 'test-client' });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const match = routes.find(r => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`));
  if (!match) { res.statusCode = 404; res.end('{}'); return; }
  match.handler(req, res);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/* ------------------------------------------------------------- a browser */

/** A cookie jar, because that is what the thing under test actually talks to. */
const makeClient = () => {
  const jar = new Map();
  let csrfToken = null;

  const applySetCookie = (headers) => {
    for (const line of headers['set-cookie'] || []) {
      const [pair, ...attrs] = line.split(';');
      const eqAt = pair.indexOf('=');
      const name = pair.slice(0, eqAt).trim();
      const value = pair.slice(eqAt + 1).trim();
      const maxAge = attrs.map(a => a.trim()).find(a => a.toLowerCase().startsWith('max-age='));
      if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name);
      else jar.set(name, { value, raw: line });
    }
  };

  const request = async (method, routePath, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (jar.size) {
      headers.cookie = [...jar].map(([name, c]) => `${name}=${c.value}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken && !('x-csrf-token' in headers) && method !== 'GET') {
      headers['x-csrf-token'] = csrfToken;
    }

    const res = await fetch(ORIGIN + routePath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const raw = Object.fromEntries(res.headers);
    raw['set-cookie'] = res.headers.getSetCookie?.() || [];
    applySetCookie(raw);

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (json?.csrfToken) csrfToken = json.csrfToken;
    return { status: res.status, body: json, cookies: raw['set-cookie'] };
  };

  return {
    jar,
    get csrf() { return csrfToken; },
    set csrf(value) { csrfToken = value; },
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
    cookie: (name) => jar.get(name)?.value || null,
    rawCookie: (name) => jar.get(name)?.raw || '',
  };
};

/* ------------------------------------------------------- register and session */

const alice = makeClient();

let r = await alice.post('/api/auth/register', {
  name: 'Alice', email: 'alice@example.com', password: 'correct horse battery',
});
eq('registering succeeds', r.status, 200);
check('and returns the account', !!r.body.user?.id);
eq('with no password material on it', r.body.user.hash, undefined);
check('and a CSRF token', !!r.body.csrfToken);

const firstSession = alice.cookie('webui_session');
check('a session cookie is set', !!firstSession);
check('the session cookie is HttpOnly', /HttpOnly/i.test(alice.rawCookie('webui_session')));
check('and SameSite=Lax', /SameSite=Lax/i.test(alice.rawCookie('webui_session')));
check('the CSRF cookie is readable by script', !/HttpOnly/i.test(alice.rawCookie('webui_csrf')));
check('no Secure flag over plain http, or the cookie would be dropped',
  !/Secure/i.test(alice.rawCookie('webui_session')));

// The stored value must not be the cookie value. Reading it out of the database
// rather than trusting the module that wrote it: this is the property that
// makes a stolen copy of the file useless, so it is checked against the bytes.
const { DatabaseSync } = await import('node:sqlite');
const peek = () => {
  const handle = new DatabaseSync(path.join(DATA, 'webui.db'), { readOnly: true });
  const rows = handle.prepare('SELECT token_hash FROM sessions').all().map(r => r.token_hash);
  handle.close();
  return rows;
};

const storedKeys = peek();
check('the session table stores a hash, not the cookie', !storedKeys.includes(firstSession));
eq('and the hash is the one that names it',
  storedKeys.includes(crypto.createHash('sha256').update(firstSession).digest('hex')), true);

r = await alice.get('/api/auth/session');
eq('the session resolves to the account', r.body.user.email, 'alice@example.com');
eq('and reports the owner of its state', r.body.state.ownerId, r.body.user.id);
const aliceId = r.body.user.id;

/* ------------------------------------------------------------ session fixation */

// A browser that arrives already carrying a session id must not keep it.
const beforeLogin = alice.cookie('webui_session');
r = await alice.post('/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
eq('signing in again succeeds', r.status, 200);
check('and the session id is replaced', alice.cookie('webui_session') !== beforeLogin);

check('the old session id no longer resolves',
  !peek().includes(crypto.createHash('sha256').update(beforeLogin).digest('hex')));

/* --------------------------------------------------------------------- CSRF */

r = await alice.post('/api/auth/profile', { name: 'Alice A' }, { 'x-csrf-token': 'not-the-token' });
eq('a wrong CSRF token is refused', r.status, 403);
eq('and says so', r.body.code, 'csrf');

r = await alice.post('/api/auth/profile', { name: 'Alice A' }, { 'x-csrf-token': '' });
eq('a missing CSRF token is refused too', r.status, 403);

r = await alice.post('/api/auth/profile', { name: 'Alice A' });
eq('the real token is accepted', r.status, 200);
eq('and the change lands', r.body.user.name, 'Alice A');

/* ------------------------------------------------------------- state ownership */

const bob = makeClient();
r = await bob.post('/api/auth/register', {
  name: 'Bob', email: 'bob@example.com', password: 'a different long password',
});
const bobId = r.body.user.id;
check('a second account exists', !!bobId && bobId !== aliceId);

const chat = (id, updatedAt, title) => ({
  kind: 'chat', id, updatedAt, payload: { id, title, updatedAt },
});

r = await bob.post('/api/auth/sync', { since: 0, ownerId: bobId, records: [chat('c1', 1000, 'Bob one')] });
eq("bob's own record is stored", r.status, 200);
eq('and is reported as applied', r.body.applied, 1);
check('the account revision moved', r.body.rev > 0);

// The failure the whole rework exists to prevent: a client that has got
// confused about who is signed in offering one person's data under another's
// session. It is refused here rather than believed.
r = await bob.post('/api/auth/sync', { since: 0, ownerId: aliceId, records: [chat('c9', 9000, 'wrong hands')] });
eq("a batch stamped with somebody else's account is refused", r.status, 409);
eq('and names the reason', r.body.code, 'owner-mismatch');

r = await alice.get('/api/auth/sync?since=0');
eq('every read carries the owner', r.body.ownerId, aliceId);
check("and alice's account did not receive it", !r.body.records.some(x => x.id === 'c9'));

r = await bob.get('/api/auth/sync?since=0');
eq('bob still reads his own', r.body.records.length, 1);
eq('with the payload intact', r.body.records[0].payload.title, 'Bob one');

// --- the case a blob could not express: two devices, and a deletion ---

// Bob's phone. It starts from nothing and takes the account's history.
const bobPhone2 = makeClient();
r = await bobPhone2.post('/api/auth/login', { email: 'bob@example.com', password: 'a different long password' });
eq('a second device signs in', r.status, 200);

r = await bobPhone2.get('/api/auth/sync?since=0');
eq('and downloads what the account holds', r.body.records.length, 1);
const phoneRev = r.body.rev;

// The phone writes a chat of its own. Under the old blob, the laptop's next
// upload — made from a copy that has never seen this — would have erased it.
r = await bobPhone2.post('/api/auth/sync', {
  since: phoneRev, ownerId: bobId, records: [chat('c2', 2000, 'From the phone')],
});
eq('the phone adds a chat', r.body.applied, 1);

// The laptop syncs without ever having seen c2, and sends only what it changed.
r = await bob.post('/api/auth/sync', {
  since: 1, ownerId: bobId, records: [chat('c1', 3000, 'Bob one, edited')],
});
eq('the laptop edit is applied', r.body.applied, 1);
check("and the phone's chat survived it", r.body.records.some(x => x.id === 'c2'));
eq('which is how the laptop learns of it', r.body.records.find(x => x.id === 'c2').payload.title, 'From the phone');

// A deletion. Under a blob this was undone by the next upload from a device
// that still had the chat; a tombstone is a write and travels like one.
//
// Dated now rather than 4000, which is the first of January 1970. Every
// other timestamp in this file is a small number because only their *order*
// matters -- but a tombstone is also swept once it is thirty days old, and
// the sweep runs on two per cent of writes. So this assertion failed about
// one run in fifty: the tombstone was correctly written, correctly swept as
// ancient, and gone before the next line read it. The bug was the date.
const deletedAt = Date.now();
r = await bobPhone2.post('/api/auth/sync', {
  since: r.body.rev, ownerId: bobId,
  records: [{ kind: 'chat', id: 'c1', updatedAt: deletedAt, deleted: true }],
});
eq('the phone deletes a chat', r.body.applied, 1);

r = await bob.get('/api/auth/sync?since=0');
const tombstone = r.body.records.find(x => x.id === 'c1');
check('the laptop is told it is gone', tombstone?.deleted === true);
eq('and the tombstone carries no payload', tombstone.payload, null);

// An older edit arriving late must not undo a newer one. This is the case a
// phone that was offline for an hour produces, and the one a blob got wrong
// every single time.
r = await bob.post('/api/auth/sync', {
  since: 0, ownerId: bobId, records: [chat('c2', 500, 'stale copy')],
});
eq('a stale edit is rejected', r.body.rejected, 1);
eq('and nothing was applied', r.body.applied, 0);
r = await bob.get('/api/auth/sync?since=0');
eq('so the newer version stands', r.body.records.find(x => x.id === 'c2').payload.title, 'From the phone');

// Deltas: a device that is up to date is told nothing, which is what makes
// polling cheap enough to do from a phone.
const upToDate = await bob.get(`/api/auth/sync?since=${r.body.rev}`);
eq('an up-to-date device receives nothing', upToDate.body.records.length, 0);
check('and is told so', upToDate.body.complete);

// Unknown kinds are refused rather than stored.
r = await bob.post('/api/auth/sync', {
  since: 0, ownerId: bobId, records: [{ kind: 'malware', id: 'x', updatedAt: 1, payload: {} }],
});
eq('an unknown record kind is refused', r.status, 400);

r = await bob.get('/api/auth/stats');
eq('the account reports what it holds', r.body.chats, 1);
eq('for the right owner', r.body.ownerId, bobId);

/* -------------------------------------------------------------- no session */

const stranger = makeClient();
r = await stranger.get('/api/auth/session');
eq('a browser with no cookie is nobody', r.body.user, null);
r = await stranger.get('/api/auth/sync?since=0');
eq('and cannot read any data', r.status, 401);
eq('with a code the client can act on', r.body.code, 'unauthenticated');

/* -------------------------------------------------------------- throttling */

const guesser = makeClient();
let lastStatus = 0;
for (let i = 0; i < 12; i++) {
  const attempt = await guesser.post('/api/auth/login', { email: 'alice@example.com', password: `guess-${i}` });
  lastStatus = attempt.status;
  if (attempt.status === 429) break;
}
eq('guessing is eventually throttled', lastStatus, 429);

// The throttle is per address *and* address-plus-account, so a different
// account from the same place is a separate counter rather than collateral.
const other = makeClient();
r = await other.post('/api/auth/login', { email: 'bob@example.com', password: 'a different long password' });
eq('a different account is not caught in it', r.status, 200);

/* ------------------------------------------------------- password change */

r = await bob.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'brand new password' });
eq('a password change needs the old one', r.status, 400);

// A second device for bob, so the revocation has something to revoke.
const bobPhone = makeClient();
r = await bobPhone.post('/api/auth/login', { email: 'bob@example.com', password: 'a different long password' });
eq("bob's phone signs in", r.status, 200);

r = await bob.post('/api/auth/password', {
  currentPassword: 'a different long password', newPassword: 'brand new password',
});
eq('the change succeeds with the right one', r.status, 200);
check('and ends the other sessions', r.body.endedSessions >= 1);

r = await bobPhone.get('/api/auth/session');
eq('so the other device is signed out', r.body.user, null);

r = await bob.get('/api/auth/session');
eq('while this one stays signed in', r.body.user?.id, bobId);

/* ---------------------------------------------------------------- passkeys */

// A CBOR encoder, only as far as the fixtures need. The decoder under test is
// deliberately not reused for this: a test that encodes with the same code it
// decodes with proves the two agree, not that either is right.
const cborBytes = (major, value) => {
  const head = (n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  return { head, value };
};
const enc = (value) => {
  if (typeof value === 'number') {
    if (value >= 0) return cborBytes(0, value).head(value);
    return cborBytes(1, -1 - value).head(-1 - value);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborBytes(2, 0).head(value.length), value]);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([cborBytes(3, 0).head(b.length), b]);
  }
  if (value instanceof Map) {
    const parts = [cborBytes(5, 0).head(value.size)];
    for (const [k, v] of value) { parts.push(enc(k), enc(v)); }
    return Buffer.concat(parts);
  }
  throw new Error(`cannot encode ${typeof value}`);
};

const b64u = (b) => Buffer.from(b).toString('base64url');

/** A P-256 authenticator that behaves itself, and can be told not to. */
const makeAuthenticator = (rpId) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);
  let counter = 0;

  const cose = new Map([
    [1, 2],                                     // kty: EC2
    [3, -7],                                    // alg: ES256
    [-1, 1],                                    // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);

  const authData = ({ attested, signCount, rpIdOverride }) => {
    const rpIdHash = crypto.createHash('sha256').update(rpIdOverride || rpId).digest();
    const flags = Buffer.from([attested ? 0x45 : 0x05]);   // UP | UV, plus AT
    const count = Buffer.alloc(4); count.writeUInt32BE(signCount);
    if (!attested) return Buffer.concat([rpIdHash, flags, count]);
    const idLength = Buffer.alloc(2); idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([
      rpIdHash, flags, count, Buffer.alloc(16), idLength, credentialId, enc(cose),
    ]);
  };

  const clientData = (type, challenge, origin) => Buffer.from(JSON.stringify({
    type, challenge, origin, crossOrigin: false,
  }));

  return {
    credentialId,
    register(challenge, origin) {
      const data = authData({ attested: true, signCount: ++counter });
      const attestationObject = enc(new Map([
        ['fmt', 'none'], ['attStmt', new Map()], ['authData', data],
      ]));
      return {
        challengeId: null,
        credentialId: b64u(credentialId),
        attestationObject: b64u(attestationObject),
        clientDataJSON: b64u(clientData('webauthn.create', challenge, origin)),
      };
    },
    assert(challenge, origin, { signCount = null, type = 'webauthn.get', rpIdOverride = null } = {}) {
      const data = authData({
        attested: false,
        signCount: signCount === null ? ++counter : signCount,
        rpIdOverride,
      });
      const cd = clientData(type, challenge, origin);
      const signature = crypto.sign(
        'sha256',
        Buffer.concat([data, crypto.createHash('sha256').update(cd).digest()]),
        privateKey,
      );
      return {
        credentialId: b64u(credentialId),
        authenticatorData: b64u(data),
        clientDataJSON: b64u(cd),
        signature: b64u(signature),
      };
    },
  };
};

const device = makeAuthenticator('127.0.0.1');

r = await alice.post('/api/auth/passkey/register/options');
eq('registration options are issued', r.status, 200);
check('with a challenge', !!r.body.publicKey?.challenge);
eq('for this host', r.body.publicKey.rp.id, '127.0.0.1');
check('offering ES256', r.body.publicKey.pubKeyCredParams.some(p => p.alg === -7));
const regChallengeId = r.body.challengeId;
const regChallenge = r.body.publicKey.challenge;

const registration = device.register(regChallenge, ORIGIN);
r = await alice.post('/api/auth/passkey/register/verify', {
  challengeId: regChallengeId,
  credentialId: registration.credentialId,
  attestationObject: registration.attestationObject,
  clientDataJSON: registration.clientDataJSON,
  label: 'Test key',
});
eq('the passkey registers', r.status, 200);
eq('and is counted on the account', r.body.user.passkeys, 1);
check('no key material comes back', !JSON.stringify(r.body.passkeys).includes('BEGIN'));

// A challenge is spent once.
r = await alice.post('/api/auth/passkey/register/verify', {
  challengeId: regChallengeId,
  credentialId: registration.credentialId,
  attestationObject: registration.attestationObject,
  clientDataJSON: registration.clientDataJSON,
});
eq('a replayed registration challenge is refused', r.status, 400);

// The exclusion list has to carry the full credential id. A truncated one
// decodes to different bytes, so the authenticator does not recognise the key
// it already holds and quietly makes a second one for the same account.
r = await alice.post('/api/auth/passkey/register/options');
eq('the exclusion list names the registered key', r.body.publicKey.excludeCredentials.length, 1);
eq('with its full id, not a display prefix',
  r.body.publicKey.excludeCredentials[0].id, registration.credentialId);
check('and asks for a discoverable credential, which sign-in requires',
  r.body.publicKey.authenticatorSelection.residentKey === 'required');

// Signing in with it, from a browser that has never seen this account.
const laptop = makeClient();
r = await laptop.post('/api/auth/passkey/login/options');
const loginChallengeId = r.body.challengeId;
const loginChallenge = r.body.publicKey.challenge;
eq('sign-in options name no account', r.body.publicKey.allowCredentials.length, 0);

const assertion = device.assert(loginChallenge, ORIGIN);
r = await laptop.post('/api/auth/passkey/login/verify', { challengeId: loginChallengeId, ...assertion });
eq('the passkey signs in', r.status, 200);
eq('as the account that registered it', r.body.user.id, aliceId);
check('and the browser gets a session', !!laptop.cookie('webui_session'));

// The checks that make it a credential rather than a formality.
const badOrigin = makeClient();
r = await badOrigin.post('/api/auth/passkey/login/options');
r = await badOrigin.post('/api/auth/passkey/login/verify', {
  challengeId: r.body.challengeId,
  ...device.assert(r.body.publicKey.challenge, 'http://evil.example'),
});
eq('an assertion from another origin is refused', r.status, 401);

const wrongRp = makeClient();
r = await wrongRp.post('/api/auth/passkey/login/options');
r = await wrongRp.post('/api/auth/passkey/login/verify', {
  challengeId: r.body.challengeId,
  ...device.assert(r.body.publicKey.challenge, ORIGIN, { rpIdOverride: 'evil.example' }),
});
eq('an assertion for another site is refused', r.status, 401);

const wrongChallenge = makeClient();
r = await wrongChallenge.post('/api/auth/passkey/login/options');
r = await wrongChallenge.post('/api/auth/passkey/login/verify', {
  challengeId: r.body.challengeId,
  ...device.assert(crypto.randomBytes(32).toString('base64url'), ORIGIN),
});
eq('an assertion to a challenge we never issued is refused', r.status, 401);

const stale = makeClient();
r = await stale.post('/api/auth/passkey/login/options');
r = await stale.post('/api/auth/passkey/login/verify', {
  challengeId: r.body.challengeId,
  ...device.assert(r.body.publicKey.challenge, ORIGIN, { signCount: 1 }),
});
eq('a counter that went backwards is refused', r.status, 401);

const forged = makeClient();
r = await forged.post('/api/auth/passkey/login/options');
const forgedAssertion = device.assert(r.body.publicKey.challenge, ORIGIN);
forgedAssertion.signature = b64u(crypto.randomBytes(70));
r = await forged.post('/api/auth/passkey/login/verify', {
  challengeId: r.body.challengeId, ...forgedAssertion,
});
eq('a bad signature is refused', r.status, 401);

// A passkey nobody registered names no account, and says so without revealing
// whether any account exists.
const unknown = makeClient();
r = await unknown.post('/api/auth/passkey/login/options');
r = await unknown.post('/api/auth/passkey/login/verify', {
  challengeId: r.body.challengeId,
  ...makeAuthenticator('127.0.0.1').assert(r.body.publicKey.challenge, ORIGIN),
});
eq('an unregistered passkey is refused', r.status, 401);

/* ---------------------------------------------------------------- sign out */

const sessionBeforeLogout = alice.cookie('webui_session');
r = await alice.post('/api/auth/logout');
eq('signing out succeeds', r.status, 200);
eq('and clears the cookie', alice.cookie('webui_session'), null);

// The session is gone from the server, not merely from the browser: a captured
// cookie has to stop working, and "the client forgot it" is not that.
check('and the session is destroyed server-side',
  !peek().includes(crypto.createHash('sha256').update(sessionBeforeLogout).digest('hex')));

// The other browser that signed in with the passkey is a separate session and
// is untouched, which is what makes "sign out everywhere" a distinct action.
r = await laptop.get('/api/auth/session');
eq('another device stays signed in', r.body.user?.id, aliceId);

r = await laptop.post('/api/auth/logout-others');
eq('until it ends the others', r.status, 200);

/* ------------------------------------------------------------ account removal */

r = await laptop.post('/api/auth/account');
eq('the account can be deleted', r.status, 200);
r = await laptop.get('/api/auth/session');
eq('and is gone', r.body.user, null);

// The foreign keys take the rest with it: records, sessions, credentials. A
// deleted account leaving its chats on disk is a data-retention bug.
const leftovers = new DatabaseSync(path.join(DATA, 'webui.db'), { readOnly: true });
eq('its records are gone',
  leftovers.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id = ?').get(aliceId).n, 0);
eq('its sessions are gone',
  leftovers.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(aliceId).n, 0);
eq('its passkeys are gone',
  leftovers.prepare('SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?').get(aliceId).n, 0);
leftovers.close();

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
