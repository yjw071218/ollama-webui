/**
 * Searching Google the way a person does: in Chrome.
 *
 * ## Why
 *
 * Every key-free source this app had was failing a Korean question at once:
 * Bing's page answers a script with results about something else, DuckDuckGo
 * rate-limits after a handful of queries, and Google's own page, fetched
 * plainly, is a shell that needs JavaScript to show anything. A real browser
 * gets the real page. So with `WEB_SEARCH_BROWSER=chrome` the Chrome already
 * installed on this machine is started without a window, in a profile of its
 * own, and asked -- over the DevTools protocol, which is how this repository's
 * layout tests drive it too; no dependency -- to search and to read pages.
 *
 * ## Not getting a CAPTCHA
 *
 * Google shows "unusual traffic" to a client that searches too often, too
 * regularly, or looks automated. So:
 *
 *   - Pacing (createPacer): at least WEB_SEARCH_BROWSER_GAP seconds between
 *     searches, plus a random extra so they are not metronomic; no more than
 *     WEB_SEARCH_BROWSER_PER_HOUR an hour and WEB_SEARCH_BROWSER_PER_DAY a day.
 *     A search that would have to wait longer than a few seconds is not held:
 *     it goes to the next source (Naver, DuckDuckGo) and Google is asked again
 *     later. Nothing ever waits in a queue of searches.
 *   - One search at a time, from one profile that keeps its cookies, as one
 *     person's browser would; a new profile visits the front page first.
 *   - It does not announce itself: the "HeadlessChrome" in its user agent is
 *     removed and `navigator.webdriver` is not set.
 *   - If a CAPTCHA appears anyway it is never answered. Google is left alone
 *     for 30 minutes, then 2, 8 and 24 hours if it happens again, and the
 *     wait is kept on disk so a restart does not shorten it.
 *
 * Google's terms do not allow automated queries. This is one person's own
 * machine searching at a person's pace; it is still off unless switched on,
 * and it uses a profile of its own, never the reader's signed-in Chrome.
 *
 * Chrome is closed after WEB_SEARCH_BROWSER_IDLE seconds with nothing to do.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const dataDir = () => (process.env.WEBUI_DATA_DIR
  ? path.resolve(process.env.WEBUI_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const browserSearchEnabled = (env = {}) => /^(chrome|on|true|1)$/i.test(String(env.WEB_SEARCH_BROWSER || '').trim());

/* ------------------------------------------------------------ the pacing */

/** After a CAPTCHA: half an hour, then longer each time it happens again. */
export const BACKOFF_MS = [30 * 60 * 1000, 2 * HOUR, 8 * HOUR, 24 * HOUR];

/**
 * When the next search may go, and whether it is worth waiting for.
 *
 * `reserve(maxWaitMs)` either books a slot -- `{ ok: true, waitMs }`, the
 * caller sleeps that long and searches -- or says why not, and when to ask
 * again. State is kept in `file` so a restart forgets neither the recent
 * searches nor a CAPTCHA's back-off.
 */
export const createPacer = ({
  now = Date.now,
  random = Math.random,
  gapMs = 12_000,
  jitterMs = 8_000,
  perHour = 15,
  perDay = 100,
  file = null,
} = {}) => {
  let state = { times: [], blockedUntil: 0, strikes: 0, next: 0 };
  if (file) {
    try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state));
    } catch { /* kept in memory */ }
  };
  const prune = (t) => { state.times = state.times.filter(x => t - x < DAY); };

  return {
    reserve(maxWaitMs = 0) {
      const t = now();
      prune(t);
      if (state.blockedUntil > t) return { ok: false, reason: 'captcha', retryAt: state.blockedUntil };
      const lastHour = state.times.filter(x => t - x < HOUR);
      if (lastHour.length >= perHour) return { ok: false, reason: 'hourly', retryAt: lastHour[0] + HOUR };
      if (state.times.length >= perDay) return { ok: false, reason: 'daily', retryAt: state.times[0] + DAY };
      const at = Math.max(t, state.next || 0);
      const waitMs = at - t;
      if (waitMs > maxWaitMs) return { ok: false, reason: 'gap', retryAt: at };
      state.times.push(at);
      // The gap after this one, with its randomness decided now.
      state.next = at + gapMs + Math.round(random() * jitterMs);
      save();
      return { ok: true, waitMs };
    },
    /** A CAPTCHA: stay away, longer each time. */
    captcha() {
      const t = now();
      const wait = BACKOFF_MS[Math.min(state.strikes, BACKOFF_MS.length - 1)];
      state.strikes += 1;
      state.blockedUntil = t + wait;
      save();
      return state.blockedUntil;
    },
    /** A search that worked: the back-off starts from the beginning next time. */
    success() {
      if (state.strikes) { state.strikes = 0; save(); }
    },
    status() {
      const t = now();
      prune(t);
      return {
        blockedUntil: state.blockedUntil > t ? state.blockedUntil : 0,
        strikes: state.strikes,
        lastHour: state.times.filter(x => t - x < HOUR).length,
        lastDay: state.times.length,
        next: Math.max(t, state.next || 0),
      };
    },
  };
};

