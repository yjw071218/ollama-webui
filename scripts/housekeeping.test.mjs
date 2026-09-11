// Which chats are worth doing something about.
//
// Four hundred conversations in, the ones that matter are indistinguishable
// from the three hundred that were a single question answered in ten seconds.
// The work here is not the deleting, it is the deciding.
//
// Everything is about being conservative. A suggestion that turns out wrong
// once teaches somebody to stop reading the list, and a list nobody reads is
// worse than no list — it took the space where a real one could have been.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/housekeeping.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.housekeeping-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const H = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 30);
const ago = (days) => NOW - days * DAY;

// Each chat opens differently unless a test wants otherwise: two chats with
// the same opening line really are duplicates by these rules, and a fixture
// that shares one everywhere tests the duplicate rule by accident everywhere.
const chat = (id, over = {}) => ({
  id, title: `chat ${id}`, createdAt: ago(200), updatedAt: ago(1),
  messages: [
    { role: 'user', content: `a question about subject number ${id}` },
    { role: 'assistant', content: 'an answer' },
  ],
  ...over,
});

const kindsFor = (sessions, id) =>
  H.suggestions(sessions, { now: NOW }).filter(s => s.id === id).map(s => s.kind);

/* ------------------------------------------------------------ what it finds */

const sessions = [
  chat(1),                                                            // ordinary, recent
  chat(2, { messages: [] }),                                          // empty
  chat(3, { messages: [{ role: 'user', content: 'never answered' }] }), // abandoned
  chat(4, { updatedAt: ago(200) }),                                   // stale
  chat(5, { messages: [
    { role: 'user', content: 'x'.repeat(120000) },
    { role: 'assistant', content: 'y' },
  ] }),                                                               // oversized
];

const found = H.suggestions(sessions, { now: NOW });
check('an empty chat is found', found.some(s => s.id === 2 && s.kind === 'empty'));
check('a question that was never answered is found', found.some(s => s.id === 3 && s.kind === 'abandoned'));
check('a chat untouched for months is found', found.some(s => s.id === 4 && s.kind === 'stale'));
check('and one that has grown enormous', found.some(s => s.id === 5 && s.kind === 'huge'));
eq('an ordinary recent chat is left alone', kindsFor(sessions, 1).length, 0);

// Losing an empty chat costs nothing; deleting a long one is irreversible. The
// order is the order of how little there is to regret.
eq('the safest suggestions come first', found[0].kind, 'empty');
check('and the one that is only advice comes last', found[found.length - 1].kind === 'huge');

// A chat this long is a suggestion to read, not to remove: every new turn in
// it re-reads twenty thousand tokens before writing a word.
eq('an oversized chat is not a deletion', found.find(s => s.kind === 'huge').action, 'open');
eq('a stale one is an archiving, which is reversible',
  found.find(s => s.kind === 'stale').action, 'archive');
eq('and only the empty ones are deletions',
  found.find(s => s.kind === 'empty').action, 'delete');

/* --------------------------------------------------------- being careful */

// Each of these is somebody having already decided about the chat. Overruling
// an explicit decision is what makes a whole list untrustworthy.
eq('a pinned chat is never suggested',
  kindsFor([chat(9, { pinned: true, messages: [], updatedAt: ago(300) })], 9).length, 0);
eq('nor one holding a starred message',
  kindsFor([chat(10, {
    updatedAt: ago(300),
    messages: [{ role: 'assistant', content: 'a', starred: true }],
  })], 10).length, 0);
eq('nor one already archived',
  kindsFor([chat(11, { archived: true, updatedAt: ago(300) })], 11).length, 0);
eq('nor a draft', kindsFor([chat(12, { draft: true, messages: [] })], 12).length, 0);

// Six weeks is a conversation you might still be in the middle of.
eq('six weeks old is not stale', kindsFor([chat(13, { updatedAt: ago(42) })], 13).length, 0);
check('three months is', kindsFor([chat(14, { updatedAt: ago(95) })], 14).includes('stale'));

/* ---------------------------------------------------------- duplicates */

const twice = [
  chat(20, { updatedAt: ago(10), messages: [{ role: 'user', content: 'how do lifetimes work in rust exactly' }, { role: 'assistant', content: 'a' }] }),
  chat(21, { updatedAt: ago(2), messages: [{ role: 'user', content: 'how do lifetimes work in rust exactly' }, { role: 'assistant', content: 'b' }] }),
];
const dupes = H.suggestions(twice, { now: NOW }).filter(s => s.kind === 'duplicate');
eq('asking the same thing twice is one suggestion, not two', dupes.length, 1);
// The older one may have been continued; the newer is the accident.
eq('and it is the newer copy that is offered', dupes[0].id, 21);
eq('naming the one it duplicates', dupes[0].otherId, 20);

// A fingerprint of "hi" would make every greeting a duplicate of every other.
eq('two short openings are not duplicates', H.suggestions([
  chat(22, { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'a' }] }),
  chat(23, { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'b' }] }),
], { now: NOW }).filter(s => s.kind === 'duplicate').length, 0);

/* ------------------------------------------------------- one row per chat */

// Three rows about the same conversation make the list look longer than the
// problem it describes.
const both = H.suggestions([chat(30, { messages: [], updatedAt: ago(300) })], { now: NOW });
eq('a chat that is both empty and stale is listed once', both.length, 1);
eq('as the safer of the two', both[0].kind, 'empty');

/* --------------------------------------------------------- what it saves */

const recovered = H.wouldRecover(sessions, found);
check('deleting the suggested ones recovers something', recovered.tokens > 0);
eq('counted in chats too', recovered.chats, 2);
// Archiving keeps the chat, so it recovers nothing.
eq('but archiving is not a saving',
  H.wouldRecover(sessions, found.filter(s => s.action === 'archive')).chats, 0);
eq('and nothing suggested is nothing recovered', H.wouldRecover(sessions, []).tokens, 0);
// The line exists to give a reason to act. "About eighteen tokens" is a true
// sentence that gives nobody one, and printing it makes the panel look like it
// is grasping for something to say.
eq('a trivial saving is not worth reporting',
  H.wouldRecover([chat(40, { messages: [] })],
    [{ kind: 'empty', id: 40, action: 'delete' }]).worthSaying, false);
eq('but a real one is',
  H.wouldRecover([chat(41, { messages: [{ role: 'user', content: 'x'.repeat(40000) }] })],
    [{ kind: 'empty', id: 41, action: 'delete' }]).worthSaying, true);

eq('an empty sidebar has nothing to say', H.suggestions([], { now: NOW }).length, 0);
eq('and malformed entries do not throw', H.suggestions([null, {}], { now: NOW }).length, 0);

/* ------------------------------------------------------------- the wiring */

const panel = fs.readFileSync(path.join(ROOT, 'src/UsagePanel.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the usage panel offers the tidying', /suggestions\(/.test(panel));
check('every row carries its own action', /onAct/.test(panel));
// Archiving is reversible and deleting is not, so only one of them is offered
// in bulk.
check('archiving is offered in bulk', /archiveAll/.test(panel));
check('and deleting is not', !/deleteAll/.test(panel));

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
check('the panel is given a way to act', /onHousekeep/.test(app));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['tidy.title', 'tidy.empty', 'tidy.kind.stale', 'tidy.kind.duplicate',
  'tidy.archiveAll', 'tidy.recover']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['tidy-row', 'tidy-kind']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
