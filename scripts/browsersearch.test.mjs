// Google in Chrome (server/browserSearch.js): the pacing that keeps it from
// being shown a CAPTCHA, the back-off when it is anyway, and the cleaning of
// what the results page yields. Chrome itself is not started here.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const B = await import(pathToFileURL(path.join(ROOT, 'server/browserSearch.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ switched on */

eq('off unless asked for', B.browserSearchEnabled({}), false);
eq('WEB_SEARCH_BROWSER=chrome switches it on', B.browserSearchEnabled({ WEB_SEARCH_BROWSER: 'chrome' }), true);

/* ------------------------------------------------------------ the pacing */

{
  let t = 1_000_000;
  const pacer = B.createPacer({ now: () => t, random: () => 0.5, gapMs: 10_000, jitterMs: 4_000, perHour: 3, perDay: 5 });
  const first = pacer.reserve(0);
  check('the first search goes at once', first.ok && first.waitMs === 0);
  const tooSoon = pacer.reserve(0);
  eq('the next one straight after is not held', tooSoon.ok, false);
  eq('because of the gap', tooSoon.reason, 'gap');
  eq('which is the gap plus some randomness', tooSoon.retryAt - t, 12_000);
  const waited = pacer.reserve(15_000);
  check('a caller willing to wait is given the wait', waited.ok && waited.waitMs === 12_000);
  t += 60_000;
  check('after the gap it goes at once', pacer.reserve(0).ok);
  t += 60_000;
  const hourly = pacer.reserve(0);
  eq('no more than the hourly allowance', hourly.reason, 'hourly');
  t += 61 * 60_000;
  check('an hour later there is room again', pacer.reserve(0).ok);
  t += 61 * 60_000;
  check('and again', pacer.reserve(0).ok);
  t += 61 * 60_000;
  eq('but no more than the daily allowance', pacer.reserve(0).reason, 'daily');
}

{
  let t = 5_000_000;
  const pacer = B.createPacer({ now: () => t, random: () => 0, gapMs: 1000, jitterMs: 0 });
  const until = pacer.captcha();
  eq('a CAPTCHA keeps it away half an hour', until - t, B.BACKOFF_MS[0]);
  eq('during which nothing goes', pacer.reserve(60 * 60_000).reason, 'captcha');
  t = until + 1;
  check('after which it may try again', pacer.reserve(0).ok);
  eq('a second CAPTCHA keeps it away longer', pacer.captcha() - t, B.BACKOFF_MS[1]);
  t += B.BACKOFF_MS[1] + 1;
  pacer.success();
  eq('a search that worked starts the back-off over', pacer.captcha() - t, B.BACKOFF_MS[0]);
  eq('and the rest is on record', pacer.status().strikes, 1);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browsersearch-'));
  const file = path.join(dir, 'state.json');
  let t = 9_000_000;
  const one = B.createPacer({ now: () => t, file });
  one.reserve(0);
  one.captcha();
  const two = B.createPacer({ now: () => t, file });
  eq('a restart does not shorten the rest after a CAPTCHA', two.reserve(0).reason, 'captcha');
  eq('nor forget the searches already made', two.status().lastHour, 1);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------- results */

{
  const cleaned = B.normaliseGoogleResults([
    { title: '일러스타 페스 - 나무위키', url: 'https://namu.wiki/w/x', snippet: '  2026년 5월 23일\n~24일  ' },
    { title: 'Redirected', url: 'https://www.google.com/url?q=https://illustar.net/&sa=U', snippet: '' },
    { title: 'Images for this', url: 'https://www.google.com/search?tbm=isch&q=x', snippet: '' },
    { title: 'Again', url: 'https://namu.wiki/w/x#s-2', snippet: '' },
    { title: '', url: 'https://empty.example/', snippet: '' },
    { title: 'Maps', url: 'https://maps.google.com/?q=bexco', snippet: '' },
  ], 10);
  eq('each real result once', cleaned.length, 3);
  eq('its summary tidied', cleaned[0].snippet, '2026년 5월 23일 ~24일');
  eq('a Google redirect is unwrapped', cleaned[1].url, 'https://illustar.net/');
  check('Google\'s own search pages are dropped', !cleaned.some(r => r.url.includes('tbm=isch')));
  check('but a map is a real result', cleaned.some(r => r.url.startsWith('https://maps.google.com')));
  eq('and no more than asked for', B.normaliseGoogleResults([
    { title: 'a', url: 'https://a.example/' }, { title: 'b', url: 'https://b.example/' },
  ], 1).length, 1);
}

check('a Korean query is asked in Korean, in Korea', B.googleUrl('일러스타 페스 일정').endsWith('&hl=ko&gl=kr'));
check('others in English', B.googleUrl('ollama keep_alive').endsWith('&hl=en'));
check('no result count in the address, which only scripts ask for', !/num=/.test(B.googleUrl('x')));

/* ------------------------------------------------------------- Chrome */

{
  const args = B.chromeArgs({ profile: 'P', port: 9333 });
  check('without a window', args.includes('--headless=new'));
  check('in a profile of its own', args.includes('--user-data-dir=P'));
  check('without saying it is automated', args.includes('--disable-blink-features=AutomationControlled'));
  check('and never with --enable-automation', !args.some(a => /enable-automation/.test(a)));
  eq('CHROME_PATH is used when it exists', B.findChrome({ CHROME_PATH: 'C:/x/chrome.exe' }, { exists: f => f === 'C:/x/chrome.exe' }), 'C:/x/chrome.exe');
  eq('nothing found is said as nothing', B.findChrome({}, { exists: () => false }), '');
}

check('the page script looks for the CAPTCHA page by its address and its words',
  /\/sorry/.test(B.GOOGLE_EXTRACT) && /unusual traffic/.test(B.GOOGLE_EXTRACT) && /비정상적인 트래픽/.test(B.GOOGLE_EXTRACT));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
