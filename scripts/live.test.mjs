// One real conversation, end to end.
//
// Everything else in this suite tests a piece. `smoke.test.mjs` proves the app
// starts; the rest prove functions behave. Nothing sent a question to a model
// and looked at the answer — and every regression caught during this work was
// caught by driving the app by hand in a browser and then throwing the script
// away.
//
// So this is that script, kept. It builds the app, serves it, opens it in
// headless Edge or Chrome, picks a model that can actually chat, asks a
// question, and checks the answer arrived intact: streamed into the
// transcript, saved to storage, decoded properly, no half characters, no
// uncaught exceptions.
//
// It needs a running Ollama with at least one chat-capable model. Where there
// is none it skips, loudly — a machine that cannot run this is better told so
// than silently passed.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const HTTP_PORT = 8199;
const CDP_PORT = 9499;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const done = (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(code ?? (fail === 0 ? 0 : 1));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------- is there anything to test */

let models = [];
try {
  const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(4000) });
  models = (await res.json()).models || [];
} catch (e) {
  console.log(`SKIP  no Ollama at ${OLLAMA}; a live conversation cannot be tested`);
  done(0);
}

/* Embedding models cannot answer a chat, and picking one by accident is how
   this test would "fail" for a reason that has nothing to do with the app —
   it happened by hand more than once before this file existed. */
const chatModels = [];
for (const m of models) {
  try {
    const show = await (await fetch(`${OLLAMA}/api/show`, {
      method: 'POST', body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(4000),
    })).json();
    if ((show.capabilities || []).includes('completion')) chatModels.push({ ...m, capabilities: show.capabilities });
  } catch (e) { /* skip a model that cannot be inspected */ }
}
if (chatModels.length === 0) {
  console.log('SKIP  Ollama has no chat-capable model installed');
  done(0);
}
/* The smallest *local* model.
 *
 * Smallest because this runs in a test suite and a 31B answers at four tokens
 * a second. Local because a cloud entry reports a size of zero and therefore
 * sorts first — which is how the first run of this file ended up testing
 * somebody else's server over the internet rather than the machine in front of
 * it. A test that needs the network to pass fails for reasons that have
 * nothing to do with the code. */
const local = chatModels.filter(m => (m.size || 0) > 0 && !/:cloud$/.test(m.name));
if (local.length === 0) {
  console.log('SKIP  Ollama has only cloud models; a live local conversation cannot be tested');
  done(0);
}
/* A model already resident in VRAM beats a smaller one that is not.
 *
 * Loading 17 GB while another model holds the card takes a couple of minutes,
 * and this file passed on its own and failed inside `npm test` for exactly
 * that reason -- the suite before it had left a different model loaded. A test
 * that depends on what the GPU happens to be holding is a flaky test, and a
 * flaky test is worse than no test. */
let loaded = [];
try {
  const ps = await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(4000) })).json();
  loaded = (ps.models || []).map(m => m.name);
} catch (e) { /* nothing resident, or an older daemon with no /api/ps */ }

const resident = local.find(m => loaded.includes(m.name));
const model = resident || local.sort((a, b) => a.size - b.size)[0];
if (resident) console.log('      (it is already loaded, so this will be quick)');
console.log(`      using ${model.name} (${(model.size / 1e9).toFixed(1)} GB, ${JSON.stringify(model.capabilities)})`);

/* Can it answer at all?
 *
 * "Prefer the resident model" removed a two-minute load and introduced a
 * different failure: a model that is resident but cannot generate is still
 * resident, so it gets picked, and the test then drives the browser, waits its
 * whole budget and fails six assertions about the app. Every one of those
 * failures is a lie -- the app was fine and the daemon was not.
 *
 * One trivial request, straight to Ollama, tells the two apart before any of
 * that. A daemon that cannot produce a token in three minutes is not something
 * this file can test around, so it says so and stops.
 *
 * The budget is generous because a cold model has to be read off disk here
 * too, and this is the request that pays for it -- which is also why it is
 * worth making: the browser run that follows starts against a warm model. */
const PULSE_MS = 180000;
const pulseStarted = Date.now();
let pulse = null;
try {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({
      model: model.name,
      messages: [{ role: 'user', content: 'Reply with the single digit 2 and nothing else.' }],
      stream: false,
      think: false,
      options: { num_predict: 8, temperature: 0 },
    }),
    signal: AbortSignal.timeout(PULSE_MS),
  });
  pulse = await res.json();
} catch (e) {
  pulse = { error: e.name === 'TimeoutError' ? `no reply in ${PULSE_MS / 1000}s` : e.message };
}

const pulseTook = Math.round((Date.now() - pulseStarted) / 1000);
if (!pulse || pulse.error || !pulse.message) {
  console.log(`SKIP  ${model.name} did not answer a one-token question (${pulse?.error || 'no reply'}).`);
  console.log('      Ollama is not in a state this test can drive. The app is not what failed here;');
  console.log(`      the same request made with curl behaves the same way. Waited ${pulseTook}s.`);
  done(0);
}
console.log(`      it answered a one-token question in ${pulseTook}s, so it is awake`);

