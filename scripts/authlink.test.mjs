// The shape contract between the Google sign-in and the code that links it to
// the server account.
//
// This exists because of a real bug: upsertSocialUser returns a wrapper
// `{ user }`, so attaching the credential beside it produced
// `{ user, credential }` — and every caller passes `result.user` onwards, which
// silently dropped it. Sign-in still appeared to work; nothing ever synced.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// localforage needs IndexedDB, which Node has not got. A stub keeps the module
// loadable so the pure shape logic can be exercised.
const stub = path.resolve(HERE, '../node_modules/.localforage-auth-stub.mjs');
fs.writeFileSync(stub, `
const store = new Map();
export default {
  async getItem(k) { return store.has(k) ? store.get(k) : null; },
  async setItem(k, v) { store.set(k, v); return v; },
  async removeItem(k) { store.delete(k); },
  createInstance() { return this; },
};
`);

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/auth.jsx'),
  external: ['react', 'react/jsx-runtime', 'lucide-react', 'highlight.js/lib/common'],
  platform: 'neutral',
  resolve: { alias: { localforage: stub } },
});
const file = path.resolve(HERE, '../node_modules/.authlink-test.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();

globalThis.localStorage = {
  _d: new Map(),
  get length() { return this._d.size; },
  key(i) { return [...this._d.keys()][i] ?? null; },
  getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
  setItem(k, v) { this._d.set(k, String(v)); },
  removeItem(k) { this._d.delete(k); },
};
// Node 20+ already exposes a read-only globalThis.crypto; nothing to do.

const A = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// A Google ID token is three dot-separated base64url parts; only the middle one
// is read here, and the server is what actually verifies the signature.
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const idToken = `${b64({ alg: 'RS256' })}.${b64({
  sub: '1234567890',
  email: 'person@example.com',
  name: 'A Person',
  picture: 'https://example.com/a.png',
})}.signature-not-checked-here`;

const result = await A.acceptGoogleCredential(idToken);

// The contract every caller depends on.
check('the result wraps a user', !!result.user);
eq('the credential is ON the user, not beside it', result.user.credential, idToken);
check('a credential beside the user would be dropped', result.credential === undefined);

// Simulating what AuthScreen and handleAuthenticated actually do.
const passedUp = result.user;
eq('the credential survives being passed as result.user', passedUp.credential, idToken);
check('so the link call would fire', !!passedUp.credential);

// The identity itself still comes through.
eq('the name is taken from the token', result.user.name, 'A Person');
eq('the email is taken from the token', result.user.email, 'person@example.com');
eq('the provider is recorded', result.user.provider, 'google');
// publicUser deliberately does not expose providerId — the client never needs
// it, and the server reads the subject from the token it verified itself.
check('the provider id is not handed to the client', result.user.providerId === undefined);

// Signing in twice is one account, still carrying a credential each time.
const second = await A.acceptGoogleCredential(idToken);
eq('the same Google account resolves to the same local user', second.user.id, result.user.id);
eq('and still carries the credential', second.user.credential, idToken);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
