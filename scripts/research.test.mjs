// Deep research: a question answered by going and finding out.
//
// The whole thing is injected — `ask`, `search`, `fetchPage` — and that is not
// ceremony. A real run takes minutes on a local model and needs a network, so
// without stand-ins this is code that gets written once and never exercised
// again. With them every branch is reachable in milliseconds, including the
// ones that only happen when the network is having a bad day.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/research.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.research-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const R = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- reading a plan */

// Models decorate lists whatever the prompt says, so the decoration comes off
// here rather than being forbidden harder.
const messy = `Here are the queries you asked for:
1. flexbox vs grid performance
2) "grid layout benchmark"
- flexbox browser support
* flexbox browser support
Queries:
`;
const parsed = R.parsePlan(messy, 6);
eq('numbering comes off', parsed[0], 'flexbox vs grid performance');
eq('so do brackets and quotes', parsed[1], 'grid layout benchmark');
eq('and bullets', parsed[2], 'flexbox browser support');
eq('a duplicate is one query, not two', parsed.length, 3);
check('the preamble is not a query', !parsed.some(q => /here are/i.test(q)));
check('and neither is a heading', !parsed.some(q => q.endsWith(':')));

eq('a plan is capped',
  R.parsePlan('one query\ntwo query\nthree query\nfour query\nfive query', 3).length, 3);
eq('a short but real query survives', R.parsePlan('AI safety\nC#', 5).length, 2);
eq('a stray single character does not', R.parsePlan('a\nreal query', 5).length, 1);
eq('reasoning is stripped before parsing',
  R.parsePlan('<think>let me think about this</think>\nreal query here', 5).length, 1);
eq('nothing usable is no queries', R.parsePlan('', 5).length, 0);
eq('and neither is punctuation', R.parsePlan('.\n-\n?', 5).length, 0);

/* ---------------------------------------------------------- the budgets */

check('quick is smaller than thorough',
  R.planFor('quick').questions < R.planFor('thorough').questions);
check('an unknown depth is the middle one',
  R.planFor('nonsense').questions === R.planFor('normal').questions);
check('nothing exceeds the hard ceiling',
  R.planFor('thorough').totalPages <= R.LIMITS.totalPages);

/* ------------------------------------------------------- not reading twice */

const results = [
  { url: 'https://a.example', title: 'A' },
  { url: 'https://b.example', title: 'B' },
  { url: 'https://c.example', title: 'C' },
];
eq('it reads up to the limit', R.worthReading(results, new Set(), 2).length, 2);
eq('and skips what it has already read',
  R.worthReading(results, new Set(['https://a.example']), 2)[0].url, 'https://b.example');
eq('a result with no url is not a page', R.worthReading([{ title: 'x' }], new Set(), 2).length, 0);

/* ------------------------------------------------------------- the brief */

const brief = R.buildBrief('Is X faster than Y?', [
  { title: 'Bench', url: 'https://a.example', text: 'X is faster', read: true, snippet: '' },
  { title: 'Blog', url: 'https://b.example', text: '', read: false, snippet: 'Y is faster' },
], 'Korean');
check('sources are numbered from one', brief.includes('[1] Bench') && brief.includes('[2] Blog'));
check('a page that was read carries its text', brief.includes('X is faster'));
check('one that was not is marked as a snippet', brief.includes('(not read; search result only)'));
check('the model is told to cite', /cite every claim/i.test(brief));
check('and told what to do when sources disagree', /disagree/i.test(brief));
check('and forbidden from filling gaps from memory', /from memory/i.test(brief));
check('the answer language is named', brief.includes('Korean'));

/* ------------------------------------------------------------ a full run */

