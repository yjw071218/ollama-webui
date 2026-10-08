// What the apps ask of the page (src/nativeEvents.js), and the per-client
// panel widths (src/clientKind.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientKind, panelKey, legacyWidth } from '../src/clientKind.js';
import { listenNative, dispatchNative, tellNativeBusy, QUEUE, EVENT } from '../src/nativeEvents.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ------------------------------------------------------------ client kind
check('a browser is a browser', clientKind({}) === 'browser');
check('the Windows app says so', clientKind({ ollamaNative: { platform: 'desktop' } }) === 'desktop');
check('the Android app says so', clientKind({ ollamaNative: { platform: 'android' } }) === 'android');
check('anything else is a browser', clientKind({ ollamaNative: { platform: 'x' } }) === 'browser');
check('widths are kept per client', panelKey('artifactWidth', { ollamaNative: { platform: 'desktop' } }) === 'artifactWidth@desktop'
  && panelKey('artifactWidth', {}) === 'artifactWidth@browser');
const store = (o) => ({ getItem: (k) => (k in o ? o[k] : null) });
check('an existing width is carried over', legacyWidth('artifactWidth', 620, store({ artifactWidth: '700' })) === 700);
check('none saved: the default', legacyWidth('artifactWidth', 620, store({})) === 620);
check('a broken one: the default', legacyWidth('artifactWidth', 620, store({ artifactWidth: 'NaN' })) === 620);

// The saved width is not overwritten by the clamp to the window.
const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
check('the panel shows a clamped width', /shownArtifactWidth = useMemo\(\(\) => clamp\(artifactWidth, 320, artifactMaxWidth\(\)\)/.test(app));
check('... and the resize no longer writes the clamp back', !/setArtifactWidth\(w => clamp\(/.test(app) && !/setSidebarWidth\(w => clamp\(/.test(app));
check('... the panel and its handle use the shown width', /'--artifact-width': `\$\{shownArtifactWidth\}px`/.test(app) && /getSize=\{\(\) => shownArtifactWidth\}/.test(app));
check('... saved per client', /usePersistedNumber\(panelKey\('artifactWidth'\)/.test(app) && /usePersistedNumber\(panelKey\('sidebarWidth'\)/.test(app));

// --------------------------------------------------------------- requests
const seen = [];
const handlers = { newChat: () => seen.push('new'), share: (p) => seen.push(p) };
check('a new chat', dispatchNative({ type: 'new-chat' }, handlers) && seen[0] === 'new');
const b64 = Buffer.from('hello').toString('base64');
dispatchNative({ type: 'share', text: ' a link ', files: [{ name: 'a.txt', type: 'text/plain', data: b64 }] }, handlers);
const shared = seen[1];
check('a share brings its files', shared.files.length === 1 && shared.files[0].name === 'a.txt' && shared.files[0].size === 5 && shared.files[0].type === 'text/plain');
check('... and its text, trimmed', shared.text === 'a link');
check('an empty share is nothing', !dispatchNative({ type: 'share', files: [] }, handlers));
check('an unknown request is ignored', !dispatchNative({ type: 'later' }, handlers) && !dispatchNative(null, handlers));

// A request made before the page listened is taken from the queue.
const listeners = {};
const win = {
  [QUEUE]: [{ type: 'new-chat' }],
  addEventListener: (n, f) => { listeners[n] = f; },
  removeEventListener: (n) => { delete listeners[n]; },
};
const got = [];
const stop = listenNative({ newChat: () => got.push('new') }, win);
check('a request queued before the page listened is handled', got.length === 1 && win[QUEUE].length === 0);
win[QUEUE].push({ type: 'new-chat' }); listeners[EVENT]();
check('... and one queued after, on the event', got.length === 2);
stop();
check('stopping removes the listener', !listeners[EVENT]);

// The Windows app calls back instead.
let callback = null, offCalled = false;
const desk = { addEventListener() {}, removeEventListener() {}, ollamaNative: { onAction: (f) => { callback = f; return () => { offCalled = true; }; } } };
const fromDesk = [];
const stopDesk = listenNative({ newChat: () => fromDesk.push(1) }, desk);
callback({ type: 'new-chat' });
check('the Windows app calls back', fromDesk.length === 1);
stopDesk();
check('... and is told to stop', offCalled);

let busy = null;
tellNativeBusy(1, { ollamaNative: { busy: (b) => { busy = b; } } });
check('the app is told when an answer is being written', busy === true);
tellNativeBusy(true, {});
check('a browser is not bothered', true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
