// Which model answers this one.
//
// Eight installed models exist because no one of them is right for everything.
// Changing model is already one click; the cost was never the click, it was
// remembering to do it before typing. Rules make that automatic.
//
// The failure this has to avoid is fighting the user. A feature that quietly
// puts the model back after you changed it by hand is a bug nobody can report,
// and the whole thing rests on trusting what the selector says.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/routing.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.routing-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const R = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ the signals */

// Decidable by looking, never by asking a model. A round trip before every
// message to answer something the wording settles outright would be slower and
// wrong in ways nobody could see.
const sig = (over) => R.signalsFor({ text: '', images: 0, tokens: 100, ...over });

eq('a fenced block is code', sig({ text: '```js\nconst x = 1;\n```' }).code, true);
eq('so is a signature', sig({ text: 'function add(a, b) {' }).code, true);
eq('and an indented block', sig({ text: 'here:\n\n    return 1\n' }).code, true);
eq('and a tag', sig({ text: 'why does <div class="x"> not center' }).code, true);
eq('prose is not', sig({ text: 'what is the capital of Peru' }).code, false);

eq('an image is vision', sig({ images: 1 }).vision, true);
eq('and no image is not', sig({ images: 0 }).vision, false);

eq('a big conversation is long', sig({ tokens: 20000 }).long, true);
eq('and a small one is not', sig({ tokens: 200 }).long, false);
// "Long" is a fact about the conversation, not about the sentence just typed:
// a one-word follow-up 20k tokens deep is a long request.
eq('even a one-word follow-up in a long chat is long',
  sig({ text: 'why?', tokens: 20000 }).long, true);

eq('a terse question is short', sig({ text: 'capital of Peru?', tokens: 8 }).short, true);
// A short question that is code is a code question: the fast-model rule must
// not intercept "why does this segfault" for being terse.
eq('but terse code is not', sig({ text: 'why does free(p); crash?', tokens: 10 }).short, false);
eq('and neither is a terse question with a picture',
  sig({ text: 'what is this', images: 1, tokens: 5 }).short, false);

/* -------------------------------------------------------------- routing */

const installed = ['fast:3b', 'coder:14b', 'big:30b', 'eyes:11b'];
const sees = (model) => model === 'eyes:11b';
const rule = (when, model) => ({ ...R.newRule(when, model) });

let route = R.routeFor({
  rules: [rule('code', 'coder:14b')],
  signals: sig({ text: '```js\nx\n```' }),
  installed,
  current: 'fast:3b',
});
eq('a matching rule routes', route.model, 'coder:14b');
eq('and says why', route.when, 'code');

eq('a rule that does not match does not route',
  R.routeFor({ rules: [rule('code', 'coder:14b')], signals: sig({ text: 'hello' }), installed, current: 'fast:3b' }), null);

// The same rules are meant to survive being carried to another machine. A
// laptop without the 30B should fall through, not fail to send.
eq('a rule naming a model that is not installed is skipped',
  R.routeFor({
    rules: [rule('code', 'absent:70b'), rule('code', 'coder:14b')],
    signals: sig({ text: '```x```' }), installed, current: 'fast:3b',
  }).model, 'coder:14b');

eq('a disabled rule is skipped',
  R.routeFor({
    rules: [{ ...rule('code', 'big:30b'), enabled: false }, rule('code', 'coder:14b')],
    signals: sig({ text: '```x```' }), installed, current: 'fast:3b',
  }).model, 'coder:14b');

eq('the first matching rule wins',
  R.routeFor({
    rules: [rule('always', 'big:30b'), rule('code', 'coder:14b')],
    signals: sig({ text: '```x```' }), installed, current: 'fast:3b',
  }).model, 'big:30b');

// Nothing to say when the answer is the model already selected. A chip
// announcing a change that did not happen is noise.
eq('routing to the model already chosen is not a route',
  R.routeFor({
    rules: [rule('code', 'coder:14b')],
    signals: sig({ text: '```x```' }), installed, current: 'coder:14b',
  }), null);

// The rule the whole feature rests on.
eq('a model chosen by hand is never overridden',
  R.routeFor({
    rules: [rule('always', 'big:30b')],
    signals: sig({}), installed, current: 'fast:3b', manual: true,
  }), null);

