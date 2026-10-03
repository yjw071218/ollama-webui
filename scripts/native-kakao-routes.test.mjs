import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
const data = mkdtempSync(path.join(tmpdir(), 'native-kakao-test-'));
process.env.WEBUI_DATA_DIR = data;
const { createApiRoutes } = await import('../server/api.js');
const { closeDatabase } = await import('../server/db.js');
after(() => {
  closeDatabase();
  if (path.dirname(path.resolve(data)) === path.resolve(tmpdir()) && path.basename(data).startsWith('native-kakao-test-'))
    rmSync(data, {recursive:true, force:true});
});
const routes = createApiRoutes({KAKAO_REST_KEY:'test-rest-key', PUBLIC_ORIGIN:'https://example.com'});
async function call(url, {body, cookie='', method=body ? 'POST' : 'GET'} = {}) {
  const req = Readable.from(body ? [JSON.stringify(body)] : []);
  req.url = url; req.method = method;
  req.headers = {host:'example.com', cookie, 'content-type':'application/json', 'x-session-id':'new'};
  req.socket = {remoteAddress:'127.0.0.1'};
  const headers = {};
  const res = {statusCode:200, body:'',
    setHeader(k,v) {headers[k.toLowerCase()] = v;},
    getHeader(k) {return headers[k.toLowerCase()];},
    writeHead(status, extra={}) {this.statusCode=status; for(const [k,v] of Object.entries(extra)) this.setHeader(k,v);},
    end(body='') {this.body=String(body);},
  };
  const route = routes.find(r=>r.path === new URL(url,'https://example.com').pathname);
  assert.ok(route, url);
  await route.handler(req,res);
  return {...res, headers, json:()=>JSON.parse(res.body)};
}
async function start() {
  const started = (await call('/api/auth/native/kakao/start',{body:{}})).json();
  const response = await call('/api/auth/native/kakao?id='+started.id);
  assert.equal(response.statusCode,302);
  const target = new URL(response.headers.location);
  assert.equal(target.origin,'https://kauth.kakao.com');
  assert.equal(target.searchParams.get('redirect_uri'),'https://example.com/kakao/callback');
  return {...started,state:target.searchParams.get('state'),cookie:response.headers['set-cookie'].split(';')[0]};
}
test('Kakao starts directly at provider and rejects unknown handoffs and wrong poll secrets', async () => {
  const pending = await start();
  assert.equal((await call('/api/auth/native/kakao?id='+'f'.repeat(64))).statusCode,400);
  assert.equal((await call('/api/auth/native/kakao/poll',{body:{id:pending.id,secret:'wrong'}})).statusCode,400);
  assert.deepEqual((await call('/api/auth/native/kakao/poll',{body:pending})).json(),{pending:true});
});
test('Kakao callback requires browser cookie, carries cancellation to app, and consumes once', async () => {
  const pending = await start();
  const url = '/kakao/callback?error=access_denied&state='+pending.state;
  await call(url);
  assert.deepEqual((await call('/api/auth/native/kakao/poll',{body:pending})).json(),{pending:true});
  await call(url,{cookie:pending.cookie});
  const result = await call('/api/auth/native/kakao/poll',{body:pending});
  assert.equal(result.statusCode,400);
  assert.match(result.json().error,/취소/);
  assert.equal((await call('/api/auth/native/kakao/poll',{body:pending})).statusCode,400);
});
test('verified Kakao callback creates session only on app polling, never in external browser', async () => {
  const pending = await start();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth/token'))
      return {ok:true,json:async()=>({access_token:'test-token',expires_in:3600})};
    if (String(url).endsWith('/v2/user/me'))
      return {ok:true,json:async()=>({id:12345,kakao_account:{profile:{nickname:'Test user'}}})};
    throw new Error('Unexpected network request');
  };
  try {
    const response = await call('/kakao/callback?code=test-code&state='+pending.state,{cookie:pending.cookie});
    assert.equal(response.statusCode,200);
    assert.match(response.body,/로그인되었습니다/);
    assert.ok(!String(response.headers['set-cookie']).includes('webui_session='));
    const result = await call('/api/auth/native/kakao/poll',{body:pending});
    assert.equal(result.statusCode,200);
    assert.ok(result.json().sessionId);
    assert.ok(result.headers['set-cookie']);
    assert.equal((await call('/api/auth/native/kakao/poll',{body:pending})).statusCode,400);
  } finally {globalThis.fetch=oldFetch;}
});
