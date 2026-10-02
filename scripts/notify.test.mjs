// Telling somebody a long job finished, when they are not looking.
//
// A picture is ninety seconds and a video several minutes, and the sensible
// thing to do with that time is go and do something else -- which is exactly
// what this app could not survive. The tab title already grows a tick, and a
// tick is only found by going back and looking, which is the thing being
// avoided.
//
// Three sharp edges, and every one of them fails quietly:
//
//   * `Notification` does not exist on a page served over plain HTTP, which is
//     how this app is very often opened so a phone can reach it. The feature
//     has to become nothing, and say so, rather than look broken.
//   * Permission is a one-shot. Asked and refused, it stays refused, and asking
//     again does nothing at all -- so it is asked at the moment somebody turns
//     the setting on and never on load.
//   * A notification from a page dies with the page, and Android refuses to
//     make one at all. The service worker's outlives the tab, so that is what
//     is tried first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A browser, as much of one as this needs. `Notification` is a function with a
   `permission` property and a `requestPermission`, which is exactly the shape
   the module tests for. */
const browser = ({ permission = 'default', request = null, worker = undefined, visibility = 'visible' } = {}) => {
  const shown = [];
  function Notification(title, options) { shown.push({ via: 'page', title, options }); }
  Notification.permission = permission;
  Notification.requestPermission = request || (() => Promise.resolve('granted'));
  globalThis.window = { Notification };
  globalThis.document = { visibilityState: visibility };
  // Node defines `navigator` as a getter-only global, so it is replaced rather
  // than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: worker === undefined ? {} : { serviceWorker: worker },
  });
  return shown;
};

const N = await import(pathToFileURL(path.join(ROOT, 'src/notify.js')).href);

/* ------------------------------------------------------ what can be said here */

browser({ permission: 'default' });
eq('a browser that can notify says so', N.notifyState(), 'default');
browser({ permission: 'granted' });
eq('and one that has been allowed', N.notifyState(), 'granted');
/* Plain HTTP is not a refusal, it is a different problem with a different fix:
   one is a browser setting, the other is serving this app over HTTPS. */
globalThis.window = {};
eq('a page with no Notification at all is unsupported, not denied', N.notifyState(), 'unsupported');
check('  and asking is answered rather than thrown', await N.askToNotify() === 'unsupported');

/* ----------------------------------------------------------------- asking once */

{
  let asked = 0;
  browser({ permission: 'default', request: () => { asked += 1; return Promise.resolve('granted'); } });
  eq('the question is put, and the answer returned', await N.askToNotify(), 'granted');
  eq('  once', asked, 1);
}
{
  let asked = 0;
  browser({ permission: 'denied', request: () => { asked += 1; return Promise.resolve('granted'); } });
  // Refused is refused until somebody changes it in site settings; asking again
  // does nothing but cost a round trip through a dialog that never appears.
  eq('an answer already given is not asked for again', await N.askToNotify(), 'denied');
  eq('  and nothing was asked', asked, 0);
}
{
  // Safari's older signature takes a callback and returns undefined.
  browser({ permission: 'default', request: (done) => { done('granted'); } });
  eq('the callback form is understood too', await N.askToNotify(), 'granted');
}
{
  browser({ permission: 'default', request: () => { throw new Error('nope'); } });
  eq('and a browser that throws is a no, not a crash', await N.askToNotify(), 'denied');
}

/* ------------------------------------------------------------------- showing one */

{
  const shown = browser({ permission: 'denied' });
  check('nothing is shown without permission', await N.notify('x') === false && shown.length === 0);
}
{
  const shown = browser({ permission: 'granted' });
  check('with permission and no worker, the page shows it',
    await N.notify('Ready', { body: 'A chat' }) === true && shown.length === 1 && shown[0].via === 'page');
  eq('  with what it was given', [shown[0].title, shown[0].options.body], ['Ready', 'A chat']);
}
{
  /* The worker's, where there is one. A page's notification dies with the page
     and Android Chrome refuses to make one at all, so this is the path that
     actually works on the device this feature is for. */
  const viaWorker = [];
  const shown = browser({
    permission: 'granted',
    worker: { getRegistration: () => Promise.resolve({ showNotification: (title, options) => { viaWorker.push({ title, options }); } }) },
  });
  await N.notify('Ready', { body: 'A chat', tag: 'turn:5', data: { chat: '5' } });
  check('the service worker shows it when there is one', viaWorker.length === 1 && shown.length === 0);
  eq('  tagged by conversation, so a batch is one piece of news, not four',
    viaWorker[0].options.tag, 'turn:5');
  eq('  and carrying the chat to open', viaWorker[0].options.data, { chat: '5' });
}
{
  // A registration that throws, or one with no showNotification: neither is a
  // reason to show nothing when the page itself can.
  const shown = browser({ permission: 'granted', worker: { getRegistration: () => Promise.reject(new Error('gone')) } });
  check('a broken registration falls back to the page', await N.notify('Ready') === true && shown.length === 1);
}

