// Checks translation completeness and the auth crypto helpers.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The auth module uses browser globals; provide the few it needs in Node.
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}
if (!globalThis.document) globalThis.document = { documentElement: {}, getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ addEventListener() {} }) };
if (!globalThis.window) globalThis.window = globalThis;
if (!globalThis.navigator) globalThis.navigator = { language: 'en-US', languages: ['en-US'] };

const bundleOne = async (entry, out) => {
  const bundle = await rolldown({
    input: path.resolve(HERE, entry),
    external: ['react', 'react/jsx-runtime', 'lucide-react', 'localforage', 'highlight.js/lib/common'],
    platform: 'neutral',
  });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

const i18n = await bundleOne('../src/i18n.jsx', '../node_modules/.i18n-test-bundle.mjs');
const auth = await bundleOne('../src/auth.jsx', '../node_modules/.auth-test-bundle.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};

// ------------------------------------------------------------------ i18n
const { LANGUAGES, strings, translate, resolveLanguage } = i18n;
const englishKeys = Object.keys(strings.en);

check('every listed language has a table', LANGUAGES.every(l => !!strings[l.code]),
  LANGUAGES.filter(l => !strings[l.code]).map(l => l.code).join(','));

check('no language table is orphaned', Object.keys(strings).every(code => LANGUAGES.some(l => l.code === code)),
  Object.keys(strings).filter(c => !LANGUAGES.some(l => l.code === c)).join(','));

for (const l of LANGUAGES) {
  const table = strings[l.code] || {};
  const missing = englishKeys.filter(k => table[k] === undefined);
  check(`${l.code} translates every key`, missing.length === 0, `missing: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` (+${missing.length - 6})` : ''}`);
}

for (const l of LANGUAGES) {
  const extra = Object.keys(strings[l.code] || {}).filter(k => !englishKeys.includes(k));
  check(`${l.code} has no stale keys`, extra.length === 0, extra.slice(0, 5).join(', '));
}

// Placeholders must survive translation, otherwise interpolation silently drops data.
const placeholderKeys = englishKeys.filter(k => /\{\w+\}/.test(strings.en[k]));
check('there are interpolated strings to check', placeholderKeys.length > 0);
for (const l of LANGUAGES) {
  const broken = placeholderKeys.filter(k => {
    const want = (strings.en[k].match(/\{\w+\}/g) || []).sort().join(',');
    const got = ((strings[l.code][k] || '').match(/\{\w+\}/g) || []).sort().join(',');
    return want !== got;
  });
  check(`${l.code} keeps every placeholder`, broken.length === 0, broken.join(', '));
}

/* -------------------------------------- English that never reached a table
 *
 * Twelve toasts were written as plain string literals — "Message deleted.",
 * 'Deleted "…"', "Web search failed: …" — so a Korean user got English at the
 * moments that matter most: deleting a chat, deleting a message, a search
 * failing. Nothing above catches that, because the strings were never keys.
 *
 * A toast is the whole of what the app says about an action that already
 * happened, so this is the one place a stray literal is guaranteed to be
 * read. `t(...)`, a variable and a template holding only interpolation are
 * all fine; a literal with a letter in it is not.
 */
const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const literalToasts = [...appSource.matchAll(/\btoast\(\s*(['"`])((?:[^\\]|\\.)*?)\1/g)]
  .map(m => m[2])
  // A template that is nothing but `${…}` carries no English of its own.
  .filter(text => /[A-Za-z]/.test(text.replace(/\$\{[^}]*\}/g, '')));
check('no toast is a bare English literal', literalToasts.length === 0,
  literalToasts.slice(0, 5).map(s => JSON.stringify(s.slice(0, 60))).join('\n      '));

// The same for the button inside a toast: five said t('common.undo') and
// three said 'Undo', which is the shape a reviewer's eye slides over.
const literalActions = [...appSource.matchAll(/\blabel:\s*(['"])([^'"]+)\1/g)]
  .map(m => m[2])
  .filter(text => /[A-Za-z]/.test(text));
check('no toast action label is a bare English literal', literalActions.length === 0,
  literalActions.slice(0, 5).join(', '));

check('interpolation substitutes', translate('en', 'auth.signedInAs', { name: 'Ada' }) === 'Signed in as Ada');
check('interpolation works in Korean', translate('ko', 'auth.signedInAs', { name: '정우' }).includes('정우'));
check('unknown key returns the key', translate('en', 'nope.missing') === 'nope.missing');
check('missing translation falls back to English', translate('ko', 'nope.missing') === 'nope.missing');

check('zh-TW maps to Traditional', resolveLanguage('zh-TW') === 'zh-Hant');
check('zh-CN maps to Simplified', resolveLanguage('zh-CN') === 'zh-Hans');
check('zh alone maps to Simplified', resolveLanguage('zh') === 'zh-Hans');
check('regional tags fall back to the base language', resolveLanguage('pt-BR') === 'pt' && resolveLanguage('de-AT') === 'de');
check('unknown tags fall back to English', resolveLanguage('xx-YY') === 'en');
check('Arabic is marked RTL', LANGUAGES.find(l => l.code === 'ar').dir === 'rtl');
check('all other languages are LTR', LANGUAGES.filter(l => l.code !== 'ar').every(l => l.dir === 'ltr'));

// ------------------------------------------------------------------ auth
//
// Almost everything that used to be checked here has moved. Password hashing,
// session records, passkey verification and the DER/ECDSA plumbing were all
// done in the browser — by a page verifying credentials against a store that
// same page could write, which verifies nothing at all. They live on the server
// now and are covered end-to-end, over real HTTP, by scripts/auth.test.mjs.
//
// What is left in auth.jsx is the part that genuinely belongs to a browser:
// provider configuration, and reading what a redirect handed back.
const {
  sessionStorageKeyFor, decodeJwtPayload, socialConfig, socialDefaults,
  setServerSocialConfig, kakaoRedirectUri,
} = auth;

// The client no longer holds any machinery for deciding who someone is.
// Asserting their absence is the point: a re-export would quietly restore the
// second source of identity that this whole rework exists to remove.
for (const gone of [
  'derivePasswordHash', 'registerWithPassword', 'signInWithPassword',
  'upsertSocialUser', 'loadUsers', 'saveSession', 'readSession', 'deleteUser',
  'verifyAssertion', 'registerPasskey', 'derToRawEcdsaSignature', 'changePassword',
]) {
  check(`the client no longer exports ${gone}`, auth[gone] === undefined);
}

check('the guest keeps the original storage key', sessionStorageKeyFor(null) === 'ollama-sessions');
check('an empty scope is the guest too', sessionStorageKeyFor('') === 'ollama-sessions');
check('an account gets its own storage key', sessionStorageKeyFor('srv-abc') === 'ollama-sessions:srv-abc');
check('two accounts do not share a key', sessionStorageKeyFor('a') !== sessionStorageKeyFor('b'));

const payload = { sub: '1234', email: 'user@example.com', name: 'Tester' };
const fakeJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const decoded = decodeJwtPayload(fakeJwt);
check('JWT payload decodes', decoded.sub === '1234' && decoded.email === 'user@example.com');

const unicodeJwt = `h.${Buffer.from(JSON.stringify({ name: '정우 — テスト' })).toString('base64url')}.s`;
check('JWT decoding handles non-ASCII names', decodeJwtPayload(unicodeJwt).name === '정우 — テスト');

let threw = false;
try { decodeJwtPayload('not-a-jwt'); } catch { threw = true; }
check('a malformed token throws instead of returning junk', threw);

// ------------------------------------------------------- provider config
// Serving these at runtime is what lets a phone — a different origin with an
// empty localStorage — get a working sign-in button without anyone pasting keys.
setServerSocialConfig({ googleClientId: 'from-server', kakaoRestKey: 'kakao-server' });
check('the server supplies the client id', socialConfig().googleClientId === 'from-server');
check('and the Kakao REST key', socialConfig().kakaoRestKey === 'kakao-server');
check('defaults report what applies with nothing stored', socialDefaults().googleClientId === 'from-server');

localStorage.setItem('googleClientId', 'typed-in-settings');
check('a value typed into settings overrides the server', socialConfig().googleClientId === 'typed-in-settings');
check('but the default still reports the server value', socialDefaults().googleClientId === 'from-server');
localStorage.removeItem('googleClientId');

globalThis.window.location = { origin: 'http://192.168.1.9:5173' };
check('the Kakao redirect URI names this exact origin',
  kakaoRedirectUri() === 'http://192.168.1.9:5173/kakao/callback');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
