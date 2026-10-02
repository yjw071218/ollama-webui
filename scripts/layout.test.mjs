// Nothing off the edge of a phone, and the conversation alone on paper.
//
// Two problems, one cause: the app is only ever *looked at* on a desktop.
//
// The model picker ran off the top of a 390x844 phone -- measured at -9px, with
// its heading unreachable because a menu scrolls inside itself and there is
// nothing above it to scroll -- and it was found by somebody reporting it, not
// by anything here. `scripts/measure-layout.mjs` has been able to answer
// "what is off the screen" all along, but it is a tool somebody has to think to
// run, and nobody thinks to run it about a screen they did not change.
//
// So this walks the screens at phone size and fails on anything outside the
// window. It is deliberately dumb: no screenshots, no golden files, nothing to
// re-bless. One rule -- a thing you cannot see is a bug -- applied everywhere.
//
// And the same trip answers the other question nobody was asking: what comes
// out of Ctrl+P. There was no print stylesheet at all, so printing a
// conversation printed the application around it. See src/print.css.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const HTTP_PORT = 8193;
const CDP_PORT = 9493;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`); }
};
const done = (code) => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(code ?? (fail === 0 ? 0 : 1));
};

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
  console.log('SKIP  no Chrome or Edge found; nothing was laid out');
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

/* A model list and nothing else. What is under test is where things land, not
   what they talk to -- but a picker with no models in it is a picker that
   cannot be opened, and it is the control this suite was written for. */
const MODELS = [
  { name: 'qwen3.6:35b-a3b', size: 22_621_314_381, details: { parameter_size: '35.5B', quantization_level: 'Q4_K_M' } },
  { name: 'hf.co/unsloth/gemma-4-31B-it-GGUF:Q8_0', size: 33_800_000_000, details: { parameter_size: '30.7B', quantization_level: 'unknown' } },
  { name: 'gemma4:31b', size: 18_400_000_000, details: { parameter_size: '31B', quantization_level: 'Q4_0' } },
  { name: 'qwen3.8:latest', size: 17_700_000_000, details: { parameter_size: '27.3B', quantization_level: 'Q4_K_M' } },
  { name: 'nomic-embed-text:latest', size: 274_000_000, details: { parameter_size: '137M', quantization_level: 'F16' } },
  { name: 'glm-5.1:cloud', size: 0, details: { parameter_size: '', quantization_level: '' } },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: MODELS }));
    return;
  }
  // One of them already on the card, which is the fact the picker exists to
  // show. `/api/ps` answers in the same shape `/api/tags` does.
  if (url.pathname === '/api/ps') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen3.6:35b-a3b', size_vram: 22_621_314_381 }] }));
    return;
  }
  /* A guest, answered properly.
   *
   * Everything else here can 503 without consequence; this one cannot. The
   * session provider remounts the whole app around whatever this says, so a
   * failure is not "no account" -- it is the app being torn down and rebuilt
   * mid-test, with every menu closed and every measurement taken of a screen
   * that had just been thrown away. */
  if (url.pathname === '/api/auth/session') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true, user: null, sessionId: null, csrfToken: null,
      state: null, anyAccounts: false, accounts: [], session: null,
    }));
    return;
  }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, canonicalOrigin: '' }));
    return;
  }
  if (/^\/(api|mcp|localfs|system|studio|music|tts-api|kakao)\//.test(url.pathname)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"not running in the layout test"}');
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

const { launchChrome } = await import('./chromeProfile.mjs');
const chrome = launchChrome(browser, 'webui-chrome-layout-', [
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
/* React's own error boundary puts this on the page. Worth asking about by
   name: a crash makes every measurement after it a measurement of an error
   screen, and "the menu is not open" is a poor way to be told the app fell
   over. The one this suite found first was a `const` read during render from a
   line above the one declaring it -- see README.md, which has three of them. */
const crashed = async () => await evaluate(`(() => {
  const el = document.querySelector('#root > div > pre');
  return el && /Error|error/.test(el.textContent || '') ? el.textContent.slice(0, 200) : '';
})()`);

const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', PHONE);
await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/` });
await sleep(7000);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || ''));
  if (b) { b.click(); return 'clicked'; }
  return 'none';
})()`);
await sleep(4000);
// Navigating and clicking can drop the override, and a measurement taken
// against a desktop viewport is worse than none.
await send('Emulation.setDeviceMetricsOverride', PHONE);
await sleep(600);

/* ------------------------------------------------ the rule, in one function

   Cut off, not merely elsewhere.
 
   The thing worth failing on is an element that is *partly* on the screen: half
   a menu, a row whose right-hand end is past the edge, a heading above the top
   of the window. Something entirely outside it is parked rather than clipped --
   a drawer waiting off-canvas to slide in is the whole of how a drawer works,
   and flagging it would make this suite cry wolf at every screen.
 
   Sideways only, plus the top. Content below the fold is a page you scroll, and
   anything inside a container that scrolls in that direction was put there to
   be scrolled to. */
const OFFENDERS = `(() => {
  const w = window.innerWidth, h = window.innerHeight;
  const scrolls = (el, axis) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const how = getComputedStyle(node)[axis];
      if (how === 'auto' || how === 'scroll') return true;
    }
    return false;
  };
  return [...document.querySelectorAll('body *')]
    .filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      // Wholly outside: parked, not clipped.
      if (r.right <= 0 || r.left >= w || r.bottom <= 0 || r.top >= h) return false;
      const sideways = (r.right > w + 1 || r.left < -1) && !scrolls(el, 'overflowX');
      const above = r.top < -1 && !scrolls(el, 'overflowY');
      return sideways || above;
    })
    .slice(0, 8)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 40),
      left: Math.round(el.getBoundingClientRect().left),
      right: Math.round(el.getBoundingClientRect().right),
      top: Math.round(el.getBoundingClientRect().top),
    }));
})()`;

const WIDTH_OK = `(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}))()`;

const screens = [
  ['the conversation', `(() => 'here')()`],
  ['the model picker', `(() => { document.querySelector('.composer-model-trigger')?.click(); return 'open'; })()`],
  ['the add menu', `(() => {
    document.querySelector('.composer-model-trigger.is-open')?.click();
    document.querySelector('.composer-plus')?.click();
    return 'open';
  })()`],
  ['the chat list', `(() => {
    document.querySelector('.composer-plus.is-open')?.click();
    document.querySelector('.toggle-sidebar')?.click();
    return 'open';
  })()`],
  /* By its shortcut rather than by hunting for a button whose title happens to
     say "settings": the first version of this looked one up by text, found
     something else entirely, and signed the guest out -- which is a page with
     no layout to check and two later failures that say nothing about layout. */
  ['settings', `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
    return 'open';
  })()`],
];

for (const [name, open] of screens) {
  await evaluate(open);
  await sleep(900);
  const width = await json(WIDTH_OK);
  check(`${name} is no wider than the phone`,
    width.scrollWidth <= width.clientWidth + 1,
    `scrollWidth ${width.scrollWidth} against ${width.clientWidth}`);
  const out = await json(OFFENDERS);
  check(`  and nothing on it is off the screen`, out.length === 0, JSON.stringify(out));
}

// Back to the conversation for what follows, the same way somebody would: the
// shortcut that opened it, and Escape for the drawer.
await evaluate(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.querySelector('.sidebar-overlay')?.click();
  return 'closed';
})()`);
await sleep(1200);
check('the app is still the app after all that',
  (await evaluate(`!!document.querySelector('.composer-model-trigger')`)) === true, await crashed());

