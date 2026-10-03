import { test } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createGoogleHandoffs, nativeGooglePage } from '../server/nativeGoogle.js';
import { verifyGoogleIdToken } from '../server/social.js';
import { startProxy } from '../native/desktop/proxy.mjs';

test('handoff requires app secret and verified nonce, consumes once', async () => {
  const flow = createGoogleHandoffs();
  const {id, secret} = flow.start();
  assert.notEqual(id, secret);
  assert.throws(() => flow.poll(id, id), /proof/);
  assert.deepEqual(flow.poll(id, secret), {pending:true});
  await assert.rejects(flow.finish(id, 'bad', async () => {throw new Error('bad token');}));
  await flow.finish(id, 'verified-token', async (token, nonce) => {
    assert.equal(token, 'verified-token'); assert.equal(nonce, id);
  });
  await assert.rejects(flow.finish(id, 'replacement', async () => {}), /already/);
  assert.deepEqual(flow.poll(id, secret), {credential:'verified-token'});
  assert.throws(() => flow.poll(id, secret), /expired/);
});
test('handoffs expire and memory is bounded', () => {
  let time = 0;
  const flow = createGoogleHandoffs({now:()=>time, ttl:10, limit:1});
  const {id, secret} = flow.start();
  assert.throws(() => flow.start(), /Too many/);
  time = 10;
  assert.throws(() => flow.poll(id, secret), /expired/);
  assert.ok(flow.start().id);
});
test('page escapes client config and never puts credentials in URLs', () => {
  const page = nativeGooglePage('</script><script>bad()');
  assert.ok(!page.includes('</script><script>bad()'));
  assert.ok(page.includes('nonce: id'));
  assert.ok(page.includes("history.replaceState"));
});
test('legacy native page does not enforce origin policy locally (not a provider acceptance test)', () => {
  const script = nativeGooglePage('client').match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [protocol, hostname, hash, allowed] of [
    ['http:', '0.0.0.0.nip.io', '#' + 'a'.repeat(64), true], ['https:', 'example.com', '#' + 'a'.repeat(64), true],
    ['http:', 'localhost', '#' + 'a'.repeat(64), true], ['http:', 'example.com', '#bad', false],
    ['http:', 'localhost', '#' + 'a'.repeat(64) + '&app=android', true],
  ]) {
    const status = {textContent:''};
    let initialized = false;
    const context = {
      location: {protocol, hostname, origin: protocol + '//' + hostname, hash, pathname:'/api/auth/native/page'},
      history: {replaceState() {}}, document: {getElementById:()=>status}, window: {},
      google: {accounts:{id:{initialize(){initialized=true;}, renderButton(){}}}},
    };
    vm.runInNewContext(script, context);
    context.window.ready();
    assert.equal(initialized, allowed);
    if (allowed) assert.ok(status.textContent.includes(protocol + '//' + hostname));
  }
});
test('Google verifier rejects missing audience, mismatched nonce, invalid expiry', async () => {
  await assert.rejects(verifyGoogleIdToken('token', ''), /not configured/);
  const previous = globalThis.fetch;
  let payload = {aud:'client', iss:'https://accounts.google.com', sub:'123', exp:Date.now()/1000+60, nonce:'expected'};
  globalThis.fetch = async () => ({ok:true, json:async()=>payload});
  try {
    await assert.rejects(verifyGoogleIdToken('token','other','expected'), /different application/);
    await assert.rejects(verifyGoogleIdToken('token','client','wrong'), /nonce/);
    assert.equal((await verifyGoogleIdToken('token','client','expected')).providerId, '123');
    payload = {...payload, exp:'invalid'};
    await assert.rejects(verifyGoogleIdToken('token','client','expected'), /expired/);
  } finally {globalThis.fetch = previous;}
});
test('native metadata requires gateway authentication', async () => {
  const gateway = await startProxy('http://127.0.0.1:1');
  try {
    assert.equal((await fetch(gateway.origin + '/__native/info')).status, 403);
    const response = await fetch(gateway.origin + '/__native/info', {headers:{'X-Native-Gateway':gateway.token}});
    assert.deepEqual(await response.json(), {nativeGoogle:true,nativeKakao:true});
  } finally {await gateway.close();}
});
