// How fast the prompt grows, and why it used to grow so much faster.
//
// Reported as three numbers from the footer of three consecutive answers:
//
//     16,253 + 534 tok  ->  24,761 + 468 tok  ->  32,850 + 543 tok
//
// Eight thousand tokens of prompt per turn, for answers of five hundred. The
// cause was not the answers. Every turn wrote its retrieved passages into the
// reply as a `<think>` block so they could be read in the thinking dropdown,
// and every later turn sent that block back up along with its own. The
// retrieval was therefore paid for once per turn *for the rest of the
// conversation*.
//
// So this measures the thing that was wrong: given a transcript, how much of
// it goes on the wire. A fix that makes the numbers smaller but drops the
// question, the answer, or the model's own tool calls would be worse than the
// bug, so those are checked too.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/wireHistory.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.wirehistory-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const { forHistory, historyBytes, sentBytes, isToolResult, turnStart, wireText } =
  await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* --------------------------------------------------------- what is dropped */

const passages = 'PASSAGE '.repeat(1000);
const answered = `<think>\n--- [Knowledge] Passages from your documents ---\n${passages}\n---\n</think>\n\nFlexbox lays out a row or a column.`;

const sent = forHistory(answered);
eq('the answer survives', sent, 'Flexbox lays out a row or a column.');
check('the passages do not', !sent.includes('PASSAGE'));
check('and it is very much smaller', sent.length < answered.length / 50,
  `${answered.length} -> ${sent.length}`);

// A stream stopped part-way leaves a think block that never closed. That is
// exactly the message that sits in a transcript for ever, so it has to be
// handled by the same rule rather than slipping through as "not matching".
const cutOff = '<think>\nreasoning that never finished' + ' and on'.repeat(500);
eq('an unterminated think block goes too', forHistory(cutOff), '');

const fetched = `<think>\n--- [MCP Tool] Fetched Content from https://example.com ---\n${'PAGE '.repeat(2000)}\n</think>\n\nThe page says hello.`;
eq('a fetched page does not travel either', forHistory(fetched), 'The page says hello.');

const toolResult = `<TOOL_RESULT>\n${'RESULT '.repeat(900)}\n</TOOL_RESULT>`;
eq('nor does a tool result from an earlier turn', forHistory(toolResult), '');

/* ------------------------------------------------------------ what is kept */

// The model's own action. A model that cannot see what it did last time does
// it again, so the call stays even though its result does not.
const called = 'Let me look.\n<TOOL_WEB_SEARCH>flexbox spec</TOOL_WEB_SEARCH>';
eq('a tool call the model made is kept', forHistory(called), called);

eq('an ordinary answer is untouched',
  forHistory('Just an answer, with no scaffolding in it.'),
  'Just an answer, with no scaffolding in it.');
eq('and an ordinary question', forHistory('What is flexbox?'), 'What is flexbox?');

// Nothing in, nothing out -- and never the string "undefined", which is what
// String(undefined) would put into a prompt.
eq('nothing stays nothing', forHistory(''), '');
eq('and neither null nor undefined become words', forHistory(null) + forHistory(undefined), '');

// Code fences that happen to contain the words are not scaffolding. A message
// explaining how the tool protocol works must survive being sent.
const aboutCode = 'Use `numCtx` for the window. The tag looks like <TOOL_TIME></TOOL_TIME>.';
eq('a message that merely mentions a tag is kept', forHistory(aboutCode), aboutCode);

/* --------------------------------------- the attachment, which stays

   This looks like the same waste — forty kilobytes of CSV riding along on
   every turn — and it is not, because of where the two come from. Retrieval is
   redone from the question on every turn, so dropping last turn's passages
   loses nothing. An attachment is supplied once. Strip it and the obvious
   follow-up, "and what about line 200?", is answered from nothing at all.

   A file too long to inline is indexed into the knowledge library instead,
   which puts it back under retrieval where it belongs — so the large case is
   already handled, and what stays inline is small by definition. */

const withFile = 'What is wrong here?\n\n--- Attached File: notes.csv ---\n'
  + 'a,b,c\n'.repeat(20) + '\n-------------------';
const afterFile = forHistory(withFile);
check('the attached file is still there next turn', afterFile.includes('a,b,c'));
check('and so is the question', afterFile.includes('What is wrong here?'));
eq('in fact nothing is removed at all', afterFile, withFile);

// But the retrieval that answered a question *about* that file is not kept,
// because the next turn retrieves again.
const aboutFile = '<think>\n--- [Knowledge] ---\n' + 'passage '.repeat(500)
  + '\n---\n</think>\n\nLine 200 has a stray comma.';
eq('while the passages behind the answer are dropped',
  forHistory(aboutFile), 'Line 200 has a stray comma.');

/* ---------------------------------------------------- the reported numbers */

