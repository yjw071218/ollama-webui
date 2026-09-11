// Copying, on the addresses this app is actually opened from.
//
// `navigator.clipboard` exists only in a secure context, and "secure" means
// HTTPS or localhost — nothing else. That is exactly the case this app does not
// have: `PUBLIC_ORIGIN` exists so a phone can reach the server, which means a
// LAN address or a nip.io hostname, over plain HTTP. Every copy button worked
// on the machine serving the app, because that machine uses localhost, and no
// copy button worked anywhere else.
//
// It failed silently too. `navigator.clipboard.writeText(text)` throws a
// TypeError on `undefined`, nothing caught it, and the line that shows the
// "copied" tick came after the throw — so the button did not even lie, it just
// did nothing at all.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/clipboard.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.clipboard-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { copyText, hasSecureClipboard } = await import(pathToFileURL(out).href);

// Node defines `navigator` as a getter-only property, so it has to be
// redefined rather than assigned.
const setNavigator = (value) => {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
};

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/* ------------------------------------------------ a fake, minimal document */

// Enough DOM for the fallback to run: it creates a textarea, focuses it,
// selects it, asks the document to copy, and removes it again.
const makeDom = ({ execWorks = true } = {}) => {
  const state = { copied: null, appended: 0, removed: 0, focusedAfter: null, selected: false };
  const previous = { focus: () => { state.focusedAfter = 'previous'; } };
  globalThis.document = {
    activeElement: previous,
    body: {
      appendChild: (el) => { state.appended++; state.el = el; },
    },
    createElement: () => ({
      style: {},
      setAttribute() {},
      focus() { state.focusedAfter = 'holder'; },
      select() { state.selected = true; },
      setSelectionRange() {},
      remove() { state.removed++; },
    }),
    execCommand: (cmd) => {
      if (cmd !== 'copy') return false;
      state.copied = state.el ? state.el.value : null;
      return execWorks;
    },
  };
  return state;
};

/* ------------------------------------------- the secure path, where it exists */

let wrote = null;
setNavigator({ clipboard: { writeText: async (t) => { wrote = t; } } });
makeDom();
check('the modern API is used when it is there', await copyText('hello') === true);
check('and gets the text', wrote === 'hello', String(wrote));
check('hasSecureClipboard reports it', hasSecureClipboard() === true);

/* -------------------------------- plain HTTP: no navigator.clipboard at all */

// This is the case that was broken. `navigator.clipboard` is undefined, and the
// old code called `.writeText` straight off it.
setNavigator({});
let dom = makeDom();
check('a missing clipboard API does not throw', await copyText('over http') === true);
check('the fallback copied the text', dom.copied === 'over http', String(dom.copied));
check('hasSecureClipboard says so', hasSecureClipboard() === false);

// The textarea must not be left behind: one per copy would accumulate for the
// life of the page.
check('the temporary element is removed', dom.appended === 1 && dom.removed === 1,
  `appended ${dom.appended}, removed ${dom.removed}`);
// Focus has to go back, or the composer loses it every time anything is copied.
check('focus is returned to where it was', dom.focusedAfter === 'previous', String(dom.focusedAfter));

/* ------------------------- the modern API present but rejecting */

// Not focused, permission refused, an iframe without the right permissions —
// all reject rather than being absent, which is why the fallback runs on
// rejection and not only on absence.
setNavigator({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
dom = makeDom();
check('a rejected write falls back rather than failing', await copyText('rejected') === true);
check('and the fallback got the text', dom.copied === 'rejected', String(dom.copied));

/* ------------------------------------------------- when nothing can copy */

setNavigator({});
dom = makeDom({ execWorks: false });
check('a refused execCommand reports false', await copyText('nope') === false);
check('and still cleans up', dom.removed === 1);

// A caller showing a "copied" tick needs to know; returning true here is what
// made the old button lie in the cases where it did appear.
globalThis.document = undefined;
setNavigator({});
check('no document at all is survivable', await copyText('x') === false);

check('empty text is not a copy', await copyText('') === false);
check('null is not a copy', await copyText(null) === false);

/* ------------------------------- nothing in the app reaches for it directly */

// The scan that keeps this fixed. Any component calling `navigator.clipboard`
// itself is a component that works on localhost and nowhere else.
const files = ['src/App.jsx', 'src/artifacts.jsx', 'src/ModelCompare.jsx', 'src/ui.jsx'];
const offenders = [];
for (const file of files) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  // Strip comments first: the fix is explained in prose in several of these,
  // and a check that punishes writing the explanation down is a bad check.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/navigator\s*\.\s*clipboard/.test(code)) offenders.push(file);
}
check('no component calls navigator.clipboard directly', offenders.length === 0, offenders.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
