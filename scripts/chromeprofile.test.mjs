// A browser test leaves nothing behind in the temp folder.
//
// Reported as: the temp folder had grown to tens of gigabytes. 89 Chrome
// profiles from the live test and a 33GB one from the share-page test, each
// left because `child.kill()` ended only Chrome's main process and the rest of
// its process tree kept the profile's files open, so the `rmSync` after it
// failed -- silently, behind an empty catch. See chromeProfile.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const C = await import(pathToFileURL(path.join(HERE, 'chromeProfile.mjs')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------ the sweep */

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-sweep-test-'));
  const make = (name, ageMs) => {
    const full = path.join(dir, name);
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'x'), 'x');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(full, when, when);
    return full;
  };
  const old = make('webui-chrome-a-OLD', 2 * 60 * 60 * 1000);
  const fresh = make('webui-chrome-a-NEW', 60 * 1000);
  const other = make('someone-else-OLD', 2 * 60 * 60 * 1000);
  const removed = C.sweepProfiles('webui-chrome-a-', { dir });
  check('a leftover more than an hour old is cleared', !fs.existsSync(old) && removed === 1);
  check('one from a run that may still be going is not', fs.existsSync(fresh));
  check('and nothing with another name is touched', fs.existsSync(other));
  fs.rmSync(dir, { recursive: true, force: true });
}

check('removing what is not there is not a failure', C.removeProfile(path.join(os.tmpdir(), 'webui-never-existed-xyz')) === true);

/* --------------------------------------------------------- a real browser */

const BROWSERS = [
  `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium',
];
const browser = BROWSERS.find(p => p && fs.existsSync(p));
if (!browser) {
  console.log('SKIP  no browser here to launch');
} else {
  const port = 9444;
  const chrome = C.launchChrome(browser, 'webui-chrome-selftest-', [
    '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`,
  ]);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch (e) { await sleep(250); }
  }
  check('the browser starts in its own profile', up && fs.existsSync(chrome.profile));
  // A page, so the renderer and GPU processes -- the ones that held the files -- exist.
  try { await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }); } catch (e) { /* older browser */ }
  await sleep(800);
  const removed = chrome.close();
  check('and on close its profile is gone', removed && !fs.existsSync(chrome.profile), chrome.profile);
  let still = false;
  try { still = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch (e) { still = false; }
  check('with the browser itself', !still);
  check('closing twice is harmless', chrome.close() === true);
}

/* ------------------------------------------------------------ the wiring */

for (const file of ['live.test.mjs', 'sharepage.test.mjs', 'smoke.test.mjs', 'composer.test.mjs', 'startup.test.mjs', 'measure-layout.mjs']) {
  const source = fs.readFileSync(path.join(HERE, file), 'utf8');
  check(`${file} launches through launchChrome`, /launchChrome\(browser, '/.test(source));
  check(`${file} no longer kills only the main process`, !/child\.kill\(\)/.test(source));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
