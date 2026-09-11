// The composer, as a stack.
//
// It used to be a single row: attach, microphone, telescope, the box you type
// into, send. Three things are wrong with that and only the third is obvious.
//
//   * The widest element on the row was the one that could shrink, so the box
//     you type into was the narrowest control on the composer.
//   * Three icons sat where the first word of a message should be.
//   * The two controls that decide *how* the message is answered -- which model
//     and how hard it thinks -- were somewhere else entirely: one in the title
//     bar, one in a strip of small buttons under the composer that a phone
//     could not fit across.
//
// So: the box takes the top line, and one row under it holds what you can add
// to the message on the left and how it gets answered on the right.
//
// This is a browser test rather than a regex over the source because every
// claim above is about geometry. "The box is above the controls" and "the box
// is the width of the composer" are not things a string match can see, and the
// bug being guarded against is exactly a layout that reads correctly in JSX and
// lays out wrongly on screen.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = 8191;
const CDP_PORT = 9491;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const done = (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(code ?? (fail === 0 ? 0 : 1));
};

/* ------------------------------------------- what the effort means on the wire

   These run before the browser, so a machine without one still checks them.
   Geometry needs a renderer; a mapping does not, and this mapping is the part
   that would be easy to get quietly wrong -- a label on screen with nothing
   behind it in the request body is worse than no control at all. */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');

const table = /const THINK_MODES = \[([\s\S]*?)\];/.exec(app);
check('there is a table of thinking levels', !!table);
if (table) {
  const rows = [...table[1].matchAll(/id: '([a-z]+)', wire: ([^\s},]+)/g)].map(m => [m[1], m[2]]);
  eq('five of them', rows.length, 5);
  eq('and they run from auto to high',
    rows.map(r => r[0]).join(','), 'auto,off,low,medium,high');

  // `auto` is not the middle of the scale. It leaves the field out of the
  // request entirely, which is the only value under which the model's own
  // default survives -- distinct from both true and false.
  eq('auto sends nothing at all', rows[0][1], 'undefined');
  eq('off sends false', rows[1][1], 'false');
  // The levels go over as strings. `think: true` is the old switch, and a
  // reasoning model handed it picks its own effort, which is the thing being
  // fixed.
  check('and the levels go over as levels',
    rows.slice(2).every(([id, wire]) => wire === `'${id}'`), JSON.stringify(rows));
}

check('the request omits the field on auto rather than sending a value',
  /const chosen = THINK_MODES\.find[\s\S]{0,160}chosen\.wire !== undefined \? \{ think: chosen\.wire \} : \{\}/.test(app));
check('the chat request carries it', /\.\.\.think,/.test(app));

// A model or an Ollama too old for levels refuses the whole request. Losing a
// turn over a reasoning preference is the wrong trade.
check('a refused level falls back to plain thinking rather than failing the turn',
  /typeof wanted\.think === 'string'[\s\S]{0,400}askOllama\(\{ think: true \}\)/.test(app));

// The old three-way switch stored 'on'. It has to keep meaning something.
check('a setting saved by the old switch still loads', /stored === 'on'/.test(app));

/* -------------------------------------- and that the numbers cannot vanish */

// `undefined / 1e9` is NaN, and `.toFixed(2)` on NaN is the string "NaN". Every
// one of these figures had a path where the server did not report it, and the
// footer answered by showing nothing at all -- which reads as the app losing
// the numbers rather than never having been given them.
check('a missing total_duration falls back to the clock on this machine',
  /serverTotal !== null \? serverTotal \/ 1e9 : wallSeconds/.test(app));
check('a missing eval_count falls back to counting the text',
  /evalCount \?\? estimateTokens\(/.test(app));
check('and a stream with no done frame still gets a footer',
  /if \(!legMetrics && \(rawAnswerText \|\| rawThinkingText\)\)/.test(app));
// Marked, because a number nobody can tell apart from a measurement is worse
// than no number -- and because the machine's own speed table must not be
// polluted with figures that include the network.
check('estimates are marked as estimates', /estimated: serverTotal === null/.test(app));
check('and are kept out of the speed table', /if \(!metrics\.estimated\) \{[\s\S]{0,80}recordRun\(/.test(app));

// The final frame is the `done` frame. Breaking out of the read loop before
// parsing what is left in the buffer threw it away whenever the body ended
// without a trailing newline -- which is most of "sometimes there are no
// numbers".
check('the last buffered frame is parsed rather than dropped',
  /buffer \+= done \? decoder\.decode\(\)/.test(app));

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
  console.log('SKIP  no Chrome or Edge found; the composer was not laid out');
  done(0);
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('      dist/ is empty; building first…');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Nothing is serving Ollama here, and nothing needs to be: what is under test
  // is where the controls land, not what they talk to. The model list is the
  // one exception -- the picker cannot be opened without one.
  if (url.pathname === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3:8b' }, { name: 'qwen3:30b' }] }));
    return;
  }
  if (/^\/(api|mcp|localfs|system|tts-api|kakao)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"not running in the composer test"}');
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-composer-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--force-device-scale-factor=1',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result?.result?.value;
};
const json = async (expression) => JSON.parse(await evaluate(`JSON.stringify(${expression})`) || 'null');
/* Poll rather than sleep. Everything here that disappears does it on a CSS
   transition, and a headless page's timers are not the wall clock. */
const waitFor = async (expression, ms = 4000) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await evaluate(expression) === true) return true;
    await sleep(100);
  }
  return false;
};

