// Two tabs, two people, one browser.
//
// The bug this covers: opening the app twice and signing out of one signed out
// the other. That is what a cookie does — it belongs to an origin, not to a
// tab — so a cookie holding one session makes every tab a single identity, and
// there was no way to have two accounts open at once at all.
//
// The cookie now holds a set of sessions and each tab names the one it is
// using, in a header. What has to hold:
//
//   * two tabs opened on the *same* account are two sessions, so signing out of
//     one leaves the other signed in — the literal reported bug
//   * two tabs can be two different accounts, at the same time
//   * signing out of one ends that session and nothing else
//   * a tab that names a session it cannot have gets nobody, never a fallback
//     to whichever account happens to be next in the cookie
//   * a newly opened tab lands on the account already in use, holding a session
//     of its own rather than a share of another tab's
//   * signing in again in a tab still replaces that tab's session id, because
//     fixation did not stop being a thing
//   * the CSRF token is per session, so one tab's cannot act for another's
//   * "sign out other devices", a password change and account deletion reach
//     the right sessions and leave the rest standing

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-tabs-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase } = await import('../server/db.js');

process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

const { createApiRoutes } = await import('../server/api.js');
const { MAX_SESSIONS } = await import('../server/session.js');

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

/* --------------------------------------------------- a browser, and its tabs */

/**
 * One cookie jar with several tabs on it.
 *
 * This shape is the test: the jar is shared, because that is what a browser
 * does, and everything that makes the tabs separate has to come from somewhere
 * else. If the separation were in the cookie it would not be separation at all.
 */
const makeBrowser = () => {
  const jar = new Map();

  const applySetCookie = (lines) => {
    for (const line of lines || []) {
      const [pair, ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const maxAge = attrs.map(a => a.trim()).find(a => a.toLowerCase().startsWith('max-age='));
      if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name);
      else jar.set(name, value);
    }
  };

  const tab = () => {
    // What a tab holds, and all it holds: the id of a session, and the token
    // that session issued. Neither is the session itself. A tab starts by
    // asking for one of its own, which is what a newly opened tab does.
    let sessionId = 'new';
    let csrf = null;

    const request = async (method, routePath, body, extra = {}) => {
      const headers = { ...extra };
      if (jar.size) headers.cookie = [...jar].map(([n, v]) => `${n}=${v}`).join('; ');
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf && method !== 'GET' && !('x-csrf-token' in headers)) headers['x-csrf-token'] = csrf;
      if (!('x-session-id' in headers)) headers['x-session-id'] = sessionId || 'new';

      const res = await fetch(ORIGIN + routePath, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      applySetCookie(res.headers.getSetCookie?.() || []);

      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
      if (json?.csrfToken) csrf = json.csrfToken;
      if (json?.sessionId) sessionId = json.sessionId;
      return { status: res.status, body: json };
    };

    return {
      get sessionId() { return sessionId; },
      set sessionId(value) { sessionId = value; },
      get csrf() { return csrf; },
      set csrf(value) { csrf = value; },
      /** What the app does when someone chooses to add an account. */
      becomeGuest() { sessionId = 'guest'; csrf = null; },
      /** A tab opened from scratch: no session of its own, yet. */
      reopen() { sessionId = 'new'; csrf = null; },
      get: (p, h) => request('GET', p, undefined, h),
      post: (p, b, h) => request('POST', p, b ?? {}, h),
    };
  };

  return { jar, tab, cookie: () => jar.get('webui_session') || null };
};

const browser = makeBrowser();

/* ------------------------------------------------- two accounts, two tabs */

const first = browser.tab();
let r = await first.post('/api/auth/register', {
  name: 'Mina', email: 'mina@example.com', password: 'a long enough password',
});
eq('the first tab registers an account', r.status, 200);
const minaId = r.body.user.id;
check('and is told which session is its own', !!r.body.sessionId);
check('which is not the cookie', r.body.sessionId !== browser.cookie());

/* --------------------------------------- the reported bug: one account, two tabs */

// Open the app a second time. Nothing is chosen, nothing is added — this is
// somebody typing the address again — and it has to land on the account already
// in use, holding a session of its own.
const sameAccount = browser.tab();
r = await sameAccount.get('/api/auth/session');
eq('a second tab lands on the account already signed in', r.body.user?.id, minaId);
check('but holds a session of its own', !!r.body.sessionId && r.body.sessionId !== first.sessionId);

r = await sameAccount.post('/api/auth/logout');
eq('signing out of the second tab succeeds', r.status, 200);
eq('and leaves a session behind', r.body.remaining, 1);

// This is the bug, stated. Before the fork the two tabs shared one session, and
// a tab cannot sign itself out of a session another tab is using.
r = await first.get('/api/auth/session');
eq('the first tab is still signed in', r.body.user?.id, minaId);

