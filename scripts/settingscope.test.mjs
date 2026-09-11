// Settings are read from the same place they are written to.
//
// That sounds like nothing to test. It was a real bug, it lasted a long time,
// and nobody could see it — the symptom was "my phone and my laptop disagree
// about every generation setting", which reads as a sync problem and is not
// one.
//
// Settings belong to an account, so `setSetting` stores them under a key
// carrying the account's scope: `topP@srv-abc`, not `topP`. Seventeen of them
// were written that way and read with a bare `localStorage.getItem(key)`. The
// scoped value was written, stamped, uploaded, and downloaded onto the other
// device — and then read by nothing at all. Every device started from the
// built-in default on every load, so they never agreed, and changing one
// changed nothing anywhere. Sync was working perfectly the entire time.
//
// Two halves are checked here. The store's own round trip, and — because the
// bug was not in the store but in a caller that went around it — a scan of the
// app for settings read straight out of localStorage.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const map = new Map();
globalThis.localStorage = {
  get length() { return map.size; },
  key: (i) => [...map.keys()][i] ?? null,
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
};

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/settingsStore.js'),
  platform: 'neutral',
});
const out = path.resolve(HERE, '../node_modules/.settingscope-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const {
  setActiveScope, getSetting, setSetting, scopedKey, isScopedSetting, readScopeSettings,
} = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------- the round trip */

// The bug in one assertion: write a setting as an account, read it back, and
// get what was written rather than nothing.
setActiveScope('srv-abc');
setSetting('topP', '0.55');
eq('a setting written as an account reads back as that account', getSetting('topP'), '0.55');

// And the shape of the mistake that was made: reading the bare key instead.
// This is what the app was doing, and it is why the value was invisible.
eq('the bare key holds nothing while signed in', localStorage.getItem('topP'), null);
eq('the value is under the scoped key', localStorage.getItem('topP@srv-abc'), '0.55');

// Another account must not see it, and the guest must not either.
setActiveScope('srv-xyz');
eq('another account does not see it', getSetting('topP'), null);
setActiveScope('');
eq('the guest does not see it', getSetting('topP'), null);

setActiveScope('');
setSetting('topP', '0.9');
setActiveScope('srv-abc');
eq('and the guest writing it does not overwrite the account', getSetting('topP'), '0.55');

/* ------------------------------- every setting the app syncs is scoped */

// A setting that is not "scoped" is not synced either -- the two are the same
// predicate. So the list below is really "these follow you to your phone".
const SYNCED = [
  'topP', 'topK', 'repeatPenalty', 'numCtx', 'toolBudget', 'ragTopK',
  'minP', 'presencePenalty', 'frequencyPenalty',
  'temperature', 'maxTokens', 'systemPrompt', 'stopSequences', 'seed',
  'thinkMode', 'codeTheme', 'chatFontSize', 'chatDensity', 'contentWidth',
  'ttsEngine', 'ttsPromptText', 'ttsTextLang', 'ttsPromptLang',
  'ttsSpeed', 'ttsMaxChars', 'ttsAutoPlay',
];
for (const key of SYNCED) {
  check(`${key} is a synced setting`, isScopedSetting(key));
  check(`${key} gets a scoped key`, scopedKey(key, 'srv-abc') === `${key}@srv-abc`);
}

// The one deliberate exception. A reference clip names a file on one machine's
// disk, so carrying it to a phone would carry a path that does not exist.
check('the voice reference clip stays on its machine', !isScopedSetting('ttsRefAudio'));
eq('and keeps an unscoped key', scopedKey('ttsRefAudio', 'srv-abc'), 'ttsRefAudio');

// Chats are not settings, and neither is the sync's own bookkeeping. Treating
// `syncRev@srv-x` as a setting called `syncRev` would sync the sync cursor.
for (const key of ['ollama-sessions', 'chatFolders', 'syncRev', 'settingStamps', 'webui-tab-session']) {
  check(`${key} is not treated as a setting`, !isScopedSetting(key));
}

// What a device would upload: only this account's, and under bare names.
setActiveScope('srv-abc');
setSetting('chatDensity', 'compact');
const gathered = readScopeSettings('srv-abc');
eq('an upload carries the account\'s value', gathered.topP, '0.55');
eq('and names it without the scope', 'topP@srv-abc' in gathered, false);
eq('and does not carry another account\'s', gathered.topK, undefined);

/* --------------------------- nothing in the app reads around the store */

// The scan that would have caught the original bug. `getSetting` is the only
// way to read a setting: anything reaching for localStorage directly is either
// bypassing the account scope -- the bug -- or is one of the few things that
// genuinely is not a setting.
// Line endings are normalised because this repository checks out with
// `core.autocrlf=true`, so a source file's newlines depend on whether git
// last touched it. A pattern anchored on \n would then pass or fail for a
// reason that has nothing to do with the code it is checking.
const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const rawReads = [...app.matchAll(/localStorage\.getItem\(([^)]*)\)/g)].map(m => m[1].trim());

// Keys that are deliberately outside the account's settings:
//   lastChatKey  -- already carries its own scope, built by the caller
//   'ollama-sessions' -- the chat store, migrated from an older layout
//   DRAFTS_KEY -- half-typed messages, which belong to this browser and this
//     moment rather than to the account. Syncing them would upload on every
//     keystroke, and a draft arriving from another device would overwrite
//     whatever was being typed here. It carries its own scope, like
//     lastChatKey, and `settingsStore` lists it under NOT_A_SETTING_PREFIX so
//     the sync cannot pick it up by accident either.
const ALLOWED_RAW_READS = new Set(['lastChatKey', "'ollama-sessions'", 'DRAFTS_KEY']);
const strayReads = rawReads.filter(arg => !ALLOWED_RAW_READS.has(arg));
check('App.jsx reads no setting straight out of localStorage',
  strayReads.length === 0,
  strayReads.join(', '));

// The same for writes, which were never the broken half but would break the
// pair just as thoroughly from the other side.
const rawWrites = [...app.matchAll(/localStorage\.setItem\(([^,]*),/g)].map(m => m[1].trim());
const ALLOWED_RAW_WRITES = new Set(['lastChatKey', 'DRAFTS_KEY']);
const strayWrites = rawWrites.filter(arg => !ALLOWED_RAW_WRITES.has(arg));
check('App.jsx writes no setting straight to localStorage',
  strayWrites.length === 0,
  strayWrites.join(', '));

// The exemption above is only safe because the store agrees: a draft key must
// not read back as a setting called `chatDrafts` and get shipped to every
// device. Asserted rather than assumed, because the two live in different
// files and the comment in one cannot enforce the other.
check('drafts are not a synced setting', !isScopedSetting('chatDrafts:srv-abc'));
check('nor under the guest key', !isScopedSetting('chatDrafts'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
