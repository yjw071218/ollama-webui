// One address, and what happens to everyone who is not on it.
//
// A browser keys IndexedDB, localStorage and cookies to an origin — scheme,
// host and port together. This server answers on several addresses at once
// (localhost, its LAN address, a nip.io hostname, a public one) and every one
// of them is a separate website as far as the browser is concerned: separate
// chats, separate settings, separate login. The server's own database is one
// file throughout; it is the browser that splits, and no server code can undo
// that.
//
// What can be done is to name one address and point everything at it, which is
// what PUBLIC_ORIGIN is. Checked here: that a value typed by a human turns into
// a real origin whatever shape it was typed in, that rubbish is refused rather
// than half-accepted, and that the app is actually told what it is.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normaliseOrigin, isCanonical } from '../server/origin.js';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-origin-'));
process.env.WEBUI_DATA_DIR = DATA;

const { closeDatabase } = await import('../server/db.js');
process.on('exit', () => {
  try { closeDatabase(); } catch (e) { /* never opened */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
});

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------- what a human might type */

const WANT = 'http://203.0.113.7.nip.io:5173';

// The shapes someone actually writes, all meaning the same address. The
// bare host is the one that needs the care: `new URL` reads the first colon as
// a scheme separator, so `host:5173` parses as scheme `host` unless something
// puts a `//` in front of it first.
eq('a bare host', normaliseOrigin('203.0.113.7.nip.io'), WANT);
eq('a host and port', normaliseOrigin('203.0.113.7.nip.io:5173'), WANT);
eq('a full origin', normaliseOrigin('http://203.0.113.7.nip.io:5173'), WANT);
eq('with a trailing slash', normaliseOrigin('http://203.0.113.7.nip.io:5173/'), WANT);
eq('with a path, which is not part of an origin',
  normaliseOrigin('http://203.0.113.7.nip.io:5173/chat?x=1'), WANT);
eq('surrounded by whitespace', normaliseOrigin('  203.0.113.7.nip.io  '), WANT);

/* --------------------------------------------------- the port comes from us */

eq('the server port fills in when none was given',
  normaliseOrigin('example.test', { port: 8080 }), 'http://example.test:8080');
eq('an explicit port wins over the server port',
  normaliseOrigin('example.test:9999', { port: 8080 }), 'http://example.test:9999');
eq('https is carried through', normaliseOrigin('https://example.test:5173'), 'https://example.test:5173');
eq('and can be asked for', normaliseOrigin('example.test', { scheme: 'https', port: 5173 }),
  'https://example.test:5173');

// A default port is not written down, because a browser does not write it down
// either: `http://x` and `http://x:80` are one origin and the string a page
// reports for both is the short one. Emitting the long form would make the
// app's own comparison fail against the very address it was told to use.
eq('port 80 is left off http', normaliseOrigin('http://example.test:80'), 'http://example.test');
eq('port 443 is left off https', normaliseOrigin('https://example.test:443'), 'https://example.test');
eq('but 443 on http is not a default', normaliseOrigin('http://example.test:443'), 'http://example.test:443');
eq('an IPv6 literal keeps its brackets', normaliseOrigin('[::1]:5173'), 'http://[::1]:5173');

/* ------------------------------------------------------------- and rubbish */

// Empty is the ordinary state, not an error: nearly every install has no
// canonical address and every address it answers on is then equally right.
eq('nothing configured', normaliseOrigin(''), '');
eq('whitespace only', normaliseOrigin('   '), '');
eq('undefined', normaliseOrigin(undefined), '');
eq('null', normaliseOrigin(null), '');

// Refused rather than half-accepted. A value that cannot be compared against
// `window.location.origin` would make the app nag on every load, at every
// address, with no way to satisfy it.
eq('a scheme that is not the web', normaliseOrigin('ftp://example.test'), '');
eq('a file url', normaliseOrigin('file:///c:/tmp'), '');
eq('a bare port', normaliseOrigin(':5173'), '');

/* ------------------------------------------------------- who is out of place */

check('with none configured, every address is right', isCanonical('', 'http://localhost:5173'));
check('the canonical address is right', isCanonical(WANT, WANT));
check('another host is not', !isCanonical(WANT, 'http://localhost:5173'));
check('nor is the same host on another port', !isCanonical(WANT, 'http://203.0.113.7.nip.io:5174'));
check('nor the same host over https', !isCanonical(WANT, 'https://203.0.113.7.nip.io:5173'));

/* ------------------------------------------------- the app is actually told */

const { createApiRoutes } = await import('../server/api.js');

const serve = async (env) => {
  const routes = createApiRoutes(env);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const match = routes.find(r => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`));
    if (!match) { res.statusCode = 404; res.end('{}'); return; }
    match.handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // `connection: close` because fetch otherwise keeps the socket alive for
  // reuse, and a live socket to a server being torn down is what turns the end
  // of this file into a libuv assertion on Windows rather than a result. The
  // close is awaited for the same reason.
  const body = await (await fetch(`http://127.0.0.1:${port}/api/config`, {
    headers: { connection: 'close' },
  })).json();
  await new Promise(resolve => server.close(resolve));
  return body;
};

let config = await serve({ PUBLIC_ORIGIN: '203.0.113.7.nip.io', PORT: '5173' });
eq('/api/config carries the canonical origin', config.canonicalOrigin, WANT);

config = await serve({});
eq('and an empty string when there is none', config.canonicalOrigin, '');

// Configuring an address must not disturb anything else the client reads from
// this route, because the sign-in buttons are drawn from the same answer.
check('the rest of the config survives it',
  config.sync === 'records' && config.accounts === true && config.passkeys === true);

console.log(`\n${pass} passed, ${fail} failed`);
// `exitCode` rather than `exit()`: forcing the process down while the servers
// above are still finishing their teardown aborts it with a libuv assertion,
// and an aborted run takes the rest of `npm test` down with it. Setting the
// code and letting the loop drain reports the same result and survives.
process.exitCode = fail ? 1 : 0;
