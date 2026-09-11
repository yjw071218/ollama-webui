// A prompt that is several prompts.
//
// "Summarise this, then argue against the summary, then tell me which
// objections survive" is three prompts. The library already held each of them;
// nothing held the sequence, which is the part that is actually yours.
//
// The design decision the tests are mostly about: every step is a fresh turn,
// not a growing conversation. On a 4k context, step five carrying four
// previous prompts and four answers runs out of room — silently, because a
// model given too much context does not error, it forgets the beginning.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/chains.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.chains-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const C = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const chain = (prompts) => C.newChain('Test', prompts.map((p, i) => C.newStep(`step ${i + 1}`, p)));

/* ------------------------------------------------------- what a step asks for */

eq('a step can ask for the input', C.referencesIn('summarise {{input}}')[0], 'input');
eq('and for the step before it', C.referencesIn('argue against {{previous}}')[0], 'previous');
check('and for one by number', C.referencesIn('compare {{step1}} with {{step2}}').length === 2);
eq('whitespace inside the braces is fine', C.referencesIn('{{ input }}')[0], 'input');
eq('case does not matter', C.referencesIn('{{INPUT}}')[0], 'input');
eq('the same reference twice is one', C.referencesIn('{{input}} and {{input}}').length, 1);
eq('a placeholder that is not one is not a reference', C.referencesIn('{{topic}}').length, 0);
eq('and plain text has none', C.referencesIn('nothing here').length, 0);

/* ------------------------------------------------------------- filling it in */

eq('the input goes in', C.renderStep('summarise {{input}}', { input: 'a text' }), 'summarise a text');
eq('so does the previous output',
  C.renderStep('argue against {{previous}}', { outputs: ['first answer'] }), 'argue against first answer');
eq('and a numbered one', C.renderStep('{{step1}}', { outputs: ['one', 'two'] }), 'one');
eq('"previous" is the latest, not the first',
  C.renderStep('{{previous}}', { outputs: ['one', 'two'] }), 'two');

// An empty string reads as "there was nothing there". Leaving the placeholder
// as written is what shows the author they asked for something that does not
// exist yet.
eq('a reference to a step that has not run is left as written',
  C.renderStep('{{step3}}', { outputs: ['one'] }), '{{step3}}');
eq('and so is "previous" on the first step', C.renderStep('{{previous}}', { outputs: [] }), '{{previous}}');

const huge = 'x'.repeat(20000);
check('a very long output is trimmed on the way in',
  C.renderStep('{{previous}}', { outputs: [huge] }).length === C.STEP_BUDGET);

/* --------------------------------------------------------------- validating */

// A chain is minutes long. A reference to a step that runs later has to be a
// message, not a discovery made three minutes in.
let problems = C.validateChain(chain(['{{input}} do a thing', 'use {{step3}}', 'and {{previous}}']));
check('a reference to a later step is caught',
  problems.some(p => p.kind === 'forward' && p.step === 2 && p.refers === 3), JSON.stringify(problems));

// The second step is the one people write first, and it is where "previous"
// belongs. Putting it on the first step is the commonest way a chain is wrong.
problems = C.validateChain(chain(['{{previous}}']));
check('"previous" on the first step is caught', problems.some(p => p.kind === 'noPrevious'));

problems = C.validateChain(chain(['{{input}}', '   ']));
check('a blank step is caught', problems.some(p => p.kind === 'blank' && p.step === 2));

problems = C.validateChain({ name: '', steps: [C.newStep('', '{{input}}')] });
check('an unnamed chain is caught', problems.some(p => p.kind === 'name'));
check('and one with no steps', C.validateChain({ name: 'x', steps: [] }).some(p => p.kind === 'empty'));

// Advice rather than an error: a chain whose first step ignores the input is
// usually a mistake and is occasionally exactly what was wanted.
problems = C.validateChain(chain(['write a poem', 'improve {{previous}}']));
check('a first step that ignores the input is mentioned', problems.some(p => p.kind === 'noInput'));
eq('but does not block the run', C.blocking(problems).length, 0);
check('while a forward reference does',
  C.blocking(C.validateChain(chain(['{{input}}', '{{step3}}', 'x']))).length > 0);

eq('a well-formed chain has nothing to say',
  C.blocking(C.validateChain(chain(['{{input}}', 'then {{previous}}']))).length, 0);

/* ------------------------------------------------------------- running it */

const seen = [];
const echo = async (prompt) => { seen.push(prompt); return `answer to: ${prompt}`; };