const page = (text) => ({ text });
const make = (overrides = {}) => ({
  question: 'Is X faster than Y?',
  depth: 'quick',
  ask: async (prompt) => (/Break this research question/.test(prompt)
    ? 'x benchmark\ny benchmark'
    : 'X is faster [1], though one source disagrees [2].'),
  search: async (query) => [
    { url: `https://${query.split(' ')[0]}.example/1`, title: `${query} one`, snippet: 's1' },
    { url: `https://${query.split(' ')[0]}.example/2`, title: `${query} two`, snippet: 's2' },
  ],
  fetchPage: async (url) => page(`the contents of ${url}`),
  ...overrides,
});

let run = await R.runResearch(make());
check('it produces a report', run.report.length > 0, run.report);
check('and sources to go with it', run.sources.length >= 2);
check('every step is recorded', run.steps.length > 0);
check('the plan is a step', run.steps.some(s => s.kind === 'plan' && s.state === 'done'));
check('each search is a step', run.steps.filter(s => s.kind === 'search' && s.state === 'done').length >= 1);
check('each page read is a step', run.steps.some(s => s.kind === 'read' && s.state === 'done'));
// The finished step replaces the running one in the trace, so a title shown
// while the page was loading must not turn back into a raw URL once it has.
check('and the finished one still knows the page title',
  run.steps.filter(s => s.kind === 'read' && s.state !== 'running').every(s => !!s.title));
check('and the writing is a step', run.steps.some(s => s.kind === 'write' && s.state === 'done'));

// The numbering in the report is the numbering of the sources, so a source
// that was actually read has to sort before one that was only glimpsed.
check('pages that were read are cited first',
  run.sources[0].read === true, JSON.stringify(run.sources.map(s => s.read)));
check('citations come out in the shape the transcript already understands',
  run.citations.every(c => c.url && c.docName && typeof c.text === 'string'));

/* -------------------------------------------------- when the day goes badly */

// Search fails entirely. There is nothing to cite, and saying so is better
// than writing an answer from the model's memory and dressing it as research.
run = await R.runResearch(make({ search: async () => { throw new Error('offline'); } }));
eq('nothing found is reported as nothing found', run.empty, true);
eq('with no report invented', run.report, '');
check('and the failure is in the steps',
  run.steps.some(s => s.kind === 'search' && s.error));

// Pages fail but search worked. A snippet is weak evidence, not no evidence,
// so the run continues on what it has.
run = await R.runResearch(make({ fetchPage: async () => { throw new Error('403'); } }));
check('unreadable pages do not end the run', run.report.length > 0);
check('the snippets are still cited', run.sources.length >= 2);
check('and each failure is visible', run.steps.some(s => s.kind === 'read' && s.state === 'failed'));

/* --------------------------------------------- a refusal is not a lost page

   A site that answers 403 to a reader is not a reason to research one page
   less. The loop used to take the first two results of each query and read only
   those: when the first refused -- and one in three does, because a great deal
   of the web blocks anything that is not a browser -- that query's whole
   allowance went with it. Now the refused one is skipped and the next candidate
   is tried, so the budget buys pages rather than attempts. */

const refuseFirst = new Set();
run = await R.runResearch(make({
  search: async (query) => [
    { url: `https://${query.split(' ')[0]}.example/blocked`, title: 'blocked', snippet: 's' },
    { url: `https://${query.split(' ')[0]}.example/open`, title: 'open', snippet: 's' },
  ],
  fetchPage: async (url) => {
    if (url.endsWith('/blocked')) { refuseFirst.add(url); throw new Error('HTTP 418'); }
    return page(`the contents of ${url}`);
  },
}));
check('a refusal is recorded', run.steps.some(s => s.kind === 'read' && s.state === 'failed'));
check('and the next result is read instead of the budget being wasted',
  run.sources.some(s => s.read && s.url.endsWith('/open')),
  JSON.stringify(run.sources.map(s => [s.url, s.read])));