const BROWSERS = [
  process.env.SMOKE_BROWSER,
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) {
  console.log('SKIP  no Chrome or Edge found');
  done(0);
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('      dist/ is empty; building first…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: true });
}

/* ------------------------------------------------------------- the server */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png',
  '.bcmap': 'application/octet-stream',
};

// A real proxy to Ollama, because the whole point is a real answer.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    try {
      const upstream = await fetch(`${OLLAMA}${url.pathname}${url.search}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: body.length ? Buffer.concat(body) : undefined,
      });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      // Piped as bytes: re-encoding a stream is how a multi-byte character
      // gets split, which is the bug this file would otherwise mask.
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message) }));
    }
    return;
  }

  // Everything else the app might ask for and that this harness does not run.
  if (/^\/(mcp|localfs|system|tts-api|stt-api|kakao)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"not running in the live test"}');
    return;
  }

  let file = path.join(DIST, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

/* ------------------------------------------------------------ the browser */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-live-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--force-device-scale-factor=1',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { child.kill(); } catch (e) { /* gone */ }
  try { server.close(); } catch (e) { /* closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
};

let ws;
try {
  const wsUrl = await (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
        const target = list.find(t => t.type === 'page');
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      } catch (e) { /* not up yet */ }
      await sleep(250);
    }
    throw new Error('the browser never opened a debugging port');
  })();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
} catch (err) {
  check('the browser starts', false, err.message);
  cleanup();
  done();
}

let nextId = 1;
const pending = new Map();
const thrown = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    thrown.push(String(m.params?.exceptionDetails?.exception?.description || '').split('\n')[0].slice(0, 200));
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(resolve => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression, ms = 20000) => {
  const call = send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const r = await Promise.race([call, sleep(ms).then(() => null)]);
  if (!r) return 'TIMED OUT';
  if (r.result?.exceptionDetails) return `THREW: ${String(r.result.exceptionDetails.exception?.description || '').slice(0, 200)}`;
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(7000);

await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || ''));
  if (b) b.click();
})()`);
await sleep(5000);

check('the app is usable', await ev(`!!document.querySelector('textarea.chat-input')`) === true);

// The model matters: the app defaults to whichever Ollama lists first, which
// may be an embedding model that cannot answer at all.
/* Open the model picker.
 *
 * By whichever model name it is currently showing — not by the one we want.
 * The first version of this searched for a button containing the target
 * name, which the trigger never shows, so the picker never opened, the app
 * stayed on the first model Ollama lists, and that is an embedding model.
 * The "answer" was then `**Error:** … does not support chat`, and every
 * assertion below reported a mystery instead of the obvious. */
const picked = await ev(`(() => {
  const names = ${JSON.stringify(models.map(m => m.name.split(':')[0]).filter(Boolean))};
  const btn = [...document.querySelectorAll('button')]
    .find(b => names.some(n => (b.textContent || '').includes(n)));
  if (!btn) return 'no picker';
  btn.click();
  return 'opened';
})()`);
await sleep(800);
const chose = await ev(`(() => {
  const item = [...document.querySelectorAll('.dropdown-item')]
    .find(b => b.textContent.includes(${JSON.stringify(model.name)}));
  if (!item) return 'not listed: ' + [...document.querySelectorAll('.dropdown-item')].map(b => b.textContent.trim()).join(' | ');
  item.click();
  return 'chosen';
})()`);
await sleep(900);
check('the model picker opened', picked === 'opened', String(picked));
check('and the model was chosen', chose === 'chosen', String(chose));

/* --------------------------------------------------------- ask something */

