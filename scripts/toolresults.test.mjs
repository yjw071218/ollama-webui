// A tool result, as something the reader should see.
//
// What a tool returns is addressed to the *model* — "do not describe it", "you
// have 9 tool call(s) left", "citing any URLs you used" — and all of it went on
// screen in a monospace box under the answer, including under a picture the
// text was telling the model not to describe. The strings below are the real
// ones, copied from a transcript, because the whole job of this module is
// recognising them.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const R = await import(pathToFileURL(path.join(ROOT, 'src/toolResults.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* The exact block a reader was shown under a picture. */
const DRAWN = `--- TOOL_GENERATE_IMAGE ---
The image was generated and is already displayed to the user beneath your reply. Do not describe it, do not link to it, and do not repeat the prompt. Say at most one short sentence about it, or nothing.

You have 9 tool call(s) left. Use another only if you still need it; otherwise answer now, citing any URLs you used.`;

const drawn = R.parseToolResults(DRAWN);
eq('one tool ran', drawn.length, 1);
eq('and it is named', drawn[0].name, 'TOOL_GENERATE_IMAGE');
/* Every word of that result is instructions. What is left is nothing, and
   nothing is the right amount: the picture is directly below the block. */
eq('with nothing left to show the reader', drawn[0].body, '');
check('so no body is rendered', !R.showsBody(drawn[0]));
eq('and it says what happened, in the reader\'s language', R.verbKey('TOOL_GENERATE_IMAGE'), 'tool.did.image');

/* A tool whose answer *is* information keeps it — but not the footer, which is
   the model's housekeeping and says nothing to anybody else. */
const TIME = `--- TOOL_TIME ---
Local time: 2026-09-10 20:31
Timezone: Asia/Seoul

You have 4 tool call(s) left. Use another only if you still need it; otherwise answer now, citing any URLs you used.`;
const time = R.parseToolResults(TIME);
check('a useful body survives', /Asia\/Seoul/.test(time[0].body));
check('and the footer does not', !/tool call/.test(time[0].body), time[0].body);
check('so it is shown', R.showsBody(time[0]));

// The other two footers the loop writes.
check('the last-call footer goes too',
  !/last tool call/.test(R.stripInstructions('x\n\nThis was your last tool call. Answer now.')));
check('and the one after a picture',
  !/picture is made/.test(R.stripInstructions('x\n\nThe picture is made and the reader can see it. Do not call any tool again.')));
eq('leaving the answer itself', R.stripInstructions('x\n\nThis was your last tool call. Answer now.'), 'x');

/* Several tools in one block: each gets its own row, in order. */
const TWO = `--- TOOL_TIME ---
Local time: 2026-09-10

--- TOOL_SYSTEM_INFO ---
CPU: something

You have 3 tool call(s) left. Use another only if you still need it.`;
const two = R.parseToolResults(TWO);
eq('two tools, two rows', two.length, 2);
eq('in the order they ran', two.map(e => e.name).join(','), 'TOOL_TIME,TOOL_SYSTEM_INFO');
check('and only the last carries the footer to strip', !/tool call/.test(two[1].body));

/* Failures are the one case where a drawing tool does have something to say,
   and the one case where it must not be quiet about it. */
const FAILED = `--- TOOL_GENERATE_IMAGE ---
IMAGE GENERATION FAILED: No ComfyUI at http://127.0.0.1:8188. This is a tooling failure — say so plainly.`;
const failed = R.parseToolResults(FAILED);
check('a failure is marked', failed[0].failed);
check('and shows its reason even though drawing usually shows nothing',
  R.showsBody(failed[0]) && /No ComfyUI/.test(failed[0].body));
check('a search failure is marked too',
  R.parseToolResults('--- TOOL_WEB_SEARCH ---\nSEARCH FAILED for \'x\'. No provider answered.')[0].failed);
check('and an error from the executor', R.parseToolResults('--- TOOL_READ_FILE ---\nError running TOOL_READ_FILE: nope')[0].failed);
check('but an ordinary answer is not', !R.parseToolResults('--- TOOL_TIME ---\n12:00')[0].failed);

/* The loop writes one message with no marker at all — the budget notice. It
   still happened, so saying nothing would be worse than saying it plainly. */
const budget = R.parseToolResults('Tool budget for this turn is used up (5 calls). Answer now.');
eq('a message with no tool named is dropped once stripped', budget.length, 0);
const bare = R.parseToolResults('something happened');
eq('but anything left over is kept', bare.length, 1);
eq('as an unnamed entry', bare[0].name, '');

eq('nothing at all is no rows', R.parseToolResults('').length, 0);
eq('and neither is whitespace', R.parseToolResults('   \n  ').length, 0);

/* A tool nobody has written a name for must not put `TOOL_FROBNICATE` on
   screen. */
eq('an unknown tool falls back to the generic name', R.verbKey('TOOL_FROBNICATE'), 'tool.result');
eq('and a skipped one says why', R.verbKey('SKIPPED'), 'tool.did.skipped');

/* ------------------------------------------------------------ the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
check('the transcript renders receipts rather than the raw text',
  /parseToolResults\(part\.content\)/.test(app));
/* The *call* block still shows what was asked for, which is the reader's
   business — but a prompt is prose and belongs set as prose, not in the
   monospace box the file tools use for their contents. */
check('and a drawing request is named rather than left blank',
  /part\.tool === 'TOOL_GENERATE_IMAGE' && t\('tool\.drawImage'\)/.test(app));
check('with its prompt read as a sentence',
  /<p className="tool-block-prompt">\{part\.content\}<\/p>/.test(app));
check('each with the verb for its tool', /t\(verbKey\(entry\.name\)\)/.test(app));
check('and a body only where there is one', /showsBody\(entry\) && \(/.test(app));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
for (const key of ['tool.did.image', 'tool.did.search', 'tool.did.skipped']) {
  eq(`every language names "${key}"`, i18n.split(`'${key}':`).length - 1, 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
check('and the receipt is styled', /\.tool-receipt \{/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
