// Why a long conversation gets slow, and what to send instead.
//
// Ollama re-reads the whole prompt every turn. Turn forty is not the model
// remembering turn one, it is the model reading turn one again — which is why
// prompt_eval_duration grows linearly while the answers stay the same size.
//
// Three tiers, because they answer different questions: recent turns verbatim
// (no summary reconstructs a pronoun), a rolling summary (retrieval alone
// cannot answer "what did we decide"), and retrieval (a summary cannot give
// back the exact error message from turn nine).
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/convMemory.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.convmemory-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const M = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const exchange = (q, a) => ([
  { role: 'user', content: q },
  { role: 'assistant', content: a },
]);

/* ------------------------------------------------------------- into turns */

// A turn is a question and everything that answered it. Half an exchange
// retrieved on its own is a question with no answer.
let turns = M.asTurns([...exchange('one', 'first'), ...exchange('two', 'second')]);
eq('two exchanges are two turns', turns.length, 2);
eq('each carries the question', turns[0].user, 'one');
eq('and the answer', turns[0].assistant, 'first');
eq('and knows where it is', turns[1].index, 1);
check('and what it costs', turns[0].tokens > 0);

// The tool loop produces several assistant messages for one question, and
// splitting them would make the second one an answer to nothing.
eq('several answers to one question are still one turn',
  M.asTurns([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }]).length, 1);
check('with both answers in it',
  M.asTurns([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }])[0].assistant.includes('b'));

// A persona greeting arrives before anybody has asked anything.
eq('an answer with no question is still content',
  M.asTurns([{ role: 'assistant', content: 'hello' }]).length, 1);
eq('the system prompt is not a turn',
  M.asTurns([{ role: 'system', content: 'x' }, ...exchange('q', 'a')]).length, 1);
eq('and nothing is no turns', M.asTurns([]).length, 0);

/* --------------------------------------------------------- the budget */

const many = [];
for (let i = 0; i < 40; i++) many.push(...exchange(`question ${i} ${'x'.repeat(400)}`, `answer ${i} ${'y'.repeat(400)}`));
turns = M.asTurns(many);
eq('forty exchanges are forty turns', turns.length, 40);

let plan = M.planHistory(turns, { numCtx: 8192 });
check('most of a long conversation is left behind', plan.older.length > 20, `${plan.older.length} older`);
check('and what is kept fits the budget', plan.usedTokens <= plan.budget, `${plan.usedTokens} / ${plan.budget}`);
// Backwards, because the newest turns are the ones nothing else can replace.
eq('what is kept is the newest', plan.recent[plan.recent.length - 1].index, 39);
check('and it is contiguous',
  plan.recent.every((t, i) => i === 0 || t.index === plan.recent[i - 1].index + 1));

// A context so small that four turns do not fit is one where compressing will
// not save the conversation either.
plan = M.planHistory(turns, { numCtx: 512 });
eq('the last few turns survive any budget', plan.recent.length, M.MIN_RECENT_TURNS);

eq('a short conversation is not compressed at all',
  M.planHistory(M.asTurns([...exchange('a', 'b')]), { numCtx: 8192 }).shouldCompress, false);
// Summarising one short turn costs as much as the turn.
eq('nor is a slightly longer one', M.planHistory(
  M.asTurns([...exchange('a', 'b'), ...exchange('c', 'd'), ...exchange('e', 'f'),
    ...exchange('g', 'h'), ...exchange('i', 'j')]), { numCtx: 8192 }).shouldCompress, false);

// Whatever else is going into the prompt has to come out of the same window.
check('a large reserve leaves less for history',
  M.planHistory(turns, { numCtx: 8192, reserve: 3000 }).budget
  < M.planHistory(turns, { numCtx: 8192 }).budget);

/* ------------------------------------------------------------ retrieval */

const older = M.asTurns([
  ...exchange('how do I install postgres on debian', 'use apt install postgresql'),
  ...exchange('what is the capital of peru', 'Lima'),
  ...exchange('my build fails with error LNK2019 unresolved external', 'that is a linker error'),
]);