/* --------------------------------------------------------- is anybody looking */

browser({ visibility: 'visible' });
check('a tab in front is attended', N.unattended() === false);
browser({ visibility: 'hidden' });
check('and one in the background is not', N.unattended() === true);

delete globalThis.window;
delete globalThis.document;

/* ------------------------------------------------------------------ the wiring */

const app = read('src/App.jsx');
// Off until asked for. A notification nobody asked for is the reason people
// turn notifications off.
check('the setting is off by default',
  /readStr\('notifyWhenDone', 'false'\) === 'true'/.test(app));
check('and remembered', /setSetting\('notifyWhenDone', String\(notifyWhenDone\)\)/.test(app));
// The moment it is switched on is the only moment the question can be put.
check('permission is asked when it is switched on, not on load',
  /const answer = await askToNotify\(\);/.test(app)
  && /setNotifyWhenDone\(answer === 'granted'\);/.test(app));
check('  and a no puts the switch back and says which no it was',
  /t\(answer === 'unsupported' \? 'notify\.unsupported' : 'notify\.denied'\)/.test(app));
// Nothing is said about something already on screen: that is how a feature
// earns its way into the list of things people switch off.
check('nothing is said while the tab is in front',
  /if \(!notifyWhenDone \|\| !unattended\(\)\) return;/.test(app));
check('it rides with the tab-title mark rather than counting the edge twice',
  /announceFinished\(lastTurnChatRef\.current\);/.test(app));
// A turn can now finish in two places: here, and on a device this one is
// following. Both are the same piece of news.
check('and an answer finishing on another device is announced too',
  /if \(wasFollowingRef\.current && !live && followed\?\.content\) announceFinished\(followed\.chat\);/.test(app));

