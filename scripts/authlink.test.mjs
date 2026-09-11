// The contract between the client and the server's session.
//
// This file used to pin the shape of a bug: `upsertSocialUser` returned
// `{ user }`, so a Google credential attached beside it was silently dropped by
// every caller, and sign-in appeared to work while nothing ever synced. That
// bug is gone in the strong sense — the code it lived in is gone. The client no
// longer creates a user record to attach a credential to; it posts the
// credential to the server and believes the answer.
//
// What is worth pinning now is what replaced it. Every call to our own API must
// carry the session cookie and, when it changes anything, the CSRF token —
// because a cross-site form post carries the cookie too, and the token is the
// only thing that distinguishes "the browser sent this" from "this page did".
// And a failure must arrive as a code the UI can translate, not as an English
// sentence it has to pattern-match.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/session.jsx'),
  external: ['react', 'react/jsx-runtime', 'lucide-react', 'localforage'],
  platform: 'neutral',
});
const file = path.resolve(HERE, '../node_modules/.authlink-test.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();

// The calls under test are recorded rather than made.
let calls = [];
let reply = { status: 200, body: { success: true } };
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, ...options });
  if (reply instanceof Error) throw reply;
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
  };
};

const S = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const last = () => calls[calls.length - 1];
const reset = () => { calls = []; };

/* ------------------------------------------------------- cookies and CSRF */

reset();
reply = { status: 200, body: { success: true, user: null, csrfToken: null } };
await S.api('/api/auth/session');

eq('the session is asked for by GET', last().method, 'GET');
// The cookie is HttpOnly, so it is the only thing identifying the caller and
// the default `omit` would make every request anonymous.
eq('the session cookie is sent', last().credentials, 'same-origin');
check('a GET carries no CSRF token', !last().headers['X-CSRF-Token']);

// The token arrives with the session and is picked up wherever it appears,
// because it rotates whenever the session does.
reset();
reply = { status: 200, body: { success: true, user: { id: 'u1' }, csrfToken: 'tok-abc' } };
await S.api('/api/auth/session');
eq('the token is captured from the reply', S.currentCsrfToken(), 'tok-abc');

reset();
reply = { status: 200, body: { success: true } };
await S.api('/api/auth/profile', { method: 'POST', body: { name: 'Ada' } });
eq('a state-changing call carries the token', last().headers['X-CSRF-Token'], 'tok-abc');
eq('and says it is JSON', last().headers['Content-Type'], 'application/json');
eq('and sends the body', last().body, JSON.stringify({ name: 'Ada' }));
eq('and still sends the cookie', last().credentials, 'same-origin');

// A rotated token replaces the old one rather than sitting beside it.
reset();
reply = { status: 200, body: { success: true, user: { id: 'u1' }, csrfToken: 'tok-def' } };
await S.api('/api/auth/login', { method: 'POST', body: { email: 'a@b.co', password: 'x' } });
eq('a new token replaces the old', S.currentCsrfToken(), 'tok-def');
reset();
reply = { status: 200, body: { success: true } };
await S.api('/api/auth/profile', { method: 'POST', body: {} });
eq('and is what later calls send', last().headers['X-CSRF-Token'], 'tok-def');

/* ----------------------------------------------------------------- errors */

// A refusal has to arrive as something the UI can act on. Matching on English
// prose is how a translated build silently stops handling its own errors.
const failing = async (status, body) => {
  reply = { status, body };
  try { await S.api('/api/auth/login', { method: 'POST', body: {} }); return null; }
  catch (e) { return e; }
};

let err = await failing(401, { success: false, error: 'Wrong email or password.', code: 'bad-credentials' });
check('a refusal throws', err instanceof Error);
eq('it is an ApiError', err.name, 'ApiError');
eq('it carries the status', err.status, 401);
eq('and the code the UI translates', err.code, 'bad-credentials');
eq('and the server message as a fallback', err.message, 'Wrong email or password.');

err = await failing(401, { success: false, error: 'Not signed in.', code: 'unauthenticated' });
eq('being signed out is distinguishable', err.code, 'unauthenticated');

err = await failing(403, { success: false, error: 'That request could not be verified.', code: 'csrf' });
eq('a CSRF refusal is distinguishable', err.code, 'csrf');

err = await failing(429, { success: false, error: 'Too many attempts.', code: 'throttled' });
eq('throttling is distinguishable', err.code, 'throttled');

// `success: false` with a 200 is still a failure. Trusting the status code
// alone meant a refusal read as a successful sign-in.
err = await failing(200, { success: false, error: 'Nope.', code: 'owner-mismatch' });
check('a 200 that says success:false still throws', err instanceof Error);
eq('and keeps its code', err.code, 'owner-mismatch');

// No server at all is a state the app has to survive: it runs as the guest.
reply = new Error('ECONNREFUSED');
err = await (async () => {
  try { await S.api('/api/auth/session'); return null; } catch (e) { return e; }
})();
eq('an unreachable server is reported as offline', err.code, 'offline');
check('and not as a crash', err.name === 'ApiError');

/* -------------------------------------------------- the sign-in surface */

// Each of these hands a credential to the server and returns what the server
// says. None of them decides anything about who the person is — which is the
// whole point, and what the bug this file used to cover was a symptom of.
reset();
reply = { status: 200, body: { success: true, user: { id: 'u9' }, csrfToken: 't' } };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const idToken = `${b64({ alg: 'RS256' })}.${b64({ sub: '1234567890', email: 'person@example.com' })}.sig`;
await S.loginWithGoogle(idToken);

eq('the Google credential goes to the server', last().url, '/api/auth/google');
eq('by POST', last().method, 'POST');
eq('verbatim, without being read here', JSON.parse(last().body).credential, idToken);
check('and nothing from inside the token is sent alongside it',
  Object.keys(JSON.parse(last().body)).join() === 'credential');

reset();
await S.loginWithPassword('a@b.co', 'secret');
eq('a password sign-in posts to the login route', last().url, '/api/auth/login');

reset();
await S.registerAccount('Ada', 'a@b.co', 'secret');
eq('registration posts to the register route', last().url, '/api/auth/register');

reset();
await S.changePassword('old', 'new');
eq('a password change has its own route', last().url, '/api/auth/password');
check('and carries the current password as proof',
  JSON.parse(last().body).currentPassword === 'old');

reset();
await S.signOutOtherDevices();
eq('ending other sessions is a POST the server performs', last().url, '/api/auth/logout-others');
eq('and it is state-changing', last().method, 'POST');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
