// Tags: what a chat is *also* about.
//
// Folders answer "where does this live" and can only ever answer it once. A
// conversation that is thesis work and a Rust question and something to come
// back to needs all three at once, and no hierarchy holds that.
//
// Two rules carry the design and pull against each other. Matching folds case,
// so typing `Rust` where `rust` exists does not make a second tag. Display does
// not, because lowercasing somebody's writing is a small insult that adds up.
import { rolldown } from 'rolldown';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'src/tags.js'), platform: 'neutral' });
const out = path.resolve(ROOT, 'node_modules/.tags-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const T = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------ what a tag is */

eq('a tag is its text', T.cleanTag('rust'), 'rust');
eq('trimmed', T.cleanTag('  rust  '), 'rust');
// Both are how tags get typed -- `#rust` in a box, `rust, wasm` pasted -- and
// neither is part of the name.
eq('a leading hash is not part of it', T.cleanTag('#rust'), 'rust');
eq('and neither is a comma', T.cleanTag('rust,'), 'rust');
// Banned inner spaces would be a rule to remember; "side project" is a fine tag.
eq('an inner space survives', T.cleanTag('side  project'), 'side project');
eq('a very long one is cut', T.cleanTag('x'.repeat(100)).length, T.MAX_TAG);
eq('nothing is nothing', T.cleanTag('  '), '');
eq('and undefined does not become "undefined"', T.cleanTag(undefined), '');

eq('two spellings are one tag', T.tagKey('Rust'), T.tagKey('rust'));

/* --------------------------------------------------------- on a chat */

let chat = { id: 1, title: 'Borrow checker', messages: [] };
eq('a chat starts with none', T.tagsOf(chat).length, 0);
eq('and a malformed one does not throw', T.tagsOf({ tags: 'rust' }).length, 0);

chat = { ...chat, tags: T.addTag(chat, 'rust') };
eq('adding one adds it', T.tagsOf(chat)[0], 'rust');
eq('the same one again does not', T.addTag(chat, 'rust').length, 1);
// The point of folding case on the way in: `Rust` and `rust` are the same tag,
// and a chat carrying both would show a duplicate nobody typed.
eq('nor a different spelling of it', T.addTag(chat, 'Rust').length, 1);
eq('but a different tag does', T.addTag(chat, 'wasm').length, 2);
eq('an empty tag is not a tag', T.addTag(chat, '   ').length, 1);

const crowded = { tags: Array.from({ length: 12 }, (_, i) => `t${i}`) };
eq('a chat cannot carry unlimited tags', T.addTag(crowded, 'one more').length, T.MAX_PER_CHAT);

eq('removing takes it off', T.removeTag(chat, 'rust').length, 0);
eq('by any spelling', T.removeTag(chat, 'RUST').length, 0);
eq('and removing one that is not there changes nothing', T.removeTag(chat, 'go').length, 1);

eq('a chat knows what it carries', T.hasTag(chat, 'rust'), true);
eq('case and all', T.hasTag(chat, 'Rust'), true);
eq('and what it does not', T.hasTag(chat, 'go'), false);

/* ----------------------------------------------------- the vocabulary */

const sessions = [
  { id: 1, title: 'Borrow checker', tags: ['Rust', 'thesis'], messages: [{ role: 'user', content: 'a' }] },
  { id: 2, title: 'Lifetimes', tags: ['rust'], messages: [{ role: 'user', content: 'b' }] },
  { id: 3, title: 'Chapter 3', tags: ['thesis', 'writing'], messages: [{ role: 'user', content: 'c' }] },
  { id: 4, title: 'Draft', tags: ['unsent'], draft: true, messages: [] },
];

const vocabulary = T.allTags(sessions);
eq('the commonest tag is first', vocabulary[0].tag, 'Rust');
eq('counted across chats', vocabulary[0].count, 2);
// The first spelling seen wins, so the sidebar does not flicker between `Rust`
// and `rust` as chats are re-ordered.
eq('and shown in the spelling it was first given', vocabulary[0].tag, 'Rust');
eq('a draft contributes no vocabulary', vocabulary.some(v => v.tag === 'unsent'), false);
eq('the list is derived, not registered',
  T.allTags(sessions.filter(s => s.id !== 3)).some(v => v.tag === 'writing'), false);
eq('nothing tagged is an empty vocabulary', T.allTags([]).length, 0);

/* ------------------------------------------------------- suggestions */

const starts = T.suggest(sessions, 'th');
eq('a prefix match is offered', starts[0].tag, 'thesis');
// `ru` means `rust` far more often than `infrastructure`, and a list that puts the
// second first is one people stop reading.
const both = T.suggest([...sessions, { id: 5, tags: ['infrastructure'], messages: [{ role: 'user', content: 'x' }] }], 'ru');
eq('prefix matches come before substring ones', both[0].tag, 'Rust');
check('but the substring one is still there', both.some(s => s.tag === 'infrastructure'));
eq('a tag typed in full is not suggested back', T.suggest(sessions, 'thesis').some(s => s.tag === 'thesis'), false);
eq('an empty query offers the whole vocabulary', T.suggest(sessions, '').length, 3);
eq('and the list is capped', T.suggest(sessions, '', 2).length, 2);

/* --------------------------------------------------------- filtering */

eq('one tag narrows to its chats', T.filterByTags(sessions, ['rust']).length, 2);
// Narrowing, not widening: picking a second tag must show fewer chats.
eq('two tags narrow further', T.filterByTags(sessions, ['rust', 'thesis']).length, 1);
eq('unless asked for either', T.filterByTags(sessions, ['rust', 'writing'], 'any').length, 3);
eq('no tags is no filter', T.filterByTags(sessions, []).length, 4);
eq('and a tag nobody uses is no chats', T.filterByTags(sessions, ['nothing']).length, 0);

/* ------------------------------------------------ reading the search box */

// One box, not two. `#` is how people type a tag anyway.
let parsed = T.parseTagQuery('#rust deadlock');
eq('a hash is a tag', parsed.tags[0], 'rust');
eq('and the rest is still a title search', parsed.text, 'deadlock');
parsed = T.parseTagQuery('#rust #thesis');
eq('two tags are two tags', parsed.tags.length, 2);
eq('with nothing left over', parsed.text, '');
eq('a plain query is all text', T.parseTagQuery('deadlock').text, 'deadlock');
eq('and carries no tags', T.parseTagQuery('deadlock').tags.length, 0);
eq('a bare hash is not a tag', T.parseTagQuery('# ').tags.length, 0);

/* --------------------------------------------------- suggesting for a chat */

// Only from tags that already exist. Inventing vocabulary is how a tag list
// becomes forty near-duplicates.
const fresh = { id: 9, title: 'A rust question', messages: [{ role: 'user', content: 'about lifetimes' }] };
eq('an existing tag found in the text is offered', T.suggestForChat(sessions, fresh)[0], 'Rust');
eq('a chat that already has tags is left alone', T.suggestForChat(sessions, sessions[0]).length, 0);
eq('and one about nothing in the vocabulary gets nothing',
  T.suggestForChat(sessions, { id: 10, title: 'Cooking', messages: [] }).length, 0);
// A one-letter tag would match every chat ever written.
eq('a one-character tag is never suggested',
  T.suggestForChat([{ id: 11, tags: ['x'], messages: [{ role: 'user', content: 'a' }] }],
    { id: 12, title: 'x marks the spot', messages: [] }).length, 0);

/* ------------------------------------------------------------- the wiring */

const app = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8').replace(/\r\n/g, '\n');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

check('chats can be tagged', /const tagSession = /.test(code));
check('and untagged', /const untagSession = /.test(code));
check('the sidebar filters by the tags picked', /filterByTags\(/.test(code));
check('the search box understands #tag', /parseTagQuery\(/.test(code));
check('the vocabulary comes from the chats', /allTags\(sessions\)/.test(code));
check('and a tag change is stamped so it syncs', /reviseSession\(id, s => \(\{ \.\.\.s, tags:/.test(code));

const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8').replace(/\r\n/g, '\n');
for (const key of ['tags.add', 'tags.filterBy', 'tags.none', 'tags.clearFilter']) {
  eq(`every language has "${key}"`, (i18n.split(`'${key}':`).length - 1), 12);
}

const css = fs.readFileSync(path.join(ROOT, 'src/extras.css'), 'utf8');
for (const cls of ['chat-tag', 'tag-filter-bar', 'tag-editor']) {
  check(`.${cls} is styled`, css.includes(`.${cls}`));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