const sw = read('public/sw.js');
check('the worker handles the click', /addEventListener\('notificationclick'/.test(sw));
// Without this, a click opens a *second* copy of the app on the desktop and
// does nothing at all on Android -- so the reader ends up looking at a cold
// window while the answer sits in the one they already had.
check('  focusing a window that is already open before opening another',
  /client\.focus\(\)/.test(sw) && /openWindow\(wanted\)/.test(sw));
check('  and saying which conversation it was about',
  /postMessage\(\{ type: 'OPEN_CHAT', url: wanted \}\)/.test(sw));
check('which the app takes it to', /event\.data\?\.type !== 'OPEN_CHAT'/.test(app)
  && /setCurrentSessionId\(found\.id\)/.test(app));

const i18n = read('src/i18n.jsx');
for (const key of ['notify.label', 'notify.help', 'notify.ready', 'notify.denied', 'notify.unsupported']) {
  check(`${key} is translated everywhere`, (i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length === 12);
}

/* ================================ and the half that works with the app shut

   A notification put up by the page needs the page. Close the tab, or lock the
   phone long enough for the browser to discard it, and nothing is left running
   to say anything -- which is the whole of the wait this feature is for. Web
   Push survives it. See server/push.js for why these carry no payload. */

// A database of its own, so this never goes near the real one.
process.env.WEBUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-push-'));
const P = await import(pathToFileURL(path.join(ROOT, 'server/push.js')).href);

{
  const key = P.pushPublicKey();
  // 65 bytes, uncompressed. It is the only form `applicationServerKey` takes,
  // and a key of any other length is refused by the browser with no clue why.
  eq('the server has a key a browser can subscribe with', Buffer.from(key, 'base64url').length, 65);
  eq('  and the same one next time', P.pushPublicKey(), key);
  P.forgetPushKeys();
  eq('  even after a restart', P.pushPublicKey(), key);
}

{
  const token = P.vapidToken('https://fcm.googleapis.com/fcm/send/abc', 'mailto:me@example.com');
  const [header, body, signature] = token.split('.');
  eq('the token says how it was signed',
    JSON.parse(Buffer.from(header, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  // For the push service, not for this app. Getting it wrong is a 401 that
  // says nothing else about why.
  eq('  and who it is for',
    JSON.parse(Buffer.from(body, 'base64url').toString()).aud, 'https://fcm.googleapis.com');
  /* Raw r||s, not DER. `crypto.sign` gives a DER-wrapped ECDSA signature by
     default and JWS wants the pair; a DER one is a bad signature, which is
     another 401 with nothing in it. */
  eq('  with a signature of the shape JWS asks for', Buffer.from(signature, 'base64url').length, 64);
}

{
  P.rememberSubscription('user-a', { endpoint: 'https://push.example/one' }, '답변이 준비됐습니다');
  P.rememberSubscription('user-a', { endpoint: 'https://push.example/two' }, '답변이 준비됐습니다');
  P.rememberSubscription('user-b', { endpoint: 'https://push.example/three' }, 'Ready');
  eq('a browser is remembered per account', P.subscriptionsFor('user-a').length, 2);
  eq('  and not for another one',
    P.subscriptionsFor('user-b').map(r => r.endpoint), ['https://push.example/three']);
  eq('  with the sentence it asked to be told in', P.subscriptionLabel('user-a'), '답변이 준비됐습니다');
  // An endpoint is a URL a push service gave the browser. Anything else is
  // somebody asking this server to make requests on their behalf.
  eq('anything that is not an https endpoint is refused',
    P.rememberSubscription('user-a', { endpoint: 'http://192.168.0.5/internal' }), false);
  eq('  including one that is not a URL at all',
    P.rememberSubscription('user-a', { endpoint: 'nope' }), false);

  const tried = [];
  const sent = await P.sendPush('user-a', {
    fetchImpl: async (url, init) => {
      tried.push({ url, auth: init.headers.Authorization, body: init.body });
      return { ok: true, status: 201 };
    },
  });
  eq('one push per browser of that account', sent, 2);
  check('  signed, with the key it can be checked against',
    tried.every(t => /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(t.auth)), JSON.stringify(tried[0]));
  // No payload means no encryption to write, and no encryption to get wrong.
  check('  and carrying nothing that would have to be encrypted',
    tried.every(t => t.body === undefined), JSON.stringify(tried[0]));
  // A subscription outlives the browser that made it, and nothing else ever
  // cleans them up: a dead one would be tried for ever.
  await P.sendPush('user-a', { fetchImpl: async () => ({ ok: false, status: 410 }) });
  eq('a subscription the service says is gone is forgotten', P.subscriptionsFor('user-a').length, 0);
}

{
  P.forgetFinished();
  eq('nothing has finished yet', P.lastFinished('user-c'), null);
  P.noteFinished('user-c', 'image');
  eq('and then something has', P.lastFinished('user-c')?.kind, 'image');
}

const pushApi = read('server/api.js');
for (const route of ['/api/push/key', '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/last']) {
  check(`${route} is handled`, pushApi.includes(`route('${route}'`));
}
// The three places work finishes, and none of them needs a browser to be open
// to notice -- which is the entire point of a push.
check('an answer finishing sends one',
  /onFinished: \(job\) => \{[\s\S]{0,240}sendPush\(job\.owner\)/.test(read('server/chatJobs.js')));
check('a picture finishing sends one',
  /noteFinished\(identify\(req\), finished\.kind \|\| 'image'\)/.test(read('server/studio.js')));
check('a song finishing sends one',
  /noteFinished\(identify\(req\), 'music'\)/.test(read('server/music.js')));

check('the worker is woken by it', /addEventListener\('push'/.test(sw));
// A push arrives whether or not the reader is watching the answer arrive. The
// same rule the in-page half applies, enforced where the push lands.
check('  and says nothing to somebody already looking at the app',
  /client\.visibilityState === 'visible' && client\.focused/.test(sw));
check('  asking what it was, since it was sent with no payload',
  /fetch\('\/api\/push\/last'/.test(sw));

check('the app subscribes when the setting is switched on',
  /subscribeToPush\(t\('notify\.ready'\), \{ cliReset: t\('notify\.cliReset'\) \}\);/.test(app));
check('  handing over the sentence, because a worker has no translations',
  /export const subscribeToPush = async \(label = '', labels = null\)/.test(read('src/notify.js')));
check('  and the other sentences it may need, by kind',
  /labels \? \{ labels \} : \{\}/.test(read('src/notify.js')));
check('a CLI back from its limit is said in its own sentence',
  /last\.kind === 'cli-reset'/.test(sw) && /labels\.cliReset/.test(sw));
check('  and stops when it is switched off', /unsubscribeFromPush\(\);/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