/* --------------------------------------------------------- the results */

/**
 * What the page script found, cleaned: Google's own links and redirects
 * unwrapped or dropped, each address once.
 */
export const normaliseGoogleResults = (raw = [], limit = 10) => {
  const out = [];
  const seen = new Set();
  for (const r of raw || []) {
    if (out.length >= limit) break;
    let url = String(r?.url || '');
    try {
      const u = new URL(url);
      if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === '/url') url = u.searchParams.get('q') || u.searchParams.get('url') || '';
    } catch { continue; }
    if (!/^https?:\/\//i.test(url)) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (/(^|\.)google\.[a-z.]+$/i.test(host) && !/^(maps|scholar|books|support|developers)\./i.test(host)) continue;
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const title = String(r?.title || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    out.push({
      title: title.slice(0, 200),
      url: url.slice(0, 500),
      snippet: String(r?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }
  return out;
};

/* Run in the results page. Returns { captcha } or { consent } or { results }. */
export const GOOGLE_EXTRACT = `(() => {
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  if (location.pathname.startsWith('/sorry')
    || document.querySelector('#captcha-form, form[action*="sorry"], iframe[src*="recaptcha"]')
    || /unusual traffic|비정상적인 트래픽|로봇이 아닙니다|not a robot/i.test(text)) return { captcha: true };
  if (/^consent\\./.test(location.hostname)) return { consent: true };
  const results = [];
  for (const h3 of document.querySelectorAll('#search a h3, #rso a h3')) {
    const a = h3.closest('a');
    if (!a) continue;
    const box = a.closest('.MjjYud, .g, [data-hveid]') || a.parentElement;
    const sn = box && box.querySelector('.VwiC3b, [data-sncf], .ITZIwc, [style*="line-clamp"]');
    let snippet = sn ? sn.innerText : '';
    if (!snippet && box) snippet = box.innerText.replace(h3.innerText, '');
    results.push({ title: h3.innerText, url: a.href, snippet: snippet.slice(0, 600) });
  }
  return { results, ready: !!document.querySelector('#search, #rso, #botstuff') };
})()`;

export const googleUrl = (query) => {
  const korean = /[가-힣]/.test(query);
  return `https://www.google.com/search?q=${encodeURIComponent(query)}${korean ? '&hl=ko&gl=kr' : '&hl=en'}`;
};

/* ------------------------------------------------------------- Chrome */

/** Where Chrome is: CHROME_PATH, or where its installers put it. */
export const findChrome = (env = {}, { exists = fs.existsSync } = {}) => {
  const candidates = [
    env.CHROME_PATH,
    ...(process.platform === 'win32' ? [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
  ].filter(Boolean);
  return candidates.find(file => { try { return exists(file); } catch { return false; } }) || '';
};

/** The command line: no window, its own profile, nothing that says "automated". */
export const chromeArgs = ({ profile, port }) => [
  '--headless=new',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  '--remote-debugging-address=127.0.0.1',
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-extensions',
  '--mute-audio',
  '--lang=ko-KR',
  '--window-size=1366,900',
  'about:blank',
];

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const killTree = (child) => {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { child.kill('SIGTERM'); } catch { /* gone */ } }
};

/** One page, over its own DevTools socket. */
const openPage = async (port) => {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Chrome refused the page connection')); });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, timeoutMs = 20_000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(timer);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const close = async () => {
    try { ws.close(); } catch { /* closed */ }
    try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch { /* browser gone */ }
  };
  return { send, evaluate, close };
};

/**
 * The browser, started when first needed and closed when idle. Work on it is
 * one thing at a time: the pace is the point, and one profile is one person.
 */
export const createBrowser = (env = {}) => {
  const idleMs = num(env.WEB_SEARCH_BROWSER_IDLE, 300) * 1000;
  const profile = path.join(dataDir(), 'browser-profile');
  let child = null, port = 0, userAgent = '', idleTimer = null, starting = null;
  let chain = Promise.resolve();

  const stop = () => { killTree(child); child = null; port = 0; };
  process.once('exit', stop);

  const start = async () => {
    if (child && child.exitCode === null) return;
    const chrome = findChrome(env);
    if (!chrome) throw new Error('Chrome was not found. Install it or set CHROME_PATH in .env.');
    fs.mkdirSync(profile, { recursive: true });
    const fresh = !fs.existsSync(path.join(profile, 'Default'));
    port = await freePort();
    child = spawn(chrome, chromeArgs({ profile, port }), { stdio: 'ignore', windowsHide: true });
    child.on('exit', () => { child = null; });
    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
      await sleep(250);
      try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { /* not up yet */ }
    }
    if (!version) { stop(); throw new Error('Chrome did not open its debugging port'); }
    // What a person's Chrome says, not "HeadlessChrome".
    userAgent = String(version['User-Agent'] || '').replace(/HeadlessChrome/g, 'Chrome');
    // A new profile has no cookies; a person's first visit is the front page.
    if (fresh) {
      const page = await openPage(port);
      try {
        await prepare(page);
        await page.send('Page.navigate', { url: 'https://www.google.com/' });
        await sleep(2500 + Math.random() * 2000);
      } finally { await page.close(); }
    }
  };

  const prepare = async (page) => {
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Network.setUserAgentOverride', {
      userAgent, acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7', platform: process.platform === 'win32' ? 'Win32' : process.platform,
    });
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
    idleTimer.unref?.();
  };

  /** Run `fn(page)` on a fresh tab, after anything already running. */
  const withPage = (fn) => {
    const run = chain.then(async () => {
      clearTimeout(idleTimer);
      starting ||= start().finally(() => { starting = null; });
      await starting;
      const page = await openPage(port);
      try {
        await prepare(page);
        return await fn(page);
      } finally {
        await page.close();
        armIdle();
      }
    });
    chain = run.catch(() => {});
    return run;
  };

  return { withPage, stop, running: () => !!child };
};

/* Wait until the page script says it is ready, or the time is up. */
const settle = async (page, expression, { timeoutMs = 15_000, ready = v => v } = {}) => {
  const until = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < until) {
    await sleep(400);
    try { value = await page.evaluate(expression); } catch { /* navigating */ }
    if (value && ready(value)) return value;
  }
  return value;
};