// A page that answers with nothing readable has not been read either, and
// counting it spends the budget on an empty source.
run = await R.runResearch(make({
  search: async (query) => [
    { url: `https://${query.split(' ')[0]}.example/empty`, title: 'empty', snippet: 's' },
    { url: `https://${query.split(' ')[0]}.example/real`, title: 'real', snippet: 's' },
  ],
  fetchPage: async (url) => (url.endsWith('/empty') ? page('') : page(`the contents of ${url}`)),
}));
check('an empty page does not count as a page read',
  run.sources.some(s => s.read && s.url.endsWith('/real')),
  JSON.stringify(run.sources.map(s => [s.url, s.read])));

/* ------------------------------------------------- how much goes to the model

   Every search result becomes a source whether or not it could be read, which
   is right. But six queries at five results each is thirty of them, and thirty
   snippets sitting behind seven real pages is thirty invitations to cite
   something nobody opened -- which is exactly what a report full of `[14]`
   pointing at a search-result blurb is. */

const many = [
  ...Array.from({ length: 4 }, (_, i) => ({ url: `https://read/${i}`, read: true, text: 'x', title: 't', snippet: '' })),
  ...Array.from({ length: 20 }, (_, i) => ({ url: `https://un/${i}`, read: false, text: '', title: 't', snippet: 's' })),
];
const shortlist = R.forTheBrief(many);
eq('every page that was read reaches the brief', shortlist.filter(s => s.read).length, 4);
eq('and the snippets are capped', shortlist.filter(s => !s.read).length, R.UNREAD_BUDGET);
check('with the read ones first, since the order is the citation numbering',
  shortlist.slice(0, 4).every(s => s.read));
// A run where everything was readable must not lose anything to the cap.
eq('a run that read everything loses nothing',
  R.forTheBrief(many.filter(s => s.read)).length, 4);

// Asked to *make* something from what the research turned up, a model told
// "use only the sources below" reports that no source contains a finished
// page. True, and useless: sources inform work, they do not have to contain it.
const madeBrief = R.buildBrief('build me a landing page', many.slice(0, 2), '');
check('the brief says that producing something is not refusing',
  /produce it, using the sources/.test(madeBrief), madeBrief.slice(-400));
check('while still requiring citations',
  /Cite every claim with the source number/.test(madeBrief));

// The model returns nothing usable for a plan. The question itself is a
// perfectly good search, and one search beats an error.
run = await R.runResearch(make({
  ask: async (prompt) => (/Break this research/.test(prompt) ? '' : 'an answer [1]'),
}));
check('an unusable plan falls back to the question',
  run.steps.find(s => s.kind === 'plan' && s.state === 'done').queries.length === 1);
check('and the run still finishes', run.report.length > 0);

// Writing fails after all the reading. The sources are still worth having.
run = await R.runResearch(make({
  ask: async (prompt) => {
    if (/Break this research/.test(prompt)) return 'x benchmark';
    throw new Error('model died');
  },
}));
eq('a failed write says why', run.failed, 'model died');
check('but keeps what it gathered', run.sources.length > 0);

/* --------------------------------------------------------------- stopping */

const controller = new AbortController();
controller.abort();
run = await R.runResearch(make({ signal: controller.signal }));
eq('an aborted run says so', run.cancelled, true);
check('and writes no report', !run.report);

/* ------------------------------------------------------- progress reporting

   A run takes minutes on a local model, and something that prints nothing
   until it finishes is indistinguishable from a hang. */

const seen = [];
await R.runResearch(make({ onStep: (s) => seen.push(`${s.kind}:${s.state}`) }));
check('steps are reported as they happen, not at the end', seen.length > 4, String(seen.length));
check('running comes before done',
  seen.indexOf('search:running') < seen.indexOf('search:done'), seen.join(' '));

/* ------------------------------------------------------------- the wiring

   The loop above is testable because everything it talks to is injected. That
   same property is what makes it possible to wire it up wrong -- to the model
   with history attached, to a search that ignores the language, to an `onStep`
   that only reports at the end. These check the connections. */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the app runs the loop', /await runResearch\(\{/.test(code));