// Korean on purpose: multi-byte throughout, which is what makes a broken
// stream decode visible rather than theoretical.
const QUESTION = '1 더하기 1은 얼마인가요? 숫자만 아주 짧게 답해 주세요.';
await ev(`(() => {
  const box = document.querySelector('textarea.chat-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(box, ${JSON.stringify(QUESTION)});
  box.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(400);
await ev(`document.querySelector('.send-btn')?.click()`);

/* Waited for rather than slept through: a cold model takes a minute or two to
   load and a fixed sleep would either be flaky or waste that time.
   Five minutes, because that is what a cold 17 GB model costs on a card that
   is already holding something else — measured, not guessed. */
const WAIT_MS = 300000;
const startedWaiting = Date.now();
let answer = '';
while (Date.now() - startedWaiting < WAIT_MS) {
  await sleep(2000);
  const state = JSON.parse(await ev(`JSON.stringify({
    generating: !!document.querySelector('.send-btn.active') && !!document.querySelector('[class*="spin"]'),
    text: (document.querySelector('.message-row.assistant .markdown-body')?.innerText || ''),
    stopButton: !!document.querySelector('.send-btn.active'),
  })`) || '{}');
  answer = state.text || '';
  if (answer.trim() && !state.stopButton) break;
}

const waited = Math.round((Date.now() - startedWaiting) / 1000);
// The elapsed time is in the message so a failure says "waited 300s and
// nothing came" rather than leaving somebody to wonder whether it was slow or
// broken.
check('an answer came back', answer.trim().length > 0,
  `waited ${waited}s; on screen: ${JSON.stringify(answer.slice(0, 120))}`);
console.log(`      the answer took ${waited}s`);
/* Checked against the *raw* stored text further down, not against this.
   Markdown renders `**Error:**` as bold "Error:", so a check on what is on
   screen cannot tell an error bubble from an answer — which is exactly how an
   embedding model's "does not support chat" passed for a real reply. */
check('something was rendered', answer.trim().length > 0);

// The question was Korean and so, almost certainly, is the answer. A broken
// stream decode shows up here and nowhere else in the suite.
check('no replacement characters in the answer', !answer.includes('�'),
  answer.slice(0, 160));
check('no half characters either',
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(answer));

/* The finished message is written to storage on a debounce, and its model and
   timings are attached by the frame that ends the stream. Reading the instant
   the spinner stops is therefore too early — by about a second, which is
   exactly long enough to look like the fields were never written. */
await sleep(2500);

/* ------------------------------------------------ and it survived the trip */

const stored = JSON.parse(await ev(`new Promise(resolve => {
  const req = indexedDB.open('localforage');
  req.onerror = () => resolve('{}');
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('keyvaluepairs')) return resolve('{}');
    const get = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get('ollama-sessions');
    get.onerror = () => resolve('{}');
    get.onsuccess = () => {
      const list = get.result || [];
      // Every chat, so a reader that picked the wrong one says so instead of
      // reporting a missing field that was never missing.
      const shape = list.map(c => ({
        title: c.title,
        updatedAt: c.updatedAt,
        messages: (c.messages || []).map(m => Object.keys(m).join('+')),
      }));
      const chat = list[0];
      const last = chat && chat.messages[chat.messages.length - 1];
      resolve(JSON.stringify({
        // Reported on failure, because guessing at why a field is missing is
        // how an afternoon goes.
        keys: last ? Object.keys(last).join(',') : '',
        allChats: shape,
        messageCount: chat ? chat.messages.length : 0,
        role: last && last.role,
        chars: last ? (last.content || '').length : 0,
        head: last ? (last.content || '').slice(0, 120) : '',
        model: last && last.model,
        hasMetrics: !!(last && last.metrics),
        broken: last ? (last.content || '').includes(String.fromCharCode(0xFFFD)) : null,
      }));
    };
  };
})`, 25000) || '{}');

check('the answer reached storage', stored.role === 'assistant' && stored.chars > 0, JSON.stringify(stored.keys));
// The one that matters, and on the raw text where the marker is still visible.
check('and it is an answer rather than an error bubble',
  !/^\*\*Error:\*\*/.test((stored.head || '').trim()), stored.head);
console.log('      stored content begins:', JSON.stringify(stored.head));
console.log('      what is in storage:', JSON.stringify(stored.allChats, null, 1));
check('it records which model wrote it', !!stored.model, JSON.stringify(stored.model));
// The real check on model selection: whatever answered has to be something
// that can hold a conversation, whether or not the picker click landed.
check('and that model can actually hold a conversation',
  chatModels.some(m => m.name === stored.model),
  `${stored.model} is not in the chat-capable list`);
check('and its timings', stored.hasMetrics === true);
check('storage holds no replacement characters', stored.broken === false);

// What the app thought it was doing. Its own log is the only record of a tool
// round-trip, and a tool round-trip rewrites the assistant message as a bare
// {role, content} pair — which is what the storage dump above shows.
const appLog = await ev(`(() => {
  const rows = [...document.querySelectorAll('.log-entry, .log-line, [class*="log"] li, [class*="log"] div')];
  return rows.map(r => (r.innerText || '').slice(0, 120)).filter(Boolean).slice(-25).join(String.fromCharCode(10));
})()`);
console.log('      app log tail:', appLog || '(no log panel open)');

/* Did the turn ever finish?
   `metrics` and `model` are attached by the frame that ends the stream, and
   the footer under a finished answer is drawn from them. If that footer is on
   screen the turn completed and the fields were computed — so anything missing
   from storage was lost on the way there. If it is absent, the stream never
   delivered a `done` frame and there was nothing to store. The two are
   different bugs and this is what tells them apart. */
const finished = await ev(`(() => {
  const m = document.querySelector('.claude-metrics');
  return JSON.stringify({ shown: !!m, text: m ? m.innerText.replace(String.fromCharCode(10), ' ') : null });
})()`);
console.log('      the metrics footer:', finished);

const offline = /Failed to fetch|NetworkError|503|not running in the live test|ERR_|gsi|accounts\.google/i;
const real = thrown.filter(line => line && !offline.test(line));
check('no uncaught exceptions during a real conversation', real.length === 0, real.slice(0, 4).join('\n      '));

cleanup();
done();