/* --------------------------------------------------------- the picker itself

   The control this suite was written for, measured where it broke. A menu that
   opens upward from the composer is bounded by the room above the composer, not
   by a fraction of the viewport -- and the two are not the same number. */
{
  await send('Emulation.setDeviceMetricsOverride', { ...PHONE, height: 560 });
  await sleep(600);
  await evaluate(`document.querySelector('.composer-model-trigger')?.click()`);
  await sleep(700);
  const menu = await json(`(() => {
    const el = document.querySelector('.composer-model-menu');
    if (!el) return { open: false };
    const r = el.getBoundingClientRect();
    return {
      open: true, top: Math.round(r.top), bottom: Math.round(r.bottom),
      viewport: window.innerHeight, scrolls: el.scrollHeight > el.clientHeight + 1,
    };
  })()`);
  check('the model picker fits the room above the composer',
    menu.open && menu.top >= 0 && menu.bottom <= menu.viewport + 1, JSON.stringify(menu));

  // What it says about each model, which is what makes a name a choice.
  const rows = await json(`(() => {
    const el = document.querySelector('.composer-model-menu');
    if (!el) return null;
    return {
      search: !!el.querySelector('.model-find input'),
      loaded: [...el.querySelectorAll('.composer-menu-item')]
        .filter(r => r.querySelector('.model-hot'))
        .map(r => r.querySelector('.composer-menu-label').textContent),
      facts: [...el.querySelectorAll('.model-facts')].map(f => f.textContent),
    };
  })()`);
  check('  with a field to search it', rows?.search === true, JSON.stringify(rows));
  check('  the model already on the card marked as such',
    rows?.loaded.length === 1 && rows.loaded[0] === 'qwen3.6:35b-a3b', JSON.stringify(rows?.loaded));
  check('  and what each one is under its name',
    rows?.facts.includes('35.5B · Q4_K_M · 22.6GB'), JSON.stringify(rows?.facts));
  // Ollama says `unknown` for a quantisation it cannot read, and a cloud model
  // weighs nothing. Printing either is worse than printing nothing.
  check('  with nothing made up where there is no answer',
    !rows?.facts.some(f => /unknown|0\.0GB/.test(f)), JSON.stringify(rows?.facts));

  // Typing narrows it. The part of a name people remember is rarely the front.
  await evaluate(`(() => {
    const input = document.querySelector('.model-find input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'q4_k');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(500);
  const filtered = await json(`(() => ({
    open: !!document.querySelector('.composer-model-menu'),
    typed: document.querySelector('.model-find input')?.value ?? null,
    names: [...document.querySelectorAll('.composer-model-menu .composer-menu-item .composer-menu-label')].map(x => x.textContent),
  }))()`);
  check('  typing into it does not take the app down',
    !(await crashed()), await crashed());
  /* `q4_k` appears in no name at all -- it is the quantisation of two of them.
     Matching on it is the whole point: the part of a model somebody remembers
     is rarely the part at the front of its name. */
  check('  and searching matches what a model is, not only its name',
    filtered?.names.length === 2 && filtered.names.every(n => n.startsWith('qwen3.')), JSON.stringify(filtered));
  await evaluate(`document.querySelector('.composer-model-trigger')?.click()`);
  await send('Emulation.setDeviceMetricsOverride', PHONE);
  await sleep(500);
}

/* --------------------------------------------- a picture where it was asked for

   A turn can draw, say something about it, and draw again. Every picture used
   to be appended under the whole message however early it had been asked for,
   so the first picture sat below the sentence about the second. Each one now
   carries the number of the drawing call that made it and is dropped back into
   the gap that call was written in.

   Planted rather than generated: what is under test is where the pictures land
   among the words, and that needs no ComfyUI. */
{
  const DOT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  /* Written where the app keeps its chats: localforage, which is IndexedDB,
     under the key it keeps chats at. A browser that has not signed in writes
     the bare `ollama-sessions`; an account's chats get a suffix. Planted rather
     than generated, because what is under test is where the pictures land among
     the words and that needs no ComfyUI. */
  const plant = async (messages) => {
    const planted = await evaluate(`new Promise((done) => {
      const open = indexedDB.open('localforage');
      open.onsuccess = () => {
        const db = open.result;
        if (![...db.objectStoreNames].includes('keyvaluepairs')) return done('no store yet');
        const tx = db.transaction('keyvaluepairs', 'readwrite');
        tx.objectStore('keyvaluepairs').put(${JSON.stringify(messages)}, 'ollama-sessions');
        tx.oncomplete = () => done('planted');
        tx.onerror = () => done('failed: ' + tx.error);
      };
      open.onerror = () => done('no database');
    })`);
    check('  the chat is planted where the app keeps them', planted === 'planted', String(planted));
    await send('Page.reload');
    await sleep(7000);
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /guest|게스트|계정 없이/i.test(x.textContent || ''));
      if (b) { b.click(); return 'clicked'; }
      return 'none';
    })()`);
    await sleep(4500);
    await send('Emulation.setDeviceMetricsOverride', PHONE);
    await sleep(800);
    /* Opened, because a reload lands on a new empty chat -- the planted one is
       in the list, not on screen. Picked from the list the way anybody would. */
    await evaluate(`(() => {
      document.querySelector('.toggle-sidebar')?.click();
      return 'drawer';
    })()`);
    await sleep(700);
    await evaluate(`(() => {
      const row = document.querySelector('.history-item');
      if (row) row.click();
      return row ? 'opened' : 'no chats';
    })()`);
    await sleep(900);
    await evaluate(`document.querySelector('.sidebar-overlay')?.click()`);
    await sleep(600);
  };

  await plant([{
    id: 'placed-session', title: 'Placed', createdAt: Date.now(), updatedAt: Date.now(), lastModel: '',
    messages: [
      { role: 'user', content: 'two pictures please' },
      {
        role: 'assistant',
        content: [
          'FIRST PARAGRAPH',
          '<TOOL_GENERATE_IMAGE style="anime">a cat</TOOL_GENERATE_IMAGE>',
          'SECOND PARAGRAPH',
          '<TOOL_GENERATE_IMAGE style="anime">a dog</TOOL_GENERATE_IMAGE>',
          'THIRD PARAGRAPH',
        ].join('\n\n'),
        generated: [
          { dataUrl: DOT, filename: 'cat.png', prompt: 'a cat', call: 0 },
          { dataUrl: DOT, filename: 'dog.png', prompt: 'a dog', call: 1 },
        ],
      },
    ],
  }]);

  const order = await json(`(() => {
    const row = [...document.querySelectorAll('.message-row.assistant')].pop();
    if (!row) return { found: false, rows: document.querySelectorAll('.message-row').length };
    const parts = [...row.querySelectorAll('.markdown-body, .msg-generated figcaption')]
      .map(el => (el.classList.contains('markdown-body')
        ? (el.textContent || '').trim()
        : 'PICTURE:' + (el.textContent || '').trim()));
    return { found: true, parts };
  })()`);
  check('the pictures are between the paragraphs, in the order they were asked for',
    order.found && JSON.stringify(order.parts) === JSON.stringify([
      'FIRST PARAGRAPH', 'PICTURE:a cat', 'SECOND PARAGRAPH', 'PICTURE:a dog', 'THIRD PARAGRAPH',
    ]), JSON.stringify(order));

  /* A chat made before any of this has pictures with no number at all. They
     have always been at the bottom, and they stay there. */
  await plant([{
    id: 'old-session', title: 'Old', createdAt: Date.now(), updatedAt: Date.now(), lastModel: '',
    messages: [
      { role: 'user', content: 'one picture please' },
      {
        role: 'assistant',
        content: ['ONLY PARAGRAPH', '<TOOL_GENERATE_IMAGE style="anime">a cat</TOOL_GENERATE_IMAGE>'].join('\n\n'),
        generated: [{ dataUrl: DOT, filename: 'cat.png', prompt: 'a cat' }],
      },
    ],
  }]);
  const older = await json(`(() => {
    const row = [...document.querySelectorAll('.message-row.assistant')].pop();
    return { pictures: row ? row.querySelectorAll('.msg-generated figure').length : -1 };
  })()`);
  check('  and a picture from before this existed is still shown', older.pictures === 1, JSON.stringify(older));
}

