import { createChatJobStore, followChatJob } from '../server/chatJobs.js';
const replayStore = createChatJobStore();
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
  /typeof wanted\.think === 'string'[\s\S]{0,900}askOllama\(\{ think: true \}\)/.test(app));

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
  /* "Is the generation this browser wrote down still a generation?" The app
     asks before it takes the screen over for a saved job -- see the restore in
     App.jsx. Answered from the same store the replay below reads. */
  if (url.pathname === '/api/chat/live') {
    const id = url.searchParams.get('id') || '';
    const job = id ? replayStore.read(id) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, known: !!job, running: !!job && !job.finished }));
    return;
  }
  if (url.pathname === '/api/chat/replay') {
    const job = replayStore.read(url.searchParams.get('id'));
    if (!job) { res.writeHead(404); res.end(); return; }
    followChatJob(req, res, job, url.searchParams.get('offset'));
    return;
  }
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

// Its own profile, closed with its whole process tree and removed -- see chromeProfile.mjs.
const { launchChrome } = await import('./chromeProfile.mjs');
const chrome = launchChrome(browser, 'webui-chrome-composer-', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--force-device-scale-factor=1',
  `--remote-debugging-port=${CDP_PORT}`,
]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cleanup = () => {
  try { server.close(); } catch (e) { /* closed */ }
  chrome.close();
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
    // Screen capture and camera appear only where the browser has them
    // (src/capture.js), so how many rows there should be depends on it.
    expected: 3 + (navigator.mediaDevices?.getDisplayMedia ? 1 : 0) + (navigator.mediaDevices?.getUserMedia ? 1 : 0),
    // It opens upwards. The composer sits at the bottom of the window and a
    // menu dropped below it is off the screen.
    aboveTheRow: menu.getBoundingClientRect().bottom
      <= document.querySelector('.composer-row').getBoundingClientRect().top + 2,
    onScreen: menu.getBoundingClientRect().top >= 0,
  };
})()`);

check('pressing + opens a menu', added.open === true);
eq('holding the things you can add to a message', added.items, added.expected);
eq('each with a line saying what it does', added.described, added.expected);
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

// A menu can exist in the DOM yet be clipped by its mobile wrapper.
await evaluate(`(() => {
  const trigger = document.querySelector('.composer-model-trigger');
  if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click();
})()`);
await sleep(250);
const tap = await json(`(() => {
  const r = document.querySelector('.composer-model-trigger').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`);
await send('Page.bringToFront');
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tap] });
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await sleep(350);
const mobileMenu = await json(`(() => {
  const item = document.querySelector('.composer-model-menu .composer-menu-item');
  if (!item) return { visible: false };
  const r = item.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { visible: item.contains(hit), top: r.top, bottom: r.bottom };
})()`);
check('a phone tap opens a visible, touchable model menu', mobileMenu.visible, JSON.stringify(mobileMenu));
await click('.composer-model-menu .composer-menu-item');
check('selecting a model closes the menu', await waitFor(`!document.querySelector('.composer-model-menu')`));

/* And the top of it.
 *
 * Measured at 390x844: the composer sat 394px down the screen, the menu opened
 * upward and stood 395px tall, and its heading came out at -9px -- off the top
 * of the phone, unreachable, because the menu scrolls inside itself and there
 * is nothing above it to scroll. The cap was a fraction of the viewport
 * (`55dvh`) rather than the room actually above the trigger, and a menu that
 * fits the cap can still not fit the gap.
 *
 * Squeezed here on purpose. A short viewport is a phone in landscape, and it is
 * what the on-screen keyboard leaves of a tall one -- both are the everyday
 * cases where the gap above the composer is small. */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 560, deviceScaleFactor: 1, mobile: true });
await sleep(600);
await evaluate(`(() => {
  const trigger = document.querySelector('.composer-model-trigger');
  if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click();
})()`);
await sleep(400);
const squeezed = await json(`(() => {
  const menu = document.querySelector('.composer-model-menu');
  if (!menu) return { open: false };
  const box = menu.getBoundingClientRect();
  return {
    open: true,
    viewport: window.innerHeight,
    top: Math.round(box.top),
    bottom: Math.round(box.bottom),
    height: Math.round(box.height),
    // More to read than there is room for is fine -- that is what scrolling is
    // for. Being *above the window* is not: nothing scrolls it back.
    scrolls: menu.scrollHeight > menu.clientHeight + 1,
  };
})()`);
check('the model menu opens with its top on screen', squeezed.open && squeezed.top >= 0, JSON.stringify(squeezed));
check('  and its bottom above the composer', squeezed.bottom <= squeezed.viewport + 1, JSON.stringify(squeezed));
check('  scrolling inside itself when the room is short rather than overflowing it',
  squeezed.scrolls || squeezed.height < squeezed.viewport, JSON.stringify(squeezed));

/* And nothing on top of it.
 *
 * On a phone the notices sit along the top of the screen -- moved there because
 * at the bottom right they covered the model button. A menu that opens upward
 * from the composer now reaches the top of the screen, so the notices covered
 * its first rows instead: one screen up, the same bug, and the rows underneath
 * a notice cannot be pressed. A notice is put here by hand rather than waited
 * for, because which notices appear depends on how the server was started. */
await evaluate(`(() => {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  const notice = document.createElement('div');
  notice.className = 'toast';
  notice.id = 'planted-notice';
  notice.style.minHeight = '96px';
  notice.textContent = 'a notice long enough to cover the top of a menu';
  stack.appendChild(notice);
})()`);
await sleep(300);
const covered = await json(`(() => {
  const menu = document.querySelector('.composer-model-menu');
  const first = menu?.querySelector('.composer-menu-heading');
  if (!first) return { open: false };
  const box = first.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return {
    open: true,
    onMenu: !!hit && !!menu.contains(hit),
    hit: hit ? hit.tagName.toLowerCase() + '.' + (hit.className || '').toString().split(' ')[0] : null,
  };
})()`);
check('a notice does not cover the top of the open menu', covered.open && covered.onMenu, JSON.stringify(covered));
await evaluate(`document.getElementById('planted-notice')?.remove()`);

await evaluate(`document.querySelector('.composer-model-trigger')?.click()`);
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
await sleep(400);

// Reload a running job, then reload it again while more tokens are arriving.
const recoveryJob = replayStore.begin('browser-recovery');
replayStore.appendChunk(recoveryJob.id, JSON.stringify({ message: { content: '복구 첫부분 🎉' } }) + '\n');
await evaluate(`localStorage.setItem('ollama-sessions', JSON.stringify([{
  id: 'recovery-session', title: 'Recovery', updatedAt: Date.now(), createdAt: Date.now(),
  messages: [{ role: 'user', content: '계속 답변해줘' }, { role: 'assistant', content: '' }]
}])); localStorage.setItem('chatGeneration:guest', JSON.stringify({
  sessionId: 'recovery-session', jobId: 'browser-recovery', messageIndex: 1, startedAt: Date.now()
}));`);
await send('Page.reload');
/* Recovery follows the answer without taking the screen over: the chat being
   read stays the chat being read, and a notice offers the way to the one that
   is still arriving. Reported as the screen being dragged back to a finished
   chat, so what is exercised here is what a person does -- press "go there". */
const goToRecovering = () => evaluate(`(() => {
  const go = document.querySelector('.busy-elsewhere button');
  if (go) { go.click(); return 'went'; }
  return 'already there';
})()`);
await waitFor(`!!document.querySelector('.busy-elsewhere button') || !!document.querySelector('.markdown-body.is-streaming')`, 10000);
await goToRecovering();
check('reload restores the active answer and streaming class', await waitFor(
  `!![...document.querySelectorAll('.markdown-body.is-streaming')].find(x => x.textContent.includes('복구 첫부분 🎉'))`, 10000));
replayStore.appendChunk(recoveryJob.id, JSON.stringify({ message: { content: ' 중간 이어쓰기' } }) + '\n');
check('new tokens arrive live after reload', await waitFor(`document.body.textContent.includes('중간 이어쓰기')`));
await sleep(1100);
await send('Page.reload');
await waitFor(`!!document.querySelector('.busy-elsewhere button') || !!document.querySelector('.markdown-body.is-streaming')`, 10000);
await goToRecovering();
check('a second reload reconnects to the same job', await waitFor(
  `!![...document.querySelectorAll('.markdown-body.is-streaming')].find(x => x.textContent.includes('중간 이어쓰기'))`, 10000));
replayStore.appendChunk(recoveryJob.id, JSON.stringify({ message: { content: ' 마지막 유지 😀' } }) + '\n');
replayStore.appendChunk(recoveryJob.id, JSON.stringify({ done: true, eval_count: 123,
  total_duration: 2000000000, eval_duration: 1000000000 }));
replayStore.finish(recoveryJob.id);
check('completion preserves the tail and token metrics', await waitFor(
  `document.body.textContent.includes('마지막 유지 😀') && document.body.textContent.includes('123 tok')`));
check('completion clears the generation marker', await waitFor(`!localStorage.getItem('chatGeneration:guest')`));

/* ------------------------------------ a generation that is over and gone

   Reported: "받는 중입니다" appearing and disappearing over and over, in a chat
   whose answer had finished, while the screen kept jumping back to that chat --
   and a server restart changing nothing, because what was stuck was in the
   browser. The job id is kept in localStorage so an answer survives a reload;
   the two paths that clear it both had holes, and the worst of them was a
   picture key left behind by a turn that ended days ago, which vetoed the
   clearing entirely.

   What the app does now is ask first. A generation this server has never heard
   of is one that is finished for good, whatever this browser wrote down. */
await evaluate(`
  localStorage.setItem('ollama-sessions', JSON.stringify([
    { id: 'chat-a', title: 'Where I am looking', updatedAt: Date.now(), createdAt: Date.now(),
      messages: [{ role: 'user', content: '여기 있어요' }] },
    { id: 'chat-b', title: 'The one that finished', updatedAt: Date.now() - 1000, createdAt: Date.now() - 1000,
      messages: [{ role: 'user', content: '끝난 대화' }, { role: 'assistant', content: '다 됐습니다' }] }
  ]));
  localStorage.setItem('chatGeneration:guest', JSON.stringify({
    sessionId: 'chat-b', jobId: 'a-job-nobody-remembers', messageIndex: 1, startedAt: Date.now() - 86400000
  }));
  /* The key that used to hold the whole thing open: a picture key for a chat
     nobody is looking at, recent enough to look live. Nothing cleans it -- the
     app only ever removes the key of the chat on screen -- and while it is
     there the generation below was never forgotten, so every load took the
     screen over again. */
  localStorage.setItem('chatDrawing:guest:chat-b', JSON.stringify({
    id: 'a-prompt-id-nobody-remembers', prompt: 'a cat', startedAt: Date.now() - 60000
  }));
  // And one from a turn that ended a day ago, which is past believing.
  localStorage.setItem('chatDrawing:guest:chat-c', JSON.stringify({
    id: 'an-ancient-prompt-id', prompt: 'a dog', startedAt: Date.now() - 86400000
  }));
`);
await send('Page.reload');
await sleep(7000);

check('a generation the server has never heard of is forgotten',
  await waitFor(`!localStorage.getItem('chatGeneration:guest')`, 8000));
/* The picture key is judged by its age and nothing else, because nothing else
   is knowable about a chat nobody is looking at. One from a day ago is swept;
   a recent one is left alone -- it may be a picture that really is being made
   -- and the point is that it no longer holds the generation above open. */
check('  a picture key old enough to be certain about is swept',
  await waitFor(`!localStorage.getItem('chatDrawing:guest:chat-c')`, 8000));
check('  and a recent one is left alone, without holding anything open',
  await evaluate(`!!localStorage.getItem('chatDrawing:guest:chat-b')`));
// The two things the reader actually saw.
check('  nothing says a reply is arriving',
  await evaluate(`!document.querySelector('.busy-elsewhere')`));
check('  and the screen is not dragged to the chat that finished',
  await evaluate(`!document.body.textContent.includes('다 됐습니다')`));

cleanup();
done();
