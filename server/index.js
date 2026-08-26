// Production server: serves the built app and the same API the dev server has,
// on an address other machines can reach.
//
// The dev server cannot be used for this. It ships unminified source with
// hot-module sockets attached, and Vite deliberately refuses most non-localhost
// origins. This one serves dist/ and nothing else.
//
// Two things here exist purely because "reachable from outside" changes the
// threat model completely:
//
//   * /localfs reads and writes anywhere this process can reach. On localhost
//     that is a feature. Exposed, it is remote file access on the user's PC,
//     so it is off unless ALLOW_LOCAL_FS=true is set deliberately.
//   * everything else is behind a shared token once the server is not bound to
//     loopback, because the Ollama proxy is otherwise an open LLM endpoint and
//     the Kakao exchange holds a client secret.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApiRoutes } from './api.js';
import { isPrivateAddress, localAddresses } from './net.js';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

// ---------------------------------------------------------------- settings

// Read .env directly: this runs outside Vite, so loadEnv is not available.
const loadDotEnv = () => {
  const out = { ...process.env };
  for (const name of ['.env', '.env.local']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || line.trim().startsWith('#')) continue;
      // Environment variables already set win, so a one-off override works.
      if (out[match[1]] === undefined) {
        out[match[1]] = match[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      }
    }
  }
  return out;
};

const env = loadDotEnv();

const PORT = Number(env.PORT || 8080);
const HOST = env.HOST || '0.0.0.0';
const OLLAMA = env.OLLAMA_URL || 'http://127.0.0.1:11434';
const TTS = `http://${env.TTS_HOST || '127.0.0.1'}:${env.TTS_PORT || 9880}`;
const ALLOW_LOCAL_FS = String(env.ALLOW_LOCAL_FS || '').toLowerCase() === 'true';
const TOKEN = (env.ACCESS_TOKEN || '').trim();

// Bound to loopback, the only client is this machine and a token is friction
// for nothing. Bound anywhere else, it is the entire access control.
const LOOPBACK_ONLY = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const REQUIRE_TOKEN = !LOOPBACK_ONLY && TOKEN.length > 0;

// Your own wifi is a boundary you already control, and a phone should not have
// to be handed a 32-character token to open a page on it. Requests arriving
// from a private address skip the token; anything routed in from outside still
// presents it. Turn this off on a network you do not trust — a café, a shared
// office — where "same network" means nothing.
const TRUST_LAN = String(env.TRUST_LAN ?? 'true').toLowerCase() !== 'false';

