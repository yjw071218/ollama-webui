// Checks translation completeness and the auth crypto helpers.
import { rolldown } from 'rolldown';
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
const {
  derivePasswordHash, constantTimeEqual, isValidEmail, normalizeEmail,
  sessionStorageKeyFor, decodeJwtPayload,
} = auth;

const first = await derivePasswordHash('correct horse battery staple');
const again = await derivePasswordHash('correct horse battery staple', first.salt, first.iterations);
check('the same password and salt derive the same hash', first.hash === again.hash);

const wrong = await derivePasswordHash('Correct horse battery staple', first.salt, first.iterations);
check('a different password derives a different hash', wrong.hash !== first.hash);

const otherSalt = await derivePasswordHash('correct horse battery staple');
check('each account gets its own salt', otherSalt.salt !== first.salt);
check('the same password under a different salt hashes differently', otherSalt.hash !== first.hash);
check('iterations meet the OWASP floor', first.iterations >= 210000, String(first.iterations));
check('the hash is not the password', !first.hash.includes('correct'));

check('constant-time compare accepts equal values', constantTimeEqual('abc123', 'abc123'));
check('constant-time compare rejects different values', !constantTimeEqual('abc123', 'abc124'));
check('constant-time compare rejects different lengths', !constantTimeEqual('abc', 'abcd'));

check('valid emails pass', isValidEmail('a@b.co') && isValidEmail('user@university.ac.kr'));
check('invalid emails fail', !isValidEmail('a@b') && !isValidEmail('nope') && !isValidEmail('') && !isValidEmail('a b@c.com'));
check('emails are normalised', normalizeEmail('  Foo@Example.COM ') === 'foo@example.com');

check('the guest keeps the original storage key', sessionStorageKeyFor(null) === 'ollama-sessions');
check('a profile gets its own storage key', sessionStorageKeyFor('abc') === 'ollama-sessions:abc');
check('two profiles do not share a key', sessionStorageKeyFor('a') !== sessionStorageKeyFor('b'));

const payload = { sub: '1234', email: 'user@example.com', name: 'Tester' };
const fakeJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const decoded = decodeJwtPayload(fakeJwt);
check('JWT payload decodes', decoded.sub === '1234' && decoded.email === 'user@example.com');

const unicodeJwt = `h.${Buffer.from(JSON.stringify({ name: '정우 — テスト' })).toString('base64url')}.s`;
check('JWT decoding handles non-ASCII names', decodeJwtPayload(unicodeJwt).name === '정우 — テスト');

let threw = false;
try { decodeJwtPayload('not-a-jwt'); } catch { threw = true; }
check('a malformed token throws instead of returning junk', threw);

// --------------------------------------------------------------- passkeys
const { derToRawEcdsaSignature, verifyAssertion, isPasskeySupported } = auth;

check('passkey support probe is false in Node', isPasskeySupported() === false);

// A DER SEQUENCE of two 32-byte integers.
const der32 = new Uint8Array([
  0x30, 0x44,
  0x02, 0x20, ...new Array(32).fill(0xAA),
  0x02, 0x20, ...new Array(32).fill(0xBB),
]);
const raw32 = derToRawEcdsaSignature(der32);
check('DER with two full-length integers converts to 64 bytes',
  raw32.length === 64 && raw32[0] === 0xAA && raw32[32] === 0xBB);

// A high bit in the first byte makes DER prepend 0x00; that pad must be dropped.
const derPadded = new Uint8Array([
  0x30, 0x46,
  0x02, 0x21, 0x00, ...new Array(32).fill(0xFF),
  0x02, 0x21, 0x00, ...new Array(32).fill(0xEE),
]);
const rawPadded = derToRawEcdsaSignature(derPadded);
check('a DER sign-padding byte is stripped',
  rawPadded.length === 64 && rawPadded[0] === 0xFF && rawPadded[31] === 0xFF && rawPadded[32] === 0xEE);

// A short integer must be left-padded back out to 32 bytes.
const derShort = new Uint8Array([
  0x30, 0x26,
  0x02, 0x02, 0x01, 0x02,
  0x02, 0x20, ...new Array(32).fill(0x11),
]);
const rawShort = derToRawEcdsaSignature(derShort);
check('a short DER integer is left-padded to 32 bytes',
  rawShort.length === 64 && rawShort[0] === 0 && rawShort[30] === 0x01 && rawShort[31] === 0x02);

let derThrew = false;
try { derToRawEcdsaSignature(new Uint8Array([0x02, 0x01, 0x00])); } catch { derThrew = true; }
check('a non-SEQUENCE signature is rejected', derThrew);

// End-to-end: sign like an authenticator would, then verify through the app path.
const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const spki = await webcrypto.subtle.exportKey('spki', keyPair.publicKey);
const spkiB64 = Buffer.from(spki).toString('base64');

const authenticatorData = webcrypto.getRandomValues(new Uint8Array(37));
const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: 'abc', origin: 'http://localhost:5173' }));
const clientHash = await webcrypto.subtle.digest('SHA-256', clientDataJSON);
const signedData = new Uint8Array(authenticatorData.length + clientHash.byteLength);
signedData.set(authenticatorData, 0);
signedData.set(new Uint8Array(clientHash), authenticatorData.length);

const rawSig = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signedData));

// WebCrypto emits raw r||s; authenticators emit DER. Re-encode to mimic one.
const toDerInteger = (bytes) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let value = bytes.slice(start);
  if (value[0] & 0x80) value = Uint8Array.from([0, ...value]);
  return [0x02, value.length, ...value];
};
const rInts = toDerInteger(rawSig.slice(0, 32));
const sInts = toDerInteger(rawSig.slice(32));
const body = [...rInts, ...sInts];
const derSig = Uint8Array.from([0x30, body.length, ...body]);

check('re-encoded DER round-trips back to the raw signature',
  Buffer.from(derToRawEcdsaSignature(derSig)).equals(Buffer.from(rawSig)));

const verified = await verifyAssertion({
  publicKeySpki: spkiB64,
  algorithm: -7,
  authenticatorData,
  clientDataJSON,
  signature: derSig,
});
check('a genuine passkey assertion verifies', verified === true);

const tampered = new Uint8Array(authenticatorData);
tampered[0] ^= 0xFF;
const verifiedTampered = await verifyAssertion({
  publicKeySpki: spkiB64,
  algorithm: -7,
  authenticatorData: tampered,
  clientDataJSON,
  signature: derSig,
});
check('a tampered assertion fails verification', verifiedTampered === false);

const otherPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const otherSpki = Buffer.from(await webcrypto.subtle.exportKey('spki', otherPair.publicKey)).toString('base64');
const verifiedWrongKey = await verifyAssertion({
  publicKeySpki: otherSpki,
  algorithm: -7,
  authenticatorData,
  clientDataJSON,
  signature: derSig,
});
check('another key does not verify the assertion', verifiedWrongKey === false);

let algThrew = false;
try {
  await verifyAssertion({ publicKeySpki: spkiB64, algorithm: -999, authenticatorData, clientDataJSON, signature: derSig });
} catch { algThrew = true; }
check('an unsupported algorithm is rejected', algThrew);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