let found = await M.retrieveTurns('what was that linker error again', older, {});
// Chronological, so the assertion is that it is among them -- not first.
check('the relevant turn comes back', found.turns.some(t => t.user.includes('LNK2019')));
eq('and it says how it found it', found.how, 'keyword');
// One shared function word is not a reason to spend context on a turn.
check('and an unrelated turn that merely shares a word does not',
  !found.turns.some(t => t.user.includes('peru')),
  JSON.stringify(found.turns.map(t => t.user)));

// The whole point of the tier: the exact string from turn nine, which no
// summary would have kept.
found = await M.retrieveTurns('postgres', older, {});
check('a specific term finds its turn', found.turns.some(t => t.user.includes('postgres')));

found = await M.retrieveTurns('something about badminton tournaments', older, {});
eq('an unrelated question brings nothing back', found.turns.length, 0);
eq('and says so', found.how, 'none');
eq('nothing to search is nothing found', (await M.retrieveTurns('x', [], {})).turns.length, 0);
eq('and no question either', (await M.retrieveTurns('', older, {})).turns.length, 0);

// Rarer words decide the ranking; otherwise "the" and "what" pick the turn.
const ranked = M.keywordRank('LNK2019', older);
check('a rare word outranks a common one', ranked[0].turn.user.includes('LNK2019'));

/* -------------------------------------------------- with an embedder */

// Vectors chosen so turn 2 is the match, whatever the words say.
const fakeEmbed = async (texts) => texts.map((text, i) => (
  i === 0 ? [1, 0, 0] : [i === 2 ? 1 : 0, i === 2 ? 0 : 1, 0]
));
found = await M.retrieveTurns('anything', older, { embed: fakeEmbed });
eq('embeddings are used when there is an embedder', found.how, 'embedding');
eq('and they choose the turn', found.turns[0].index, 1);

// `nomic-embed-text` is not installed on most machines, and the message must
// still send.
const brokenEmbed = async () => { throw new Error('model not found'); };
found = await M.retrieveTurns('postgres', older, { embed: brokenEmbed });
eq('a missing embedding model falls back rather than failing', found.how, 'keyword');
check('and still finds the turn', found.turns.length > 0);

// Chronological once chosen: three passages newest-first read as a
// conversation running backwards.
const wideEmbed = async (texts) => texts.map(() => [1, 0, 0]);
found = await M.retrieveTurns('anything', older, { embed: wideEmbed });
check('what comes back is in the order it happened',
  found.turns.every((t, i) => i === 0 || t.index > found.turns[i - 1].index));

/* ------------------------------------------------- what recall may cost

   The failure this exists to prevent, caught in a real run: recall was pasting
   four whole turns back, so a prompt just cut from thirty turns to eight grew
   straight back -- the system prompt climbed 1,100 -> 6,065 characters over
   six turns while the transcript itself was no longer growing at all. A
   recalled turn is evidence that something was said, not the record of it. */

const fat = M.asTurns([
  ...exchange(`a question about elephants ${'q'.repeat(3000)}`, `an answer ${'a'.repeat(3000)}`),
  ...exchange(`a question about elephants again ${'q'.repeat(3000)}`, `another ${'a'.repeat(3000)}`),
  ...exchange(`elephants once more ${'q'.repeat(3000)}`, `and again ${'a'.repeat(3000)}`),
  ...exchange(`elephants finally ${'q'.repeat(3000)}`, `last ${'a'.repeat(3000)}`),
]);

const recalled = (await M.retrieveTurns('elephants', fat, {})).turns;
const recallCost = recalled.reduce((sum, t) => sum + M.tokensOf(M.trimTurn(t)), 0);
check('what comes back fits a budget', recallCost <= M.RECALL_BUDGET * 1.5,
  `${recallCost} tokens for ${recalled.length} turns`);
check('rather than the whole turns',
  recallCost < fat.reduce((sum, t) => sum + t.tokens, 0) / 4);

// A recall tier that returns nothing because the one relevant turn is long is
// a recall tier that fails on exactly the turns worth recalling.
check('one very long match still comes back',
  (await M.retrieveTurns('elephants', [fat[0]], {})).turns.length, 1);