eq('no rules is no routing', R.routeFor({ rules: [], signals: sig({}), installed, current: 'fast:3b' }), null);
eq('and no arguments at all does not throw', R.routeFor(), null);

/* ------------------------------------------------------------- vision */

// Not a preference. A text-only model handed an image does not answer badly,
// it fails — so this applies even when no rule mentions vision.
route = R.routeFor({
  rules: [], signals: sig({ images: 1 }), installed, current: 'fast:3b', supportsVision: sees,
});
eq('an image moves off a model that cannot see', route.model, 'eyes:11b');
eq('and is marked as a correction rather than a preference', route.forced, true);

route = R.routeFor({
  rules: [rule('vision', 'eyes:11b')],
  signals: sig({ images: 1 }), installed, current: 'fast:3b', supportsVision: sees,
});
eq('a vision rule is honoured where there is one', route.model, 'eyes:11b');
eq('and then it is not a forced correction', route.forced, false);

eq('a model that can already see is left alone',
  R.routeFor({ rules: [], signals: sig({ images: 1 }), installed, current: 'eyes:11b', supportsVision: sees }), null);
// Nothing installed can see: sending to a model that cannot is at least
// reported by Ollama, and silently swapping to another blind model is not.
eq('with nothing that can see, nothing is moved',
  R.routeFor({ rules: [], signals: sig({ images: 1 }), installed: ['fast:3b'], current: 'fast:3b', supportsVision: () => false }), null);

/* --------------------------------------------------------------- storage */

store.clear();
R.saveRules('', [rule('code', 'coder:14b')]);
eq('rules survive a reload', R.loadRules('').length, 1);
eq('with the condition', R.loadRules('')[0].when, 'code');
eq('an account keeps its own', R.loadRules('srv-alice').length, 0);
store.set(R.routingStorageKey(''), 'not json');
eq('unreadable storage is no rules rather than a crash', R.loadRules('').length, 0);
store.set(R.routingStorageKey(''), JSON.stringify([{ when: 'nonsense', model: 'm' }]));
eq('a condition that no longer exists becomes "always"', R.loadRules('')[0].when, 'always');
eq('and a rule with no model is dropped',
  R.loadRules('') && (store.set(R.routingStorageKey(''), JSON.stringify([{ when: 'code' }])), R.loadRules('').length), 0);

/* ------------------------------------------------------------ suggestions */

// From model names, which is a real signal — people who ship a coding model
// say so in the tag — and not a reliable one, which is why these are offered
// as a filled-in form rather than applied.
const suggested = R.suggestRules(['llama3:3b', 'qwen2.5-coder:14b', 'llama3:70b', 'llava:7b'],
  { supportsVision: (m) => /llava/.test(m) });
check('a coding model is suggested for code',
  suggested.find(r => r.when === 'code')?.model === 'qwen2.5-coder:14b',
  JSON.stringify(suggested));
check('a model that can see, for images',
  suggested.find(r => r.when === 'vision')?.model === 'llava:7b');
check('the largest for long conversations',
  suggested.find(r => r.when === 'long')?.model === 'llama3:70b');
check('and the smallest for quick questions',
  suggested.find(r => r.when === 'short')?.model === 'llama3:3b');

// Advice about nothing. One model, or four of the same size, has no spread to
// exploit and suggesting a split would be theatre.
eq('a machine with one model gets no size rules',
  R.suggestRules(['llama3:8b']).filter(r => r.when === 'long' || r.when === 'short').length, 0);
eq('and neither does one with models of the same size',
  R.suggestRules(['a:8b', 'b:8b']).filter(r => r.when === 'long').length, 0);
eq('nothing installed is nothing suggested', R.suggestRules([]).length, 0);
eq('and a model whose name says no size is simply not sized',
  R.suggestRules(['mystery', 'other']).length, 0);

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('the send path asks where the message should go', /routeFor\(/.test(code));
check('from signals it counts rather than guesses', /signalsFor\(/.test(code));
check('vision capability is answered by the app that knows it',
  /supportsVision: modelSupportsVision/.test(code));
check('choosing a model by hand turns routing off for that chat',
  /modelPickedByHand/.test(code));
check('and the transcript says which rule moved it', /routedBy/.test(code));
check('rules can be suggested from what is installed', /suggestRules\(/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['routing.title', 'routing.when.code', 'routing.routed', 'routing.suggest', 'routing.forced']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['routing-rule', 'routed-chip']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
