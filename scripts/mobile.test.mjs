// The two things a phone can do that a desktop cannot, and the layout rule
// that stops the bottom of the app running off the side of the screen.
//
// Measured on a 390x844 phone before the layout fix: the footer laid the token
// meter, the thinking switch and the MCP switch across one row whose minimum
// width is about 470px. None of them can shrink -- each is an icon beside a
// word -- so the row simply grew, the browser shrank the whole page to fit
// (window.innerWidth came back as 429 against a 390 screen), and the meter hung
// off the left edge at -30px while the MCP switch hung off the right at 420.
//
// The fix is one property, `flex-wrap`, and one class to hang it on, because
// the row was inline-styled and a media query cannot override an inline style
// without `!important` on every line. Both are asserted here.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundleOne = async (entry, out) => {
  const bundle = await rolldown({ input: path.resolve(HERE, entry), platform: 'neutral' });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ============================================================ sharing ==== */

const share = await bundleOne('../src/share.js', '../node_modules/.share-test-bundle.mjs');
const { canShare, shareText, shareBody } = share;

// ---- what gets sent

eq('the question comes first', shareBody({ question: 'why?', answer: 'because' }),
  'Q. why?\n\nbecause');
eq('the model is credited last', shareBody({ question: 'why?', answer: 'because', model: 'qwen3' }),
  'Q. why?\n\nbecause\n\n— qwen3');
eq('an answer with no question still shares', shareBody({ answer: 'because' }), 'because');
eq('nothing at all shares nothing', shareBody({}), '');
eq('whitespace is not an answer', shareBody({ question: '  ', answer: '  ' }), '');
eq('called with no argument at all', shareBody(), '');

// ---- whether there is a sheet to open

// Node defines `navigator` as a getter-only property, so it has to be
// redefined rather than assigned.
const setGlobal = (name, value) => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

const withGlobals = async (navigatorPatch, windowPatch, run) => {
  const savedNav = globalThis.navigator, savedWin = globalThis.window;
  setGlobal('navigator', navigatorPatch);
  setGlobal('window', windowPatch);
  try { return await run(); } finally {
    setGlobal('navigator', savedNav); setGlobal('window', savedWin);
  }
};

eq('no share function, no sheet',
  await withGlobals({}, { isSecureContext: true }, () => canShare()), false);
eq('a share function and a secure page, yes',
  await withGlobals({ share: () => {} }, { isSecureContext: true }, () => canShare()), true);

// The app is reached over plain http on a home network constantly, and
// `navigator.share` throws there rather than reporting itself absent.
eq('an insecure page, no',
  await withGlobals({ share: () => {} }, { isSecureContext: false }, () => canShare()), false);

// ---- what the outcomes mean

eq('nothing to share is not attempted',
  await withGlobals({ share: async () => {} }, { isSecureContext: true },
    () => shareText({ text: '   ' })), 'failed');