let run = await C.runChain({
  chain: chain(['first {{input}}', 'second {{previous}}', 'third {{step1}}']),
  input: 'THE INPUT',
  ask: echo,
});
eq('every step runs', run.steps.length, 3);
eq('the first sees the input', seen[0], 'first THE INPUT');
eq('the second sees the first output', seen[1], 'second answer to: first THE INPUT');
eq('the third can reach back past the second', seen[2], 'third answer to: first THE INPUT');
eq('the chain returns the last output', run.output, 'answer to: third answer to: first THE INPUT');
check('and every step keeps its own', run.steps.every(s => s.output.length > 0));

// The decision the whole module turns on: each step is asked on its own, so a
// small context is not spent on the chain's own history.
check('no step is sent the conversation so far',
  seen.every(prompt => !/answer to: second/.test(prompt)), JSON.stringify(seen));

/* -------------------------------------------------- when a step goes wrong */

let calls = 0;
run = await C.runChain({
  chain: chain(['{{input}}', 'second {{previous}}', 'third {{previous}}']),
  input: 'x',
  ask: async () => { calls++; if (calls === 2) throw new Error('HTTP 500'); return `ok${calls}`; },
});
eq('a failed step stops the chain', calls, 2);
eq('and says why', run.failed, 'HTTP 500');
eq('the step is marked failed', run.steps[1].state, 'failed');
// Passing the error forward as content produces a final answer confidently
// written from the words "HTTP 500".
eq('what was produced before it is kept', run.output, 'ok1');
eq('and the third step never ran', run.steps.length, 2);

/* --------------------------------------------------------------- stopping */

const controller = new AbortController();
controller.abort();
run = await C.runChain({ chain: chain(['{{input}}', 'x']), input: 'x', ask: echo, signal: controller.signal });
eq('an aborted chain says so', run.cancelled, true);
eq('and runs nothing', run.steps.length, 0);

/* --------------------------------------------------- progress as it happens */

// Four minutes of silence is indistinguishable from a hang, and the
// intermediate outputs are most of the value: when the last step disappoints,
// the interesting question is which step went wrong.
const reported = [];
await C.runChain({
  chain: chain(['{{input}}', 'x {{previous}}']),
  input: 'x',
  ask: echo,
  onStep: (entry) => reported.push(`${entry.index}:${entry.state}`),
});
check('steps are reported as they start and as they finish',
  reported.length === 4, reported.join(' '));
check('running before done', reported[0] === '0:running' && reported[1] === '0:done', reported.join(' '));

/* --------------------------------------------------------------- storage */

store.clear();
C.saveChains('', [chain(['{{input}}'])]);
eq('a chain survives a reload', C.loadChains('').length, 1);
eq('with its steps', C.loadChains('')[0].steps.length, 1);
eq('an account keeps its own', C.loadChains('srv-alice').length, 0);
store.set(C.chainStorageKey(''), 'not json');
eq('unreadable storage is no chains rather than a crash', C.loadChains('').length, 0);
store.set(C.chainStorageKey(''), JSON.stringify([{ name: 'broken', steps: [] }]));
eq('and a chain with no steps is not loaded', C.loadChains('').length, 0);
store.set(C.chainStorageKey(''), JSON.stringify([{ name: 'x', steps: Array.from({ length: 50 }, () => ({ prompt: 'p' })) }]));
eq('a chain longer than the limit is cut', C.loadChains('')[0].steps.length, C.MAX_STEPS);

/* --------------------------------------------------------------- starters */

// Three, and each is a shape rather than a subject. Twenty would be a list
// nobody reads; three that visibly do different things demonstrate what the
// placeholders are for.
eq('there are three to start from', C.STARTER_CHAINS.length, 3);
check('each has a name to translate', C.STARTER_CHAINS.every(c => c.nameKey));
check('and every step does too', C.STARTER_CHAINS.every(c => c.steps.every(s => s.titleKey)));
check('the first step of each takes the input',
  C.STARTER_CHAINS.every(c => C.referencesIn(c.steps[0].prompt).includes('input')));
check('and none of them refers forwards', C.STARTER_CHAINS.every(
  c => C.blocking(C.validateChain({ name: 'x', steps: c.steps })).length === 0));

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the app can run a chain', /runChain\(/.test(code));
check('with what is in the composer as the input', /input: asked/.test(code));
check('each step is a turn of its own, not a conversation',
  /messages: \[\{ role: 'user', content: prompt \}\]/.test(code));
check('progress is written to the transcript as it happens', /onStep:/.test(code));
check('a chain is validated before anybody waits on it', /blocking\(validateChain/.test(code));
check('and the intermediate outputs are kept', /chainRun/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['chains.title', 'chains.run', 'chains.step', 'chains.forward',
  'chains.starter.critique', 'chains.failed']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['chain-trace', 'chain-step', 'chain-editor']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
