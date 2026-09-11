// How much context a chat gets, and moving installs off a default that was
// measurably too small.
//
// The rule here has to be conservative in one specific way: raising a number
// somebody chose deliberately is worse than leaving a bad default in place. A
// person who typed 2048 because their card is small must not be overruled, and
// a person who typed 4096 on purpose must not have it changed under them twice.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const C = await import(pathToFileURL(path.join(ROOT, 'src/contextDefault.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const ctx = (stored, alreadyDone = false) => C.raiseIfUntouched(stored, {
  oldDefault: C.OLD_NUM_CTX, newDefault: C.DEFAULT_NUM_CTX, alreadyDone,
});

/* The measurement this exists for: at 4096 a reasoning model's thinking and its
   answer share one ceiling and together they do not fit under it, so the answer
   stops mid-sentence. Measured with qwen3.6:35b-a3b — 4096 gave
   `done_reason: "length"`, 16384 gave `"stop"` for the same question. */
check('the new default is larger than the old one', C.DEFAULT_NUM_CTX > C.OLD_NUM_CTX);
check('and so is the answer budget', C.DEFAULT_MAX_TOKENS > C.OLD_MAX_TOKENS);

eq('a fresh profile gets the new default', ctx(null).value, C.DEFAULT_NUM_CTX);
eq('and an empty string is a fresh profile too', ctx('').value, C.DEFAULT_NUM_CTX);
check('which is not a change to report', ctx(null).changed === false);

// The whole point: 4096 was never chosen, it was just what the app wrote on
// first run.
eq('exactly the old default is raised', ctx('4096').value, C.DEFAULT_NUM_CTX);
check('and that is reported as a change', ctx('4096').changed === true);

/* Anything else was a decision. Someone with a small card who typed 2048 is
   being helped by nobody if the app quietly triples it. */
eq('a smaller number was deliberate', ctx('2048').value, 2048);
eq('and so was a larger one', ctx('65536').value, 65536);
check('neither counts as a change', !ctx('2048').changed && !ctx('65536').changed);

/* Once. A person who sets 4096 back after the raise means it, and finding it
   changed again on the next reload would be the app arguing with them. */
eq('after the raise, 4096 is left alone', ctx('4096', true).value, 4096);
check('and reported as unchanged', ctx('4096', true).changed === false);

// Rubbish in storage is not a number to preserve.
eq('unreadable storage falls back to the default', ctx('nonsense').value, C.DEFAULT_NUM_CTX);
eq('and so does a NaN', ctx('NaN').value, C.DEFAULT_NUM_CTX);

/* ------------------------------------------------------------ the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
check('the context size goes through it', /numCtx.*raiseIfUntouched\(getSetting\('numCtx'\)/s.test(app)
  || /raiseIfUntouched\(getSetting\('numCtx'\)/.test(app));
check('and the answer budget too', /raiseIfUntouched\(getSetting\('maxTokens'\)/.test(app));
// Written after the values have been read, so the raise happens exactly once.
check('the raise is recorded', /setSetting\(MIGRATION_KEY, 'true'\)/.test(app));

/* A fact about this browser, not a preference. Synced, it would let a phone
   that had already been raised tell a desktop it had been too — and the
   desktop would keep its cut-off answers for ever. */
const store = fs.readFileSync(path.join(ROOT, 'src/settingsStore.js'), 'utf8');
check('and is kept off the sync', /'ctxDefaultsRaised'/.test(store));
eq('under the name the app writes', C.MIGRATION_KEY, 'ctxDefaultsRaised');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