sameAccount.becomeGuest();
eq('while the tab that signed out is not', (await sameAccount.get('/api/auth/session')).body.user, null);

/* ------------------------------------------------- two accounts, two tabs */

// A third tab, saying it is nobody — which is what "add an account" does.
const second = browser.tab();
second.becomeGuest();

r = await second.get('/api/auth/session');
eq('a tab that says it is the guest is the guest', r.body.user, null);
eq('even though the browser holds a session', browser.cookie() !== null, true);
eq('and it can see the account it could switch to', r.body.accounts.length, 1);
eq('by name', r.body.accounts[0].user.email, 'mina@example.com');

r = await second.post('/api/auth/register', {
  name: 'Junho', email: 'junho@example.com', password: 'another long password',
});
eq('the second tab registers a different account', r.status, 200);
const junhoId = r.body.user.id;
check('and holds a session of its own', !!r.body.sessionId && r.body.sessionId !== first.sessionId);

check('the cookie now carries both', browser.cookie().includes('~'));

// The whole point.
r = await first.get('/api/auth/session');
eq('the first tab is still the first account', r.body.user?.id, minaId);
r = await second.get('/api/auth/session');
eq('and the second is the second', r.body.user?.id, junhoId);
eq('each tab can see both accounts', r.body.accounts.length, 2);

/* ------------------------------------------------------------ signing out */

const minaSession = first.sessionId;
r = await first.post('/api/auth/logout');
eq('the first tab signs out', r.status, 200);
eq('and is told a session remains', r.body.remaining, 1);

first.becomeGuest();
r = await first.get('/api/auth/session');
eq('so that tab is nobody', r.body.user, null);

// The failure this file exists for.
r = await second.get('/api/auth/session');
eq('and the other tab is untouched', r.body.user?.id, junhoId);
check('the browser still holds its session', !!browser.cookie());

/* ------------------------------------------- naming a session you cannot have */

// The dead one, offered again. A fallback here would hand this tab somebody
// else's account, which is the failure mode that makes fallbacks wrong.
first.sessionId = minaSession;
r = await first.get('/api/auth/session');
eq('a tab naming an ended session gets nobody', r.body.user, null);
check('not the account next to it in the cookie', r.body.user?.id !== junhoId);

first.sessionId = 'not-a-real-session';
r = await first.get('/api/auth/session');
eq('an invented session id gets nobody too', r.body.user, null);

r = await first.get('/api/auth/sync?since=0');
eq('and reads no data', r.status, 401);

/* ------------------------------------------------------------- a fresh tab */

// A newly opened tab should land somewhere useful rather than on a sign-in
// screen, and what it lands on must be its own.
const fresh = browser.tab();
r = await fresh.get('/api/auth/session');
eq('a newly opened tab gets the account in use', r.body.user?.id, junhoId);
const freshSession = r.body.sessionId;
check('on a session of its own', !!freshSession && freshSession !== second.sessionId);

// Asking again does not mint a third: the tab holds one now and says so.
r = await fresh.get('/api/auth/session');
eq('and asking again keeps it', r.body.sessionId, freshSession);

r = await fresh.post('/api/auth/logout');
eq('closing that tab down ends only its own', r.status, 200);
eq('so the tab it opened beside is untouched', (await second.get('/api/auth/session')).body.user?.id, junhoId);

/* ------------------------------------------------------------- switching */

// Mina signs in again, in the tab that had signed out.
first.sessionId = null;
first.csrf = null;
first.becomeGuest();
r = await first.post('/api/auth/login', { email: 'mina@example.com', password: 'a long enough password' });
eq('signing in again works', r.status, 200);
check('and opens a new session, not the ended one', r.body.sessionId !== minaSession);
eq('the other tab is still itself', (await second.get('/api/auth/session')).body.user?.id, junhoId);

// Switching costs no sign-in: the account is already signed in here. What it
// must not do is adopt the session the other tab is holding — that would put
// the two back to sharing one, and the next sign-out in either would take both.
const junhoSession = second.sessionId;
second.sessionId = `new:${first.sessionId}`;
second.csrf = null;
r = await second.get('/api/auth/session');
eq('a tab can switch to an account already signed in', r.body.user?.id, minaId);
check('on a session of its own', r.body.sessionId !== first.sessionId);
eq('and the tab it switched onto is untouched',
  (await first.get('/api/auth/session')).body.user?.id, minaId);

// Signing out of the switched tab must not reach the tab it borrowed from.
r = await second.post('/api/auth/logout');
eq('signing out of the switched tab succeeds', r.status, 200);
eq('and the account is still signed in elsewhere',
  (await first.get('/api/auth/session')).body.user?.id, minaId);

