// Measures the rendered layout at a given viewport, so a responsive problem is
// a number rather than an impression of a screenshot.
//
//   node scripts/measure-layout.mjs 390 844
//
// Drives Edge or Chrome over the DevTools protocol. Nothing here is part of the
// app; it exists because "looks cut off" is not something you can act on.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIDTH = Number(process.argv[2] || 390);
const HEIGHT = Number(process.argv[3] || 844);
const URL_ = process.argv[4] || 'http://localhost:5173/';
const PORT = 9333;

const BROWSERS = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) { console.error('No Edge or Chrome found.'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  // Windows display scaling otherwise makes --window-size disagree with the
  // emulated viewport, so the numbers describe one page and the screenshot
  // another. The override below is the single source of size.
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const target = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('The browser never opened a debugging port.');
};

const ws = await (async () => {
  const url = await target();
  const socket = new WebSocket(url);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  return socket;
})();

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true,
});
// A session cookie can be planted first, which is how the state a provider
// redirect leaves behind gets exercised without completing a real consent.
if (process.env.COOKIE) {
  const [name, value] = process.env.COOKIE.split('=');
  await send('Network.enable');
  await send('Network.setCookie', {
    name, value, domain: 'localhost', path: '/', httpOnly: true,
  });
}

await send('Page.navigate', { url: URL_ });
await sleep(6000);

// Navigation can drop the override, so it is re-applied once the page is up.
// Without this the measurements silently describe a desktop viewport.
// The auth screen stands in front of everything on a fresh profile. Step past
// it as a guest so the layout under test is the one people actually use.
if (process.env.AS_GUEST === '1') {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('button')]
        .find(b => /guest|게스트|계정 없이/i.test(b.textContent || ''));
      if (button) { button.click(); return 'clicked'; }
      return 'not found';
    })()`,
    returnByValue: true,
  });
  await sleep(3000);
}

// Click a named button and report where the page ended up, so a login flow can
// be driven rather than reasoned about.
if (process.env.CLICK_TEXT) {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const re = new RegExp(${JSON.stringify(process.env.CLICK_TEXT)}, 'i');
      const b = [...document.querySelectorAll('button')].find(x => re.test(x.textContent || ''));
      if (!b) return 'not found';
      b.click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  await sleep(Number(process.env.CLICK_WAIT || 5000));
}

// Open the drawer if asked, so its layout can be measured too.
if (process.env.OPEN_DRAWER === '1') {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const t = document.querySelector('.toggle-sidebar');
      if (t) { t.click(); return 'toggled'; }
      return 'no toggle';
    })()`,
    returnByValue: true,
  });
  await sleep(1200);
}

const probe = process.env.PROBE || `(() => {
  const doc = document.documentElement;
  const wide = [...document.querySelectorAll('*')]
    .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 12)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && el.className.toString().slice(0, 48)) || '',
      right: Math.round(el.getBoundingClientRect().right),
      width: Math.round(el.getBoundingClientRect().width),
    }));
  return JSON.stringify({
    viewport: window.innerWidth,
    scrollWidth: doc.scrollWidth,
    overflowing: doc.scrollWidth > window.innerWidth,
    offenders: wide,
  }, null, 2);
})()`;

// Applied last of all: clicking through the app can reset it, and a
// measurement taken against a desktop viewport is worse than none.
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true,
});
await sleep(1200);

const { result } = await send('Runtime.evaluate', {
  expression: probe, returnByValue: true, awaitPromise: true,
});
console.log(result?.result?.value ?? '(no result)');

// A screenshot taken through the emulated viewport, unlike --window-size, is
// what the page actually looks like on a phone: the viewport meta tag only
// applies under mobile emulation.
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.result?.data) {
  const out = process.env.SHOT_PATH || `layout-${WIDTH}x${HEIGHT}.png`;
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`screenshot: ${out}`);
}

ws.close();
child.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* windows lock */ }
