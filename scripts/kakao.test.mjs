// Kakao Login: the parts that can be checked without talking to Kakao.
//
// The state machinery and the token lifetime arithmetic are where this either
// is or is not the documented flow, and both were absent before: `state` was
// minted and compared in the browser, which proves nothing about a forged
// callback, and the tokens were read once and dropped, so the connection could
// not be maintained, ended, or severed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tokens live in the database now, beside the account they belong to, so
// deleting an account takes them with it rather than leaving a live credential
// in a file named after somebody who no longer exists. That means this test
// needs a database — a scratch one, never the real data directory.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-kakao-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase, database } = await import('../server/db.js');

process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const K = await import('../server/kakao.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ------------------------------------------------------------------- state
const state = K.issueState();
check('a state is long enough to be unguessable', state.length >= 32);
check('two states differ', K.issueState() !== state);

check('a state this server issued is accepted', K.consumeState(state));
check('and only once — a replayed callback is refused', !K.consumeState(state));
check('a state it never issued is refused', !K.consumeState('made-up-value'));
check('an empty state is refused', !K.consumeState(''));
check('a missing state is refused', !K.consumeState(undefined));

// ------------------------------------------------------------ authorize url
const url = K.authorizeUrl({
  restKey: 'REST123',
  redirectUri: 'http://localhost:5173/kakao/callback',
  state: 'STATE456',
});
check('it points at the documented endpoint', url.startsWith('https://kauth.kakao.com/oauth/authorize?'));
check('it carries the rest key as client_id', url.includes('client_id=REST123'));
check('it carries response_type=code', url.includes('response_type=code'));
check('it carries the state', url.includes('state=STATE456'));
check('the redirect uri is encoded', url.includes('redirect_uri=http%3A%2F%2Flocalhost%3A5173%2Fkakao%2Fcallback'));
check('no scope is requested unless asked for', !url.includes('scope='));
check('a scope is included when given',
  K.authorizeUrl({ restKey: 'k', redirectUri: 'r', state: 's', scope: 'account_email' })
    .includes('scope=account_email'));

// ------------------------------------------------------------------ tokens
const userId = '11111111-2222-3333-4444-555555555555';
database().prepare(
  "INSERT INTO users (id, name, provider, created_at, rev) VALUES (?, 'Kakao user', 'kakao', ?, 0)"
).run(userId, Date.now());

eq('an account with no connection has no tokens', K.readTokens(userId), null);

K.writeTokens(userId, {
  accessToken: 'ACCESS', accessTokenExpiresAt: Date.now() + 3600_000,
  refreshToken: 'REFRESH', refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
  scope: 'profile_nickname', updatedAt: Date.now(),
});
eq('tokens round-trip', K.readTokens(userId).accessToken, 'ACCESS');

// Tokens are the thing that must never reach a browser; make sure they are
// somewhere a request cannot name.
const stored = JSON.stringify(
  database().prepare('SELECT * FROM kakao_tokens WHERE user_id = ?').get(userId));
check('the refresh token is stored server-side', stored.includes('REFRESH'));

// These used to be checked because the id became a filename and a traversal
// would have written anywhere the process could reach. There is no path any
// more, and the constraint that matters now is different but stronger: a token
// is a live credential, so it may not exist without an account to belong to.
for (const bad of ['../../etc/passwd', '', null, 'not-a-uuid', 'a/../b']) {
  let refused = false;
  try { K.writeTokens(bad, { accessToken: 'x' }); } catch (e) { refused = true; }
  check(`an id naming no account is refused: ${JSON.stringify(bad)}`, refused);
}

// Expiry arithmetic decides whether a call refreshes or fails.
check('a token with hours left is not refreshed', !K.needsRefresh(K.readTokens(userId)));

K.writeTokens(userId, {
  accessToken: 'ACCESS', accessTokenExpiresAt: Date.now() + 60_000,   // inside the margin
  refreshToken: 'REFRESH', scope: '', updatedAt: Date.now(),
});
check('a token about to expire is refreshed before it fails', K.needsRefresh(K.readTokens(userId)));

K.writeTokens(userId, {
  accessToken: 'ACCESS', accessTokenExpiresAt: Date.now() - 1000,
  refreshToken: null, scope: '', updatedAt: Date.now(),
});
check('an expired token with no refresh token cannot be refreshed',
  !K.needsRefresh(K.readTokens(userId)));

K.clearTokens(userId);
eq('clearing removes them', K.readTokens(userId), null);
check('clearing twice is not an error', (() => { K.clearTokens(userId); return true; })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