eq('a sheet that accepts reports shared',
  await withGlobals({ share: async () => {} }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'shared');

// Dismissing the sheet is a decision, not a failure. Reporting it as one would
// pop a red error at somebody who deliberately chose not to share.
const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
eq('a dismissed sheet is cancelled, not failed',
  await withGlobals({ share: async () => { throw abort; } }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'cancelled');

const denied = Object.assign(new Error('no gesture'), { name: 'NotAllowedError' });
eq('a refused gesture is treated the same way',
  await withGlobals({ share: async () => { throw denied; } }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'cancelled');

eq('any other throw is a failure the caller should fall back from',
  await withGlobals({ share: async () => { throw new TypeError('nope'); } }, { isSecureContext: true },
    () => shareText({ text: 'hello' })), 'failed');

eq('a browser with no sheet says so, so the caller can copy instead',
  await withGlobals({}, { isSecureContext: true }, () => shareText({ text: 'hello' })), 'unsupported');

// A title is optional and must not be invented: some targets show it and an
// empty one reads as a blank subject line.
let sawKeys = null;
await withGlobals({ share: async (data) => { sawKeys = Object.keys(data).sort().join(','); } },
  { isSecureContext: true }, () => shareText({ text: 'hello' }));
eq('no title means no title key', sawKeys, 'text');
await withGlobals({ share: async (data) => { sawKeys = Object.keys(data).sort().join(','); } },
  { isSecureContext: true }, () => shareText({ title: 'A chat', text: 'hello' }));
eq('a title is passed when there is one', sawKeys, 'text,title');

/* ========================================================== wake lock ==== */

const wake = await bundleOne('../src/wakeLock.js', '../node_modules/.wake-test-bundle.mjs');
const { wakeLockSupported, holdScreenAwake } = wake;

const fakeDocument = () => {
  const listeners = {};
  return {
    visibilityState: 'visible',
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    removeEventListener: (name, fn) => {
      listeners[name] = (listeners[name] || []).filter(f => f !== fn);
    },
    fire: (name) => (listeners[name] || []).slice().forEach(fn => fn()),
    count: (name) => (listeners[name] || []).length,
  };
};

const withWake = async (navigatorPatch, doc, run) => {
  const savedNav = globalThis.navigator, savedDoc = globalThis.document;
  setGlobal('navigator', navigatorPatch);
  setGlobal('document', doc);
  try { return await run(); } finally {
    setGlobal('navigator', savedNav); setGlobal('document', savedDoc);
  }
};

eq('no wakeLock, unsupported', await withWake({}, fakeDocument(), () => wakeLockSupported()), false);
eq('a wakeLock, supported',
  await withWake({ wakeLock: { request: async () => ({}) } }, fakeDocument(), () => wakeLockSupported()), true);

// An unsupported browser must still hand back something callable: the caller
// is a React effect and returning a non-function from one is an error.
await withWake({}, fakeDocument(), async () => {
  const stop = holdScreenAwake();
  check('unsupported still returns a release function', typeof stop === 'function');
  stop();
});

// The lock is taken, and released when the caller says so.
{
  const doc = fakeDocument();
  let taken = 0, releases = 0;
  const sentinel = { addEventListener: () => {}, release: async () => { releases++; } };
  await withWake({ wakeLock: { request: async () => { taken++; return sentinel; } } }, doc, async () => {
    const stop = holdScreenAwake();
    await new Promise(r => setTimeout(r, 0));
    eq('the lock is taken', taken, 1);
    eq('and a visibility listener is watching', doc.count('visibilitychange'), 1);
    stop();
    await new Promise(r => setTimeout(r, 0));
    eq('releasing releases it', releases, 1);
    eq('and stops watching', doc.count('visibilitychange'), 0);
  });
}

// The system takes the lock away whenever the page hides and does not give it
// back. Without re-taking it, the second half of any answer the reader looked
// away from is unprotected -- which is the whole failure this guards against.
{
  const doc = fakeDocument();
  let taken = 0;
  // Modelled on the spec: a sentinel carries `released`, and the system sets
  // it when the page hides. Nothing fires a `release` event here, because a
  // browser that revoked the lock while nothing was listening is exactly the
  // case that must still recover.
  let live = null;
  const request = async () => {
    taken++;
    live = { released: false, addEventListener: () => {}, release: async () => { live.released = true; } };
    return live;
  };
  const oldFire = doc.fire;
  doc.fire = (name) => {
    if (name === 'visibilitychange' && doc.visibilityState === 'hidden' && live) live.released = true;
    oldFire(name);
  };
  await withWake({ wakeLock: { request } }, doc, async () => {
    const stop = holdScreenAwake();
    await new Promise(r => setTimeout(r, 0));
    eq('taken once', taken, 1);
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 0));
    eq('hiding does not take another', taken, 1);
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 0));
    eq('coming back takes it again', taken, 2);
    stop();
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    await new Promise(r => setTimeout(r, 0));
    eq('and after release it stays released', taken, 2);
  });
}

// A refused lock -- low battery, a permissions policy -- must leave the app
// working exactly as before. This is an improvement, not a requirement.
{
  const doc = fakeDocument();
  await withWake({ wakeLock: { request: async () => { throw new Error('denied'); } } }, doc, async () => {
    let threw = false;
    try {
      const stop = holdScreenAwake();
      await new Promise(r => setTimeout(r, 0));
      stop();
    } catch (e) { threw = true; }
    check('a refused lock does not throw', !threw);
  });
}

/* ====================================================== the phone layout == */

const css = [
  fs.readFileSync(path.resolve(HERE, '../src/index.css'), 'utf8'),
  fs.readFileSync(path.resolve(HERE, '../src/extras.css'), 'utf8'),
].join('\n').replace(/\r\n/g, '\n');
const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');

// The row must be a class, not an inline style: a media query cannot override
// an inline style, and every phone rule for this row is a media query.
check('the footer controls are a class, not an inline style',
  /className="composer-controls"/.test(app));
check('and the footer itself is too',
  /className="input-footer">/.test(app));
check('no inline flex is left on the footer',
  !/className="input-footer" style=/.test(app));

// The one property that stops the page being wider than the phone.
check('the control row wraps', /\.composer-controls\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
check('the footer wraps too', /\.input-footer\s*\{[^}]*flex-wrap:\s*wrap/.test(css));

// `space-between` is right for one row and wrong for a wrapped one: it strands
// the third item under a gap the width of the screen.
check('a wrapped row is centred rather than spread',
  /@media[^{]*860px[\s\S]*?\.composer-controls\s*\{[^}]*justify-content:\s*center/.test(css));

// Each control may give ground so that two can share a line.
check('the controls are allowed to shrink on a phone',
  /\.ctx-meter,\s*\n?\s*\.mcp-toggle-container,\s*\n?\s*\.think-toggle\s*\{[^}]*min-width:\s*0/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