const click = (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  el.click();
  return 'clicked';
})()`);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(7000);

await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || ''));
  if (b) { b.click(); return 'clicked'; }
  return 'none';
})()`);
await sleep(5000);

/* ------------------------------------------------------------ the stack */

const layout = await json(`(() => {
  const box = document.querySelector('.chat-input');
  const row = document.querySelector('.composer-row');
  const form = document.querySelector('.input-container');
  if (!box || !row || !form) return { box: !!box, row: !!row, form: !!form };
  const b = box.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const f = form.getBoundingClientRect();
  return {
    box: true, row: true, form: true,
    boxTop: Math.round(b.top), boxWidth: Math.round(b.width), boxHeight: Math.round(b.height),
    rowTop: Math.round(r.top),
    formWidth: Math.round(f.width),
  };
})()`);

check('there is a composer to look at', layout.box && layout.row && layout.form, JSON.stringify(layout));

// The whole point of the change: the box is on the line above, not wedged
// between the telescope and the send button.
check('the box you type into is above the controls',
  layout.rowTop > layout.boxTop + layout.boxHeight - 4,
  `box bottom ${layout.boxTop + layout.boxHeight}, row top ${layout.rowTop}`);

// It used to be a middle column between five buttons. Now it has the line.
check('and it has the full width of the composer',
  layout.boxWidth > layout.formWidth * 0.85,
  `box ${layout.boxWidth} of ${layout.formWidth}`);

// One line to start with. A textarea stretched by a column flex parent opens
// three lines tall and looks like a message is already being written.
check('an empty composer is one line tall',
  layout.boxHeight > 0 && layout.boxHeight < 70, `${layout.boxHeight}px`);

/* ------------------------------------------------------------- the plus */

const beforeOpen = await json(`(() => ({
  // Only the microphone is still a permanent icon on the row.
  rowButtons: document.querySelectorAll('.composer-row .attach-btn').length,
  telescopeOnRow: !!document.querySelector('.composer-row > .attach-btn.research-on, .composer-row > .research-on'),
  plus: !!document.querySelector('.composer-plus'),
  menuOpen: !!document.querySelector('.composer-menu'),
}))()`);

check('the + is on the row', beforeOpen.plus);
eq('and the microphone is the only icon left beside it', beforeOpen.rowButtons, 1);
check('the menu starts closed', beforeOpen.menuOpen === false);

await click('.composer-plus');
await sleep(400);

const added = await json(`(() => {
  const menu = document.querySelector('.composer-menu');
  if (!menu) return { open: false };
  return {
    open: true,
    items: [...menu.querySelectorAll('.composer-menu-item')].length,
    // Each entry says what it does on a second line; a menu of bare verbs is
    // one nobody can choose from the first time.
    described: [...menu.querySelectorAll('.composer-menu-item em')].length,
    // It opens upwards. The composer sits at the bottom of the window and a
    // menu dropped below it is off the screen.
    aboveTheRow: menu.getBoundingClientRect().bottom
      <= document.querySelector('.composer-row').getBoundingClientRect().top + 2,
    onScreen: menu.getBoundingClientRect().top >= 0,
  };
})()`);

check('pressing + opens a menu', added.open === true);
eq('holding the three things you can add to a message', added.items, 3);
eq('each with a line saying what it does', added.described, 3);
check('and it opens upwards, not off the bottom of the window', added.aboveTheRow === true);
check('while still fitting on the screen', added.onScreen === true);

/* The button that opened it closes it. The popover used to close on the
   mousedown and reopen on the click that followed, so it could not be shut
   from the button that opened it.

   Asked two ways, because they fail differently. The button's own state is the
   regression: reopening leaves it expanded, and that is true the instant the
   click is handled. The node going away is a 150ms exit animation afterwards,
   and *that* is not something to assert against a fixed sleep -- Chrome aligns
   timers to the second in a page that is not being painted, which a headless
   one is not, so a 150ms timeout can land 900ms later on a machine where
   nothing is wrong. Hence a poll with a ceiling rather than one more sleep. */
await click('.composer-plus');
await sleep(200);
eq('and pressing + again closes it',
  await evaluate(`document.querySelector('.composer-plus').getAttribute('aria-expanded')`), 'false');
