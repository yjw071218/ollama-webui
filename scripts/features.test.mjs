// Covers the pure logic behind response variants, auto-continue, chat folders
// and sampling presets.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = async (entry, out) => {
  const bundle = await rolldown({ input: path.resolve(HERE, entry), platform: 'neutral' });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

// localStorage is only touched by the load/save helpers; a stub keeps them testable.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const V = await load('../src/variants.js', '../node_modules/.variants-test.mjs');
const C = await load('../src/continuation.js', '../node_modules/.continuation-test.mjs');
const F = await load('../src/folders.js', '../node_modules/.folders-test.mjs');
const P = await load('../src/presets.js', '../node_modules/.presets-test.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ----------------------------------------------------------------- variants
let msg = { role: 'assistant', content: 'first', metrics: { tps: 10 }, starred: true };
eq('a plain message is one variant', V.variantCount(msg), 1);
check('a plain message has no pager', !V.hasVariants(msg));

msg = V.appendVariant(msg, { content: 'second', metrics: { tps: 20 } });
eq('regenerating keeps the old answer', V.variantCount(msg), 2);
eq('the new answer is shown', msg.content, 'second');
eq('the pager points at the new one', V.variantIndexOf(msg), 1);
check('message-level fields survive', msg.starred === true && msg.role === 'assistant');

msg = V.selectVariant(msg, 0);
eq('going back restores the content', msg.content, 'first');
eq('and its metrics', msg.metrics.tps, 10);
eq('without losing the other', V.variantCount(msg), 2);

msg = V.appendVariant(msg, { content: 'third' });
eq('a third joins the end', V.variantCount(msg), 3);
eq('appending from an older variant still shows the newest', msg.content, 'third');

eq('selecting past the end clamps', V.selectVariant(msg, 99).content, 'third');
eq('selecting below zero clamps', V.selectVariant(msg, -5).content, 'first');
eq('a corrupt index clamps', V.variantIndexOf({ ...msg, variantIndex: 42 }), 2);
eq('a missing index means the last', V.variantIndexOf({ content: 'x', variants: [{ content: 'a' }, { content: 'b' }] }), 1);

const dropped = V.removeVariant(msg, 2);
eq('deleting a variant shortens the list', V.variantCount(dropped), 2);
eq('and lands on a real answer', dropped.content, 'second');
eq('the only variant cannot be deleted', V.variantCount(V.removeVariant({ content: 'solo' }, 0)), 1);
check('variant ids are unique', V.asVariant({ content: 'a' }).id !== V.asVariant({ content: 'a' }).id);
check('no variant id leaks as a message id', dropped.id === undefined);

// -------------------------------------------------------------- continuation
check('a length stop is truncation', C.wasTruncated({ done: true, done_reason: 'length' }));
check('a normal stop is not', !C.wasTruncated({ done: true, done_reason: 'stop' }));
check('an unfinished frame is not', !C.wasTruncated({ done: false, done_reason: 'length' }));
check('a missing frame is not', !C.wasTruncated(null));

// The instruction path: a fresh generation begins a word, so bare boundaries
// take a space.
eq('spaces a bare boundary', C.joinInstructed('...access frequency', 'or model size'), '...access frequency or model size');
eq('does not double a space', C.joinInstructed('One. ', ' Two.'), 'One. Two.');
eq('keeps a single newline', C.joinInstructed('line\n', 'next'), 'line\nnext');
eq('collapses a stacked paragraph break', C.joinInstructed('para.\n', '\n\nNext.'), 'para.\n\nNext.');
eq('an empty start drops leading space', C.joinInstructed('', '   hi'), 'hi');
eq('a blank continuation changes nothing', C.joinInstructed('kept', '   '), 'kept');

// The prefill path: the model carried on the same token stream and brought its
// own spacing, so nothing may be inserted.
eq('prefill joins verbatim', C.joinPrefill('...access frequency', ' or model size'), '...access frequency or model size');
eq('prefill finishes a cut word', C.joinPrefill('the quick brown fo', 'x jumps'), 'the quick brown fox jumps');
eq('prefill finishes a cut number', C.joinPrefill('answer is 4', '2'), 'answer is 42');
eq('prefill preserves a paragraph break', C.joinPrefill('para.', '\n\nNext.'), 'para.\n\nNext.');
eq('prefill ignores a blank continuation', C.joinPrefill('kept', '  '), 'kept');
eq('the default mode is the instruction one',
  C.joinContinuation('a', 'b'), C.joinInstructed('a', 'b'));
eq('the mode is honoured', C.joinContinuation('a', 'b', 'prefill'), 'ab');

const opening = 'Ollama manages model memory using a Least Recently Used cache combined with a configurable timeout';
check('a restarted reply is spotted',
  C.looksRestarted(opening, 'Ollama manages model memory using a **Least Recently Used (LRU) cache mechanism** combined'));
check('a genuine continuation is not',
  !C.looksRestarted(opening, ' or model size alone; instead it relies on a predictable timeout.'));
check('a short tail is not judged', !C.looksRestarted('ok', 'ok then'));
check('an empty continuation is not judged', !C.looksRestarted(opening, ''));

const prev = 'To keep a model resident you set keep_alive on the request.';
eq('drops a repeated tail',
  C.joinInstructed(prev, ' keep_alive on the request. It takes a duration.'),
  prev + ' It takes a duration.');
eq('a short coincidence is not treated as a repeat',
  C.trimOverlap('ends with a', 'a new thought'), 'a new thought');
eq('an exact restatement collapses to nothing new',
  C.trimOverlap('the same long sentence here', 'the same long sentence here'), '');
check('the instruction forbids repeating', /not repeat/i.test(C.CONTINUE_PROMPT));

// ------------------------------------------------------------------ folders
const work = F.newFolder('  Work  ');
eq('the name is trimmed', work.name, 'Work');
eq('an empty name gets a placeholder', F.newFolder('   ').name, 'Untitled');
eq('a long name is capped', F.newFolder('x'.repeat(200)).name.length, F.MAX_NAME);
check('folder ids are unique', F.newFolder('a').id !== F.newFolder('a').id);

const personal = F.newFolder('Personal');
const folders = [work, personal];
const sessions = [
  { id: 1, folderId: work.id }, { id: 2, folderId: work.id },
  { id: 3, folderId: 'deleted-elsewhere' }, { id: 4 },
];
const grouped = F.groupByFolder(sessions, folders);
eq('chats land in their folder', grouped.grouped[0].sessions.length, 2);
eq('an empty folder still shows', grouped.grouped[1].sessions.length, 0);
eq('a dangling id falls back to loose', grouped.loose.length, 2);
eq('every chat is accounted for',
  grouped.grouped.reduce((n, g) => n + g.sessions.length, 0) + grouped.loose.length, sessions.length);

const after = F.removeFolder(folders, sessions, work.id);
eq('deleting a folder removes only it', after.folders.length, 1);
eq('and keeps every chat', after.sessions.length, 4);
eq('the chats inside become loose', after.sessions.filter(s => s.folderId === null).length, 2);

eq('renaming works', F.renameFolder(folders, work.id, 'Research')[0].name, 'Research');
eq('an empty rename is refused', F.renameFolder(folders, work.id, '   ')[0].name, 'Work');
eq('a folder prompt can be set', F.updateFolder(folders, work.id, { systemPrompt: 'Be terse.' })[0].systemPrompt, 'Be terse.');
eq('assigning moves a chat', F.assignToFolder(sessions, 4, personal.id)[3].folderId, personal.id);
eq('assigning null unfiles it', F.assignToFolder(sessions, 1, null)[0].folderId, null);
eq('folderOf resolves', F.folderOf({ folderId: personal.id }, folders).name, 'Personal');
eq('folderOf tolerates a dangling id', F.folderOf({ folderId: 'nope' }, folders), null);

store.clear();
F.saveFolders('u1', folders);
eq('folders round-trip', F.loadFolders('u1').length, 2);
eq('another profile sees its own', F.loadFolders('u2').length, 0);
store.set('chatFolders:bad', '{not json');
eq('corrupt storage yields nothing', F.loadFolders('bad').length, 0);

// ------------------------------------------------------------------ presets
eq('temperature is clamped high', P.sanitisePreset({ temperature: 99 }).temperature, 2);
eq('temperature is clamped low', P.sanitisePreset({ temperature: -5 }).temperature, 0);
eq('topP is clamped', P.sanitisePreset({ topP: 5 }).topP, 1);
eq('numCtx has a floor', P.sanitisePreset({ numCtx: 1 }).numCtx, 256);
eq('maxTokens allows the -1 sentinel', P.sanitisePreset({ maxTokens: -1 }).maxTokens, -1);
eq('a non-numeric seed is dropped', P.sanitisePreset({ seed: 'abc' }).seed, '');
eq('a numeric seed is kept', P.sanitisePreset({ seed: '42' }).seed, '42');
eq('stop sequences stay a string', P.sanitisePreset({ stopSequences: 'END' }).stopSequences, 'END');
check('unknown fields are dropped', !('nonsense' in P.sanitisePreset({ nonsense: 1 })));
check('absent fields stay absent', !('topK' in P.sanitisePreset({ temperature: 1 })));
check('NaN is dropped', !('temperature' in P.sanitisePreset({ temperature: NaN })));

eq('there are four starting points', P.BUILTIN_PRESETS.length, 4);
check('every builtin is marked', P.BUILTIN_PRESETS.every(p => p.builtin && p.nameKey));
check('every builtin survives sanitising',
  P.BUILTIN_PRESETS.every(p => Object.keys(P.sanitisePreset(p.values)).length === Object.keys(p.values).length));

const current = { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.1, minP: 0 };
eq('the active settings are recognised', P.matchPreset(P.BUILTIN_PRESETS, current).id, 'builtin-balanced');
eq('a changed setting stops matching',
  P.matchPreset(P.BUILTIN_PRESETS, { ...current, temperature: 0.75 }), null);
check('a saved preset captures the values', P.newPreset('Mine', { temperature: 0.5 }).values.temperature === 0.5);
eq('a preset name is capped', P.newPreset('y'.repeat(99), {}).name.length, 40);

store.clear();
P.savePresets('u1', [P.newPreset('Mine', { temperature: 0.5 })]);
eq('presets round-trip', P.loadPresets('u1').length, 1);
store.set('samplingPresets:u3', JSON.stringify([{ id: 'x', name: 'bad', values: { temperature: 99 } }]));
eq('and are re-clamped on load', P.loadPresets('u3')[0].values.temperature, 2);
store.set('samplingPresets:u4', 'oops');
eq('corrupt preset storage yields nothing', P.loadPresets('u4').length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