/* ------------------------------------------------------------- and on paper

   There was no print stylesheet at all: Ctrl+P printed the sidebar, the header,
   the composer across the bottom of every page, and one screen's worth of a
   scrolling chat. Which is also the whole of "save as PDF" on every platform
   that has one. See src/print.css. */
{
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  await sleep(600);
  const paper = await json(`(() => {
    const gone = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return true;
      const style = getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    };
    const scroller = document.querySelector('.messages-scroll-area');
    return {
      sidebar: gone('.claude-sidebar'),
      header: gone('.main-header'),
      composer: gone('.input-container'),
      toasts: gone('.toast-stack'),
      // The chat is a pane that scrolls inside a fixed height. On paper there
      // is no scrolling: page one would be the whole of what got printed.
      scrollerOverflow: scroller ? getComputedStyle(scroller).overflow : 'missing:' + document.body.innerHTML.length,
      // Ink on paper whatever the theme on screen was.
      background: getComputedStyle(document.body).backgroundColor,
    };
  })()`);
  check('printing leaves out the application around the conversation',
    paper.sidebar && paper.header && paper.composer && paper.toasts, JSON.stringify(paper));
  check('  and lets the conversation run past one page',
    /visible/.test(paper.scrollerOverflow), paper.scrollerOverflow);
  check('  on white, whatever the theme on screen',
    /255,\s*255,\s*255/.test(paper.background), paper.background);
  await send('Emulation.setEmulatedMedia', { media: '' });
}

cleanup();
done();
