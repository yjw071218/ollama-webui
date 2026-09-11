// The doorbell: telling an account's other devices that something changed.
//
// Before this existed, a device found out by asking, every fifteen seconds, and
// only while its page was visible. On a desktop that is a delay. On a phone it
// is a failure: the browser suspends the timers of a page that is not in front,
// so a change made on a laptop reached the phone on its next poll after being
// picked up — if the poll had not been throttled out of existence altogether.
// Two windows of one desktop browser hid the whole problem, because they share
// a local database and read each other's writes without syncing at all.
//
// What is checked here is the contract the client depends on:
//
//   * a signed-in device gets a stream, and an anonymous one gets a clean 204
//     rather than an error it would reconnect to forever;
//   * an upload that changed something wakes the account's other streams;
//   * an upload that changed nothing wakes nobody;
//   * the uploading tab can recognise its own bell and ignore it;
//   * one account's writes never reach another account's stream;
//   * a device that hangs up is forgotten rather than written to for ever.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-live-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase } = await import('../server/db.js');
process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const { createApiRoutes } = await import('../server/api.js');
const { listenerCount } = await import('../server/liveSync.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------------ server */

const routes = createApiRoutes({});
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const match = routes.find(r => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`));
  if (!match) { res.statusCode = 404; res.end('{}'); return; }
  match.handler(req, res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ clients */

const makeClient = () => {
  const jar = new Map();
  let csrf = null;

  const request = async (method, routePath, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;

    const res = await fetch(ORIGIN + routePath, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const zero = attrs.map(a => a.trim().toLowerCase()).includes('max-age=0');
      if (zero) jar.delete(name); else jar.set(name, pair.slice(at + 1).trim());
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (json?.csrfToken) csrf = json.csrfToken;
    return { status: res.status, body: json };
  };

  return {
    cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b ?? {}, h),
  };
};

/**
 * An open event stream, read as it arrives.
 *
 * Deliberately not `EventSource` — there is none in Node — and deliberately
 * not buffered to completion, because the response never completes. That is
 * the property under test.
 */
const openStream = async (client, sessionId = '') => {
  const controller = new AbortController();
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
  const res = await fetch(`${ORIGIN}/api/auth/events${query}`, {
    headers: { cookie: client.cookieHeader() },
    signal: controller.signal,
  });

  const events = [];
  let buffer = '';

  const pump = (async () => {
    if (!res.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // Frames are separated by a blank line. Comments (': ping') carry no
        // event and are what the client's transport swallows for us.
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name && data) events.push({ name, data: JSON.parse(data) });
        }
      }
    } catch (e) { /* aborted, which is how a client hangs up */ }
  })();

  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    events,
    close: async () => { controller.abort(); await pump; },
  };
};

/** Streams are asynchronous; give the frame a moment to cross the socket. */
const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

const chat = (id, at, title) => ({
  kind: 'chat', id, updatedAt: at, payload: { id, title, updatedAt: at },
});

/* ------------------------------------------------------------- two devices */

const laptop = makeClient();
let r = await laptop.post('/api/auth/register', {
  name: 'Ada', email: 'ada@example.com', password: 'a sufficiently long one',
});
eq('the account is created', r.status, 200);
const owner = r.body.user.id;

// A second sign-in on the same account from somewhere else. Its own cookie jar
// is the point: this is another device, not another tab.
const phone = makeClient();
r = await phone.post('/api/auth/login', {
  email: 'ada@example.com', password: 'a sufficiently long one',
});
eq('the phone signs in to the same account', r.body.user.id, owner);

/* ------------------------------------------------------- a stream is a stream */

const stranger = await openStream(makeClient());
eq('an anonymous request is ended cleanly, not refused', stranger.status, 204);
await stranger.close();

const phoneStream = await openStream(phone);
eq('a signed-in device gets a stream', phoneStream.status, 200);
check('served as events', phoneStream.contentType.startsWith('text/event-stream'),
  phoneStream.contentType);
await settle();
eq('and the account has it on file', listenerCount(owner), 1);

/* ------------------------------------------------- a change rings the doorbell */

r = await laptop.post('/api/auth/sync', {
  since: 0, ownerId: owner, records: [chat('c1', 1000, 'written on the laptop')],
});
eq('the laptop uploads', r.status, 200);
const revAfterFirst = r.body.rev;

await settle();
eq('the phone is told, once', phoneStream.events.length, 1);
eq('and told what it is', phoneStream.events[0]?.name, 'rev');
eq('and which revision to catch up to', phoneStream.events[0]?.data.rev, revAfterFirst);

// The whole point: the phone can now fetch exactly what it is missing, and the
// number it was given is the number the fetch agrees with.
r = await phone.post('/api/auth/sync', { since: 0, ownerId: owner, records: [] });
eq('so the phone pulls the chat', r.body.records?.length, 1);
eq('and it is the one that was written', r.body.records[0].payload.title, 'written on the laptop');

/* ------------------------------------------- an upload of nothing rings nobody */

const before = phoneStream.events.length;
r = await laptop.post('/api/auth/sync', { since: revAfterFirst, ownerId: owner, records: [] });
eq('an empty upload succeeds', r.status, 200);
await settle();
eq('and wakes nobody', phoneStream.events.length, before);

// Re-sending a record the server already has at that timestamp is not a change
// either, and a phone woken for it would be a phone woken for nothing.
r = await laptop.post('/api/auth/sync', {
  since: revAfterFirst, ownerId: owner, records: [chat('c1', 1000, 'written on the laptop')],
});
await settle();
eq('nor does re-sending an unchanged record', phoneStream.events.length, before);

/* --------------------------------------------- a device ignores its own bell */

// The tab names itself in the header it already sends; the server echoes that
// name back on the event so the uploader can tell its own writes apart. Without
// it every upload would cost the uploading device a pointless round trip back.
r = await laptop.get('/api/auth/session');
const laptopTab = r.body.sessionId;
check('the laptop knows which session it is', !!laptopTab);

const laptopStream = await openStream(laptop, laptopTab);
await settle();
eq('both devices are listening', listenerCount(owner), 2);

r = await laptop.post('/api/auth/sync', {
  since: revAfterFirst, ownerId: owner, records: [chat('c2', 2000, 'second')],
}, { 'x-session-id': laptopTab });
eq('the laptop uploads again', r.status, 200);
await settle();

eq('the phone hears about it', phoneStream.events.length, before + 1);
eq('the laptop hears its own bell too', laptopStream.events.length, 1);
eq('but it is labelled with the tab that rang it',
  laptopStream.events[0]?.data.origin, laptopTab);

/* ------------------------------------------------ one account, not the others */

const other = makeClient();
r = await other.post('/api/auth/register', {
  name: 'Grace', email: 'grace@example.com', password: 'another long password',
});
const otherOwner = r.body.user.id;
const otherStream = await openStream(other);
await settle();

const adaHeard = phoneStream.events.length;
r = await other.post('/api/auth/sync', {
  since: 0, ownerId: otherOwner, records: [chat('x1', 3000, 'not yours')],
});
eq('the other account uploads', r.status, 200);
await settle();
eq('its own device hears it', otherStream.events.length, 1);
eq("and Ada's phone hears nothing", phoneStream.events.length, adaHeard);

/* ------------------------------------------------------- hanging up is final */

await phoneStream.close();
await settle(200);
eq('a closed stream is forgotten', listenerCount(owner), 1);

await laptopStream.close();
await otherStream.close();
await settle(200);
eq('and so is the last one', listenerCount(owner), 0);
eq('for every account', listenerCount(otherOwner), 0);

/* -------------------------------------------------------------------- done */

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