second.sessionId = junhoSession;
second.csrf = null;
r = await second.get('/api/auth/session');
eq('and switching back finds the other account where it was', r.body.user?.id, junhoId);

/* ------------------------------------------------- signing in twice in a tab */

// Fixation: whatever session a tab arrives with is not the one it leaves with.
// And signing in again is a replacement, not an addition — a tab that already
// holds a session does not collect a second one by signing in twice.
const sessionCount = (await first.get('/api/auth/session')).body.accounts.length;
const before = first.sessionId;
r = await first.post('/api/auth/login', { email: 'mina@example.com', password: 'a long enough password' });
eq('a tab signing in again succeeds', r.status, 200);
check('and its session id is replaced', r.body.sessionId !== before);
eq('without the browser holding one more', r.body.accounts.length, sessionCount);

const signedIn = first.sessionId;
first.sessionId = before;
r = await first.get('/api/auth/session');
eq('the replaced one is gone', r.body.user, null);
first.sessionId = signedIn;
eq('and the other tab survived it', (await second.get('/api/auth/session')).body.user?.id, junhoId);

/* ------------------------------------------------------------------- CSRF */

// One token per session, so a tab cannot act as the account in the next tab
// even though the browser is sending both sessions on every request.
r = await second.post('/api/auth/profile', { name: 'Junho K' }, { 'x-csrf-token': first.csrf });
eq("one tab's CSRF token cannot act for another's session", r.status, 403);
eq('and says why', r.body.code, 'csrf');

r = await second.post('/api/auth/profile', { name: 'Junho K' });
eq('its own token is accepted', r.status, 200);
eq('and changed the right account', r.body.user.name, 'Junho K');

r = await first.get('/api/auth/session');
eq('the other account is untouched', r.body.user.name, 'Mina');

/* ------------------------------------------------------------ what ends what */

// A second browser signed into Mina, so "sign out other devices" has something
// to end that is not one of these tabs.
const phone = makeBrowser();
const phoneTab = phone.tab();
r = await phoneTab.post('/api/auth/login', { email: 'mina@example.com', password: 'a long enough password' });
eq('a phone signs in as the first account', r.status, 200);

r = await first.post('/api/auth/logout-others');
eq('the first tab ends its other sessions', r.status, 200);
check('and there was one to end', r.body.ended >= 1);

eq('so the phone is signed out', (await phoneTab.get('/api/auth/session')).body.user, null);
eq('the tab that asked stays signed in', (await first.get('/api/auth/session')).body.user?.id, minaId);
// It is a different account, so it was never "other" in the first place.
eq('and the other account in this browser is untouched',
  (await second.get('/api/auth/session')).body.user?.id, junhoId);

// A password change ends the account's other sessions for the same reason, and
// with the same limit.
r = await first.post('/api/auth/password', {
  currentPassword: 'a long enough password', newPassword: 'a replacement password',
});
eq('the password changes', r.status, 200);
eq('and the other account carries on', (await second.get('/api/auth/session')).body.user?.id, junhoId);

/* ----------------------------------------------------------- the cookie cap */

// A tab is a session, so opening tabs is what fills the cookie, and it cannot be
// allowed to fill without bound. The oldest goes — and goes from the server too,
// rather than merely from the cookie, because a session no browser can present
// is one nobody can revoke.
const crowded = makeBrowser();
const opener = crowded.tab();
r = await opener.post('/api/auth/register', {
  name: 'Sora', email: 'sora@example.com', password: 'a perfectly long password',
});
eq('an account to open tabs on', r.status, 200);

const opened = [{ tab: opener, sessionId: opener.sessionId }];
for (let i = 0; i < MAX_SESSIONS + 1; i++) {
  const t = crowded.tab();
  const made = await t.get('/api/auth/session');
  opened.push({ tab: t, sessionId: made.body.sessionId });
}

const last = opened[opened.length - 1];
r = await last.tab.get('/api/auth/session');
eq('the browser holds no more sessions than the cap', r.body.accounts.length, MAX_SESSIONS);
eq('and the newest tab is signed in', r.body.user?.email, 'sora@example.com');

r = await opened[0].tab.get('/api/auth/session');
eq('while the oldest tab was dropped', r.body.user, null);

/* ---------------------------------------------------------- account removal */

// Deleting an account takes its sessions with it, and only its own.
r = await second.post('/api/auth/account');
eq('the second account is deleted', r.status, 200);
eq('so its tab is nobody', (await second.get('/api/auth/session')).body.user, null);
eq('while the first tab is still signed in', (await first.get('/api/auth/session')).body.user?.id, minaId);
check('and the browser still has a cookie', !!browser.cookie());

r = await first.post('/api/auth/logout');
eq('the last tab signs out', r.status, 200);
eq('and nothing remains', r.body.remaining, 0);
eq('so the cookie is cleared', browser.cookie(), null);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
