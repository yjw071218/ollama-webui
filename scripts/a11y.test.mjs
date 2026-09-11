// Whether the dialogs can be used without a mouse or without sight.
//
// Every dialog in this app was a plain `<div>`. Three consequences, all the
// same omission and all affecting the same people:
//
//   * Nothing said it was a dialog, so a screen reader carried on announcing
//     the conversation behind the overlay as though it were still the page.
//   * Nothing held the keyboard, so Tab walked straight out of the open dialog
//     into the chat list underneath — which is covered, so you could not see
//     where the focus had gone.
//   * Nothing gave focus back on close, so after shutting Settings the next
//     Tab started again from the top of the document.
//
// Keyboard navigation of the transcript was added first, which makes this the
// obvious next thing: there is no point being able to reach a dialog by
// keyboard if you cannot get out of it again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.resolve(HERE, '../src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const ui = fs.readFileSync(path.resolve(HERE, '../src/ui.jsx'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/* ------------------------------------------------------ every dialog says so */

// The overlays that hold a dialog. Each must carry the role, the modal flag
// and a name — a dialog announced as "dialog" and nothing else is barely
// better than one not announced at all.
const dialogs = [...app.matchAll(/className="(settings-modal|attachment-viewer-box|cmd-palette)"[^>]*>/g)]
  .map(m => m[0]);

check('the dialogs were found', dialogs.length >= 8, `${dialogs.length} found`);
for (const [i, markup] of dialogs.entries()) {
  const name = (markup.match(/className="([\w-]+)"/) || [])[1];
  check(`dialog ${i + 1} (${name}) has a role`, /role="dialog"/.test(markup), markup.slice(0, 90));
  check(`dialog ${i + 1} (${name}) is modal`, /aria-modal="true"/.test(markup));
  check(`dialog ${i + 1} (${name}) has a name`, /aria-label=/.test(markup), markup.slice(0, 120));
}

// Names come from the translation tables, not from English written into the
// markup — the app is in twelve languages and a screen reader should hear the
// one the reader chose.
const labels = [...app.matchAll(/role="dialog"[\s\S]{0,200}?aria-label=\{([^}]+)\}/g)].map(m => m[1]);
check('every dialog name is translated or derived from content',
  labels.length > 0 && labels.every(l => /\bt\(/.test(l) || /\?\.|\|\||openCitation|viewingAttachment|folderDialog/.test(l)),
  labels.filter(l => !/\bt\(|\?\.|\|\||openCitation|viewingAttachment|folderDialog/.test(l)).join(' | '));

/* ------------------------------------------------------------ the keyboard */

check('there is a dialog helper', /export const useDialog = \(open\)/.test(ui));

// Wrapping is the whole of a focus trap: off the end goes to the start, and
// off the start goes to the end.
check('it traps Tab', /if \(e\.key !== 'Tab'\) return;/.test(ui));
check('and wraps forwards', /!e\.shiftKey && document\.activeElement === lastItem/.test(ui));
check('and backwards', /e\.shiftKey && document\.activeElement === firstItem/.test(ui));

// Without this, closing Settings leaves the next Tab starting from the top of
// the document — which for a keyboard user means finding their place again.
check('it remembers what had focus', /restoreTo\.current = document\.activeElement/.test(ui));
check('and gives it back on close',
  /document\.contains\(target\) && typeof target\.focus === 'function'/.test(ui));

// An element that has gone with the dialog that opened it must not throw on
// the way out.
check('and does not throw if that element has gone', /document\.contains\(target\)/.test(ui));

// A dialog with nothing focusable still needs the keyboard somewhere inside
// it, or Tab starts from the document again.
check('an empty dialog still takes focus', /else node\?\.focus\?\.\(\);/.test(ui));

/* ------------------------------------------------ and every dialog uses it */

const wired = [...app.matchAll(/const (\w+DialogRef) = useDialog\(([^)]+)\)/g)];
check('the helper is wired to dialogs', wired.length >= 7, `${wired.length} wired`);
for (const [, refName, openExpr] of wired) {
  check(`${refName} is attached to an element`,
    new RegExp(`ref=\\{${refName}\\}`).test(app), refName);
  // What this is guarding against is `useDialog(someObject)` -- a value that
  // happens to be truthy, so the dialog opens but nothing ever tells it to
  // close. A `show*` flag, a `!!`, or an explicit comparison are all real
  // booleans; a bare identifier is not.
  check(`${refName} is driven by a real open flag`,
    /show|!!|!==|===/.test(openExpr), openExpr);
}

/* ------------------------------------------------------- the rest of the app */

// Not an audit, just the controls that carry no text of their own and would
// otherwise be announced as "button".
check('the thinking switch is a labelled group', /role="group" aria-label=\{t\('gen\.thinking'\)\}/.test(app));
check('its buttons say which is on', /aria-pressed=\{thinkMode === mode\}/.test(app));
check('the switch component is a real switch', /role="switch"/.test(ui) && /aria-checked=\{checked\}/.test(ui));

/* ------------------------------------------------- controls are controls

   A span with an onClick is not reachable by Tab, not activated by Enter, and
   is announced as text rather than as something that does anything. The
   sidebar tag chips shipped as spans, which is how this rule earned a test
   rather than a comment. */

const clickableSpans = [...app.matchAll(/<span[^>]*\sonClick=/g)];
check('nothing is a span with a click handler',
  clickableSpans.length === 0, `${clickableSpans.length} found`);

// The tag chips in particular: they filter the chat list, so they are
// controls. They sit inside a row that is a div precisely because that row
// already holds several buttons.
check('the sidebar tag chips are buttons',
  /<button\s+type="button"\s+className="chat-tag"/.test(app));
check('and they say what they do', /tags\.filterOne/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
