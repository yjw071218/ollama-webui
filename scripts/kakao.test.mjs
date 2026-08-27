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
import { pathToFileURL } from 'node:url';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-kakao-'));
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const serverDir = path.resolve(HERE, '../server');

// The module writes under <server>/data; stage copies beside a data dir we own.
const stage = path.join(scratch, 'server');
fs.mkdirSync(stage, { recursive: true });
for (const file of ['accounts.js', 'kakao.js']) {
  fs.copyFileSync(path.join(serverDir, file), path.join(stage, file));
}

const K = await import(pathToFileURL(path.join(stage, 'kakao.js')).href);

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

eq('an account with no connection has no tokens', K.readTokens(userId), null);

K.writeTokens(userId, {
  accessToken: 'ACCESS', accessTokenExpiresAt: Date.now() + 3600_000,
  refreshToken: 'REFRESH', refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
  scope: 'profile_nickname', updatedAt: Date.now(),
});
eq('tokens round-trip', K.readTokens(userId).accessToken, 'ACCESS');

// Tokens are the thing that must never reach a browser; make sure they are
// somewhere a request cannot name.
const stored = fs.readFileSync(path.join(stage, 'data', 'kakao', `${userId}.json`), 'utf-8');
check('the refresh token is stored server-side', stored.includes('REFRESH'));

for (const bad of ['../../etc/passwd', '', null, 'not-a-uuid', 'a/../b']) {
  let refused = false;
  try { K.writeTokens(bad, { accessToken: 'x' }); } catch (e) { refused = true; }
  check(`a path-shaped account id is refused: ${JSON.stringify(bad)}`, refused);
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

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