check('with the composer question', /question: asked/.test(code));
check('the search the rest of the app uses', /search: async \(query, limit\) => \(await mcpSearchWeb/.test(code));
check('and the same page fetch', /fetchPage: \(url, limit, sig\) => mcpFetchUrl/.test(code));
check('steps are handed to the transcript as they arrive', /onStep: \(_step, steps\) =>/.test(code));

/* One question, not a conversation. A research turn that carried the chat
   history would spend its context on the chat rather than on the sources, and
   the plan step would start answering the previous question. */
const askBody = code.slice(code.indexOf('const researchAsk'), code.indexOf('const startDeepResearch'));
check('the model is asked the prompt and nothing else',
  /messages: \[\{ role: 'user', content: prompt \}\]/.test(askBody));
check('nothing is streamed, since nothing is shown until it is written',
  /stream: false/.test(askBody));
check('and reasoning is off, or the query budget goes on deciding',
  /think: false/.test(askBody));

const runBody = code.slice(code.indexOf('const startDeepResearch'), code.indexOf('const handleSend = async'));
check('a cancelled run says so rather than looking finished', /run\.cancelled/.test(runBody));
check('an empty one too', /run\.empty/.test(runBody));
check('a failed write keeps the sources',
  /run\.failed[\s\S]{0,400}sources: run\.sources\.map/.test(runBody));
check('a finished one carries citations in the shape the transcript reads',
  /citations: run\.citations/.test(runBody));
check('the write lands at a fixed index, not at the end of whatever is there now',
  /const index = asking\.length/.test(runBody));
check('and is dropped if the message it belonged to is gone',
  /if \(!held \|\| held\.role !== 'assistant'\) return s;/.test(runBody));

check('sending in research mode goes to the research path',
  /if \(researchMode && !customMessages\) \{ startDeepResearch\(input\); return; \}/.test(code));
// A tool loop re-enters `handleSend` with a message array. That is the model
// continuing its own turn, and must never start a second research run.
check('but a tool loop never does', /researchMode && !customMessages/.test(code));

check('the mode is armed from the composer', /setResearchMode\(v => !v\)/.test(code));
check('and is not remembered across a reload',
  /const \[researchMode, setResearchMode\] = useState\(false\)/.test(code));
check('the depth is remembered', /setSetting\('researchDepth', researchDepth\)/.test(code));
check('and the strip says what each depth costs', /research\.depthCost/.test(code));

const trace = fs.readFileSync(path.join(ROOT, 'src/ResearchTrace.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the trace is open while the run is going',
  /override === null \? running : override/.test(trace));
check('and the source numbering is the citation numbering',
  /\[\{idx \+ 1\}\]/.test(trace));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['research.armed', 'research.depthCost', 'research.stepSearch',
  'research.nothingFound', 'research.snippetOnly']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['research-strip', 'research-trace', 'research-steps', 'research-sources']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

/* ------------------------------------------------- what the trace shows

   Every step is reported twice: once starting, once finished. A list that
   renders both is twice as long and says nothing extra -- except for the step
   currently in flight, which is the only one worth watching. */

eq('a finished step replaces its own start',
  R.visibleSteps([
    { kind: 'search', state: 'running', query: 'a' },
    { kind: 'search', state: 'done', query: 'a', found: 3 },
  ]).length, 1);
eq('the one still in flight is kept',
  R.visibleSteps([
    { kind: 'search', state: 'done', query: 'a' },
    { kind: 'read', state: 'running', url: 'https://x.example' },
  ]).length, 2);
eq('two reads of different pages are two steps',
  R.visibleSteps([
    { kind: 'read', state: 'running', url: 'https://a.example' },
    { kind: 'read', state: 'done', url: 'https://a.example' },
    { kind: 'read', state: 'running', url: 'https://b.example' },
  ]).length, 2);
eq('a failure is a finish, not a start left hanging',
  R.visibleSteps([
    { kind: 'read', state: 'running', url: 'https://a.example' },
    { kind: 'read', state: 'failed', url: 'https://a.example', error: '403' },
  ]).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