// Cut rather than summarised: this tier exists to bring back the exact words,
// and half of the exact words beats a paraphrase of all of them.
const trimmed = M.trimTurn(fat[0]);
check('a trimmed turn keeps its question', trimmed.includes('a question about elephants'));
check('and says where it was cut', trimmed.includes('[…]'));
check('a short turn is not cut at all',
  !M.trimTurn(M.asTurns([...exchange('short', 'answer')])[0]).includes('[…]'));

// Best-first, so the ceiling costs the weakest match rather than whichever
// happened to be last.
check('the block itself is bounded', M.formatRecalled(fat).length < 6000,
  String(M.formatRecalled(fat).length));

/* ------------------------------------------------------------ the blocks */

const summaryAsk = M.summaryPrompt(older, '', 'Korean');
check('the summary prompt carries the exchanges', summaryAsk.includes('LNK2019'));
check('it asks for minutes rather than a blurb', /decisions, established facts/i.test(summaryAsk));
check('with a length it will actually respect', /under 200 words/i.test(summaryAsk));
check('written for the assistant, not for a reader', /for the assistant to read/i.test(summaryAsk));
check('and the language is named', summaryAsk.includes('Korean'));

const update = M.summaryPrompt(older, 'We were setting up a database.', '');
check('an update is given what it is updating', update.includes('We were setting up a database.'));
check('and told to keep what is still true', /still true/i.test(update));

check('the recalled block says these are from further back',
  /further back/i.test(M.formatRecalled(older)));
eq('and nothing recalled is no block', M.formatRecalled([]), '');
// A summary presented as the record invites the model to invent detail it
// implies but does not contain.
check('the summary block admits it is a summary', /This is a summary/i.test(M.formatSummary('x')));
eq('and an empty one is no block', M.formatSummary('   '), '');

/* --------------------------------------------------------- all together */

let context = await M.buildContext({ messages: many, question: 'question 3', numCtx: 8192 });
eq('a long conversation is compressed', context.compressed, true);
check('the recent turns are sent whole', context.recent.length > 0);
check('the older ones are not', context.older.length > 0);
check('and something relevant is recalled', context.recalled.length > 0);
// The model reads a repetition as emphasis.
const recentIndices = new Set(context.recent.map(t => t.index));
check('nothing is sent twice', context.recalled.every(t => !recentIndices.has(t.index)));

context = await M.buildContext({ messages: [...exchange('a', 'b')], question: 'c', numCtx: 8192 });
eq('a short one is left alone', context.compressed, false);
eq('with every turn recent', context.recent.length, 1);

context = await M.buildContext({ messages: many, question: 'x', numCtx: 8192, enabled: false });
eq('switched off, nothing is compressed', context.compressed, false);
eq('and every turn is sent', context.recent.length, 40);
eq('which is worth saying out loud', context.how, 'off');

/* ------------------------------------------------------------ the saving */

context = await M.buildContext({ messages: many, question: 'question 3', numCtx: 8192, summary: 'a summary' });
const saved = M.savings(context);
check('the whole history is what it would have cost', saved.whole > saved.sending);
check('and the saving is the difference', saved.saved === saved.whole - saved.sending);
// The honest number, not a marketing one: the summary and the recalled turns
// are part of what is being sent.
check('what is sent includes the summary and the recall',
  saved.sending >= context.recent.reduce((s, t) => s + t.tokens, 0));

eq('an uncompressed conversation saves nothing',
  M.savings(await M.buildContext({ messages: [...exchange('a', 'b')], question: 'c' })).saved, 0);

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the send path builds the context', /buildContext\(/.test(code));
check('with the window it is actually sending into', /numCtx,/.test(code));
check('the summary is kept on the chat, not recomputed every turn',
  /memorySummary/.test(code));
check('and it is updated only when there is enough new to summarise',
  /summaryPrompt\(/.test(code));
check('what was compressed is recorded on the message', /memoryNote/.test(code));
check('and the embedder is the one the app already has', /embedTexts/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['convmem.title', 'convmem.compressed', 'convmem.recalled', 'convmem.keyword']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
check('.memory-note is styled', css.includes('.memory-note'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