/* ------------------------------------------------------------ the tools */

let shared = null;
const browserFor = (env) => (shared ||= createBrowser(env));
let pacer = null;
const pacerFor = (env) => (pacer ||= createPacer({
  gapMs: num(env.WEB_SEARCH_BROWSER_GAP, 12) * 1000,
  jitterMs: num(env.WEB_SEARCH_BROWSER_JITTER, 8) * 1000,
  perHour: num(env.WEB_SEARCH_BROWSER_PER_HOUR, 15),
  perDay: num(env.WEB_SEARCH_BROWSER_PER_DAY, 100),
  file: path.join(dataDir(), 'browser-search.json'),
}));

const when = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * One Google search in Chrome, at the pace above. Throws, saying why, when it
 * is not Google's turn -- the caller asks the next source.
 */
export const searchGoogleInBrowser = async (query, limit = 5, env = {}) => {
  const pace = pacerFor(env);
  const slot = pace.reserve(num(env.WEB_SEARCH_BROWSER_MAX_WAIT, 6) * 1000);
  if (!slot.ok) {
    const why = { captcha: 'resting after a CAPTCHA', hourly: 'hourly allowance used', daily: 'daily allowance used', gap: 'pacing between searches' }[slot.reason];
    throw new Error(`Google (browser) is ${why} until ${when(slot.retryAt)}`);
  }
  if (slot.waitMs) await sleep(slot.waitMs);

  const found = await browserFor(env).withPage(async (page) => {
    await page.send('Page.navigate', { url: googleUrl(query) });
    const value = await settle(page, GOOGLE_EXTRACT, { ready: v => v.captcha || v.consent || v.ready });
    // A moment on the page, as anyone would take, before leaving it.
    await sleep(700 + Math.random() * 1300);
    return value;
  });

  if (found?.captcha) {
    const until = pace.captcha();
    throw new Error(`Google asked for a CAPTCHA; not asking it again until ${when(until)}`);
  }
  if (found?.consent) throw new Error('Google showed its consent page');
  const results = normaliseGoogleResults(found?.results || [], limit);
  if (!results.length) throw new Error('Google (browser) returned no readable results');
  pace.success();
  return results;
};

/**
 * A page read in Chrome: for the sites that send a script-rendered shell or
 * refuse a plain request. Returns the page's HTML as rendered.
 */
export const readPageInBrowser = async (url, env = {}) => browserFor(env).withPage(async (page) => {
  await page.send('Page.navigate', { url });
  const html = await settle(page, `(() => document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 200
    ? document.documentElement.outerHTML : '')()`, { timeoutMs: 20_000 });
  const final = await page.evaluate('location.href');
  if (!html) {
    const any = await page.evaluate('document.documentElement ? document.documentElement.outerHTML : ""');
    return { html: String(any || ''), url: String(final || url) };
  }
  return { html: String(html), url: String(final || url) };
});

/** For the settings panel and the attempts line: where the pacing stands. */
export const browserSearchStatus = (env = {}) => ({
  enabled: browserSearchEnabled(env),
  chrome: findChrome(env),
  running: !!shared?.running(),
  ...pacerFor(env).status(),
});