/* A conversation shaped like the one in the report: short questions, short
 * answers, and a retrieval on every turn. The old behaviour sent all of it;
 * the new one sends the conversation. */
const RETRIEVAL = 'passage text '.repeat(2400);   // ~8k tokens' worth
const turns = [];
for (let i = 0; i < 6; i++) {
  turns.push({ role: 'user', content: `Question number ${i}, which is short.` });
  turns.push({
    role: 'assistant',
    content: `<think>\n--- [Knowledge] ---\n${RETRIEVAL}\n---\n</think>\n\nAnswer number ${i}, also short.`,
  });
}

const before = historyBytes(turns);
const after = sentBytes(turns);
check('a six-turn chat with retrieval shrinks by a lot', after < before / 20,
  `${before} chars -> ${after}`);

// The shape of the growth is the point. Before, every turn added the
// retrieval; after, a turn adds only what was said.
const growth = [];
for (let n = 1; n <= 6; n++) growth.push(sentBytes(turns.slice(0, n * 2)));
const steps = growth.slice(1).map((v, i) => v - growth[i]);
check('each further turn adds only its question and answer',
  steps.every(s => s < 200), JSON.stringify(steps));
check('and the growth is steady rather than accelerating',
  Math.max(...steps) - Math.min(...steps) < 50, JSON.stringify(steps));

// Everything anybody actually said is still there.
const wire = turns.map(m => forHistory(m.content)).join('\n');
for (let i = 0; i < 6; i++) {
  check(`question ${i} still reaches the model`, wire.includes(`Question number ${i}`));
  check(`and answer ${i}`, wire.includes(`Answer number ${i}`));
}

/* ------------------------------------------------ the turn in progress

   Reported as: the picture appears, and then the model says it is a text-only
   assistant that cannot draw. The leg after a tool call is sent the whole
   transcript again with the result on the end — and that result went through
   the rule above, as if it were history, and was replaced by the question.
   So the model was asked to draw a second time, with no tools in its prompt. */

const QUESTION = { role: 'user', content: '귀여운 애니 여자아이 그려줘' };
const CALLED = { role: 'assistant', content: '네, 그려드릴게요.\n<TOOL_GENERATE_IMAGE style="anime">a girl</TOOL_GENERATE_IMAGE>' };
const DRAWN = { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_GENERATE_IMAGE ---\nThe image was generated.\n</TOOL_RESULT>' };
const EARLIER = [
  { role: 'user', content: 'search something' },
  { role: 'assistant', content: '<TOOL_WEB_SEARCH>x</TOOL_WEB_SEARCH>' },
  { role: 'user', content: '<TOOL_RESULT>\n--- TOOL_WEB_SEARCH ---\nold results\n</TOOL_RESULT>' },
  { role: 'assistant', content: 'Here is what I found.' },
];

check('a tool result is recognised', isToolResult(DRAWN));
check('a question is not one', !isToolResult(QUESTION));
check('nor is an answer that quotes the tag', !isToolResult({ role: 'assistant', content: DRAWN.content }));

const leg = [...EARLIER, QUESTION, CALLED, DRAWN];
eq('the turn starts at the question, not at the result', turnStart(leg), EARLIER.length);
eq('and a fresh question is its own turn', turnStart([...EARLIER, QUESTION]), EARLIER.length);
eq('the hidden continue instruction is not a question',
  turnStart([...EARLIER, QUESTION, CALLED, { role: 'user', content: 'Continue.', continuation: true }]),
  EARLIER.length);
eq('an empty chat starts at the start', turnStart([]), 0);

const from = turnStart(leg);
const wired = leg.map((m, i) => wireText(m, i > from));
check('this turn\'s result reaches the model', wired[leg.length - 1].includes('The image was generated.'));
eq('an earlier turn\'s result still does not', wired[2], '');
check('and the call it answers is there too', wired[leg.length - 2].includes('<TOOL_GENERATE_IMAGE'));
check('the question is sent once, not twice',
  wired.filter(w => w === QUESTION.content).length === 1);

/* ------------------------------------------------- the call site in App.jsx

   The current turn is exempt: `finalInputText` is this question *with* its
   retrieval, which is the entire point of retrieving it. A fix that stripped
   that too would save more tokens and answer from nothing. */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('history is cleaned where the payload is built',
  app.includes('content: wireText(m, idx > turnFrom)'));
check('and the current turn still carries its retrieval',
  /idx === newMessageIndex - 1\)?\s*\{?\s*\n?\s*msgData\.content = finalInputText/.test(app));
// On a tool leg the last message is the result, and `finalInputText` is still
// the original question: the closure is the one the question was sent from.
check('but only on the leg that asks it, never over a tool result',
  /!isAutoTool && idx === newMessageIndex - 1/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