if (!LOOPBACK_ONLY && !TOKEN) {
  console.error([
    '',
    'Refusing to start: HOST is not loopback and ACCESS_TOKEN is empty.',
    '',
    'Bound to ' + HOST + ', this server is reachable by anything that can route',
    'to it, and it proxies your Ollama. Set a token in .env:',
    '',
    '  ACCESS_TOKEN=' + crypto.randomBytes(24).toString('base64url'),
    '',
    'Or set HOST=127.0.0.1 to keep it on this machine.',
    '',
  ].join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------- helpers

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8',
};

// Constant time, so a wrong token cannot be narrowed down by how long the
// comparison took.
const tokenMatches = (given) => {
  if (!given || given.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
};

const presentedToken = (req, url) =>
  (req.headers['x-access-token'] || '').toString()
  || url.searchParams.get('token')
  || (req.headers.cookie || '').match(/(?:^|;\s*)access_token=([^;]*)/)?.[1]
  || '';

const proxy = (target, req, res, rewrite = (p) => p) => {
  const upstream = new URL(target);
  const url = new URL(req.url, 'http://placeholder');
  const options = {
    hostname: upstream.hostname,
    port: upstream.port,
    path: rewrite(url.pathname) + url.search,
    method: req.method,
    // Host must be the upstream's, not ours, or Ollama rejects the request.
    headers: { ...req.headers, host: upstream.host },
  };
  delete options.headers['x-access-token'];
  delete options.headers.cookie;

  const client = upstream.protocol === 'https:' ? https : http;
  const forwarded = client.request(options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  forwarded.on('error', (e) => {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Upstream ${upstream.host} unreachable: ${e.message}` }));
  });
  req.pipe(forwarded);
};

const serveStatic = (req, res, url) => {
  // Resolve, then check containment: '..' in a URL must not escape dist/.
  const requested = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (!requested.startsWith(DIST)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let file = requested;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Single-page app: unknown paths are routes, not missing files.
    file = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    res.end('Build not found. Run `npm run build` first.');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  // Hashed asset names may be cached hard; index.html must never be.
  res.setHeader('Cache-Control', file.endsWith('index.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
};

const LOGIN_PAGE = (message = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111418;color:#e6e6e6;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
form{width:min(360px,90vw);padding:2rem;background:#1a1e24;border:1px solid #2a3038;border-radius:12px}
h1{margin:0 0 .35rem;font-size:1.15rem}p{margin:0 0 1.25rem;color:#95a0ad;font-size:.85rem}
input{width:100%;box-sizing:border-box;padding:.6rem .7rem;margin-bottom:.85rem;border-radius:8px;
border:1px solid #2f3742;background:#12161b;color:inherit;font:inherit}
button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#4f8cff;color:#fff;font:inherit;cursor:pointer}
.err{color:#ff8080;font-size:.85rem;margin-bottom:.75rem}
</style></head><body>
<form method="POST" action="/__auth">
<h1>Ollama WebUI</h1>
<p>This server is reachable from outside the machine, so it needs the access token.</p>
${message ? `<div class="err">${message}</div>` : ''}
<input type="password" name="token" placeholder="Access token" autofocus autocomplete="current-password">
<button type="submit">Sign in</button>
</form></body></html>`;

// ---------------------------------------------------------------- routing

const apiRoutes = createApiRoutes(env, { allowLocalFs: ALLOW_LOCAL_FS });

const handler = (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Judged on the socket's peer address only: X-Forwarded-For is a header the
  // caller writes, so believing it would let anyone claim to be on the LAN.
  const fromLan = TRUST_LAN && isPrivateAddress(req.socket?.remoteAddress);

  if (REQUIRE_TOKEN && !fromLan) {
    // Exchanging the token for a cookie keeps it out of every later URL.
    if (url.pathname === '/__auth' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        const given = new URLSearchParams(body).get('token') || '';
        if (!tokenMatches(given)) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(LOGIN_PAGE('That token was not accepted.'));
          return;
        }
        res.writeHead(302, {
          // No Secure flag: over plain HTTP the browser would drop it and the
          // sign-in would loop. Put a TLS terminator in front for that.
          'Set-Cookie': `access_token=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          Location: '/',
        });
        res.end();
      });
      return;
    }

    if (!tokenMatches(presentedToken(req, url))) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE());
      return;
    }
  }

  // Longest match first, so /api/tts-status is not swallowed by /api.
  const route = apiRoutes
    .filter(r => url.pathname === r.path || url.pathname.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (route) return route.handler(req, res);

  // Without this the disabled filesystem routes fall through to the SPA
  // fallback and answer 200 with the app's HTML, which reads like they worked.
  if (url.pathname.startsWith('/localfs/')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Local file access is disabled on this server. Set ALLOW_LOCAL_FS=true only if every client is trusted.',
    }));
    return;
  }

  if (url.pathname.startsWith('/tts-api')) {
    return proxy(TTS, req, res, p => p.replace(/^\/tts-api/, '') || '/');
  }
  if (url.pathname.startsWith('/api/')) return proxy(OLLAMA, req, res);

  return serveStatic(req, res, url);
};

// ---------------------------------------------------------------- listen

const key = env.TLS_KEY_FILE;
const cert = env.TLS_CERT_FILE;
const useTls = key && cert && fs.existsSync(key) && fs.existsSync(cert);

const server = useTls
  ? https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = useTls ? 'https' : 'http';
  console.log('');
  console.log(`  Ollama WebUI  ${scheme}://${HOST}:${PORT}`);
  console.log(`  serving       ${DIST}`);
  console.log(`  ollama        ${OLLAMA}`);
  console.log(`  auth          ${REQUIRE_TOKEN
    ? (TRUST_LAN ? 'token required from outside this network' : 'token required')
    : 'off (loopback only)'}`);
  console.log(`  local files   ${ALLOW_LOCAL_FS ? 'ENABLED — read/write on this machine' : 'disabled'}`);
  if (!LOOPBACK_ONLY) {
    const addresses = localAddresses(os.networkInterfaces());
    if (addresses.length > 0) {
      console.log('');
      console.log('  On this network — open on a phone:');
      for (const address of addresses) console.log(`    ${scheme}://${address}:${PORT}`);
      if (REQUIRE_TOKEN && !TRUST_LAN) {
        console.log('');
        console.log('  TRUST_LAN=false, so these still ask for the token.');
      }
    }
  }
  if (!useTls && !LOOPBACK_ONLY) {
    console.log('');
    console.log('  Plain HTTP: everything typed crosses the network unencrypted.');
    console.log('  See server/README.md for putting TLS in front of it.');
  }
  console.log('');
});
