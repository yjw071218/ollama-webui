import {test} from 'node:test';
import assert from 'node:assert/strict';
import {kakaoCallbackUri, matchingStateCookie, oauthStateCookie} from '../server/oauthOrigin.js';
const req = {headers:{host:'server.example:5173'},socket:{}};
test('callback comes from server configuration, not arbitrary client redirect', () => {
  assert.equal(kakaoCallbackUri(req), 'http://server.example:5173/kakao/callback');
  assert.equal(kakaoCallbackUri(req, {PUBLIC_ORIGIN:'https://chat.example'}), 'https://chat.example/kakao/callback');
  assert.equal(kakaoCallbackUri(req, {KAKAO_REDIRECT_URI:'https://login.example/kakao/callback'}), 'https://login.example/kakao/callback');
  for (const v of ['javascript:alert(1)','https://user:pass@example.com/kakao/callback','https://example.com/other','https://example.com/kakao/callback?x=1'])
    assert.throws(() => kakaoCallbackUri(req, {KAKAO_REDIRECT_URI:v}));
});
test('callback requires the same-browser state cookie', () => {
  const state='a'.repeat(32);
  assert.ok(matchingStateCookie({headers:{cookie:oauthStateCookie(state)}},state));
  assert.equal(matchingStateCookie({headers:{}},state),false);
  assert.equal(matchingStateCookie({headers:{cookie:oauthStateCookie(state)}},'b'.repeat(32)),false);
  assert.match(oauthStateCookie(state,true), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
});