check('and the menu is taken down with it',
  await waitFor(`!document.querySelector('.composer-menu')`));

// Both entries in that menu are modes that outlive the message that armed
// them. Folding them behind a button folds away the only thing that said so,
// so the button says it instead.
check('nothing is armed to begin with',
  (await evaluate(`document.querySelector('.composer-plus').classList.contains('is-armed')`)) === false);

await click('.composer-plus');
await sleep(400);
// React renders on its own schedule, so the menu has to be open before its
// contents can be found -- hence the two steps rather than one script.
const armed = await json(`(() => {
  const mode = [...document.querySelectorAll('.composer-menu-item')]
    .find(b => b.getAttribute('aria-pressed') !== null);
  if (mode) mode.click();
  return { hadAToggle: !!mode };
})()`);
await sleep(400);
check('the menu has a mode in it', armed.hadAToggle === true);
check('and arming one marks the + itself',
  (await evaluate(`document.querySelector('.composer-plus').classList.contains('is-armed')`)) === true);
// Research also gets a strip of its own: it changes what sending means, from
// seconds to minutes, and a dot is not enough warning for that.
check('a mode that changes what sending means also gets a strip',
  (await evaluate(`!!document.querySelector('.research-strip')`)) === true);
check('and the strip is how it is turned off again',
  (await evaluate(`!!document.querySelector('.research-strip .variant-btn')`)) === true);

/* -------------------------------------------------- the model and the effort */

const trigger = await json(`(() => {
  const t = document.querySelector('.composer-model-trigger');
  if (!t) return { there: false };
  const row = document.querySelector('.composer-row').getBoundingClientRect();
  const r = t.getBoundingClientRect();
  return {
    there: true,
    // On the row, not in the title bar three clicks away.
    onTheRow: r.top >= row.top - 2 && r.bottom <= row.bottom + 2,
    // "Auto" is the default and says nothing; a badge that is always there is
    // a badge nobody reads.
    effortShown: !!t.querySelector('.composer-effort-tag'),
  };
})()`);

check('the model picker is on the composer row', trigger.there && trigger.onTheRow, JSON.stringify(trigger));
check('and says nothing about effort while it is on auto', trigger.effortShown === false);

await click('.composer-model-trigger');
await sleep(400);

const effort = await json(`(() => {
  const menu = document.querySelector('.composer-model-menu');
  if (!menu) return { open: false };
  const scale = menu.querySelector('.think-toggle');
  return {
    open: true,
    // Both halves of "how should this be answered", in one menu.
    models: [...menu.querySelectorAll('.composer-menu-item')].length,
    scale: scale ? [...scale.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
    pressed: scale
      ? [...scale.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed') === 'true').length
      : -1,
  };
})()`);

check('the model menu opens', effort.open === true);
check('it lists the models', effort.models >= 2, `${effort.models} models`);
// A scale, not a switch. On and off are the only two things a boolean field can
// say, and the difference between "low" and "high" on a reasoning model is the
// difference between four seconds and forty.
eq('the effort is a five-point scale', effort.scale.length, 5);
eq('with exactly one of them chosen', effort.pressed, 1);

// Choosing one marks the trigger, so the row says what it is set to without
// being opened.
await evaluate(`(() => {
  const scale = document.querySelector('.composer-model-menu .think-toggle');
  const buttons = [...scale.querySelectorAll('button')];
  buttons[3].click();
  return 'clicked';
})()`);
await sleep(400);

const afterChoice = await json(`(() => {
  const tag = document.querySelector('.composer-model-trigger .composer-effort-tag');
  return { tag: tag ? tag.textContent.trim() : null };
})()`);
check('choosing an effort puts it on the trigger', !!afterChoice.tag, JSON.stringify(afterChoice));

/* ----------------------------------------------------------- on a phone */

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
await sleep(800);

const phone = await json(`(() => {
  const row = document.querySelector('.composer-row');
  const box = document.querySelector('.chat-input');
  return {
    // The row must not push the page wider than the phone. This is the exact
    // failure the wrapped footer was written for, one row down.
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    rowRight: row ? Math.round(row.getBoundingClientRect().right) : -1,
    boxWidth: box ? Math.round(box.getBoundingClientRect().width) : -1,
  };
})()`);

check('the page is no wider than the phone',
  phone.scrollWidth <= phone.clientWidth + 1,
  `scroll ${phone.scrollWidth} vs client ${phone.clientWidth}`);
check('the control row stays on screen',
  phone.rowRight > 0 && phone.rowRight <= phone.clientWidth + 1, `right edge at ${phone.rowRight}`);
check('and the box is still most of the width',
  phone.boxWidth > phone.clientWidth * 0.7, `${phone.boxWidth} of ${phone.clientWidth}`);

cleanup();
done();
