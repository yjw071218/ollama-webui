// Prompt blocks, kept by name.
//
// The failures worth pinning are the quiet ones. Adding a block twice must not
// double the tags in it -- these models read a repeated tag as a heavier one,
// so "add my quality words" pressed twice silently changes the picture.
// Loading one must not blank the boxes it says nothing about. And a save that
// does not move its timestamp is a save no other device ever hears about,
// which is how the sampling presets and the personas each broke once already.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const P = await import(pathToFileURL(path.join(ROOT, 'src/studioPresets.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ---------------------------------------------------------- what is in one

   The four boxes and nothing else. Not the size, not the sampler: those belong
   to the workflow and are already remembered per workflow, and loading a
   character that also changed the resolution is the kind of surprise that
   makes a feature untrustworthy. */

eq('a block is the four boxes', Object.keys(P.presetValues({
  lead: 'masterpiece', artist: 'by someone', prompt: '1girl', tail: 'detailed',
  width: 832, sampler: 'euler',
})).sort(), ['artist', 'lead', 'prompt', 'tail']);
eq('and each is trimmed', P.presetValues({ prompt: '  1girl  ' }).prompt, '1girl');
eq('a box not mentioned is empty, not missing', P.presetValues({}).lead, '');
check('four empty boxes are not a block', P.isEmptyPreset(P.presetValues({})));
check('but one word is', !P.isEmptyPreset(P.presetValues({ tail: 'detailed' })));

/* ------------------------------------------------------------- loading one

   Replacing what it names and leaving the rest. A character block has no
   opinion about quality tags, and blanking them because it is silent about
   them would be answering a question nobody asked. */

{
  const form = { lead: 'masterpiece', artist: 'by A', prompt: 'a cat', tail: 'detailed', width: 832 };
  const loaded = P.applyPreset(form, { prompt: '1girl, blue hair', artist: 'by B' }, 'replace');
  eq('what the block names is replaced', loaded.prompt, '1girl, blue hair');
  eq('  and so is the rest of what it names', loaded.artist, 'by B');
  eq('what it says nothing about is left alone', loaded.lead, 'masterpiece');
  eq('and what is not a box at all is untouched', loaded.width, 832);
}

/* --------------------------------------------------------------- adding one

   Tag by tag, because a prompt with its quality tags in it twice is not merely
   untidy: these models read a repeated tag as a heavier one, so pressing the
   button twice would quietly change the picture. */

{
  const form = { prompt: '1girl, smile' };
  const once = P.applyPreset(form, { prompt: 'detailed, 1girl' }, 'add');
  eq('adding brings in only what is missing', once.prompt, '1girl, smile, detailed');
  const twice = P.applyPreset(once, { prompt: 'detailed, 1girl' }, 'add');
  eq('and pressing it again does nothing at all', twice.prompt, once.prompt);
}
eq('adding to an empty box just fills it',
  P.applyPreset({ prompt: '' }, { prompt: 'detailed' }, 'add').prompt, 'detailed');
eq('a block that says nothing adds nothing',
  P.applyPreset({ prompt: '1girl' }, { prompt: '   ' }, 'add').prompt, '1girl');
// Case is a spelling, not a different tag.
eq('the same tag in another case is the same tag',
  P.applyPreset({ prompt: 'Masterpiece' }, { prompt: 'masterpiece, best quality' }, 'add').prompt,
  'Masterpiece, best quality');

/* ------------------------------------------------------------- the list */

{
  let list = [];
  list = P.withPreset(list, { name: 'my character', values: { prompt: '1girl' }, now: 1000 });
  list = P.withPreset(list, { name: 'quality', values: { lead: 'masterpiece' }, now: 2000 });
  eq('newest first', list.map(item => item.name), ['quality', 'my character']);

  // Typing a name again is how anybody says "update this one".
  list = P.withPreset(list, { name: 'My Character', values: { prompt: '1boy' }, now: 3000 });
  eq('the same name updates rather than duplicates', list.filter(i => /character/i.test(i.name)).length, 1);
  eq('  with the newer words', list.find(i => /character/i.test(i.name)).values.prompt, '1boy');
  eq('  and moves to the front', list[0].name, 'My Character');

  const gone = P.withoutPreset(list, list[0].id);
  eq('one can be forgotten', gone.length, list.length - 1);

  eq('the one in the boxes is known', P.matchingPreset(list, { lead: 'masterpiece' })?.name, 'quality');
  eq('and when none is, none is', P.matchingPreset(list, { prompt: 'something else' }), null);
}

/* ----------------------------------------------------------- the round trip

   Unstamped, the list uploads as `updatedAt: 0` -- older than everything --
   and is replaced by whatever the account already had. That is exactly how the
   user profile behaved before it was stamped. */

{
  const made = P.withPreset([], { name: 'x', values: { prompt: '1girl' }, now: 1 });
  P.saveStudioPresets('acct', made);
  eq('what was saved reads back', P.loadStudioPresets('acct')[0].values.prompt, '1girl');
  check('and the write was stamped, or no other device hears about it',
    !!store.get('settingStamps@acct') && store.get('settingStamps@acct').includes('studioPrompts:acct'));
  eq('another account sees nothing of it', P.loadStudioPresets('someone-else').length, 0);

  store.set(P.presetsKey('broken'), 'not json at all');
  eq('storage that cannot be read is an empty list', P.loadStudioPresets('broken'), []);
  store.set(P.presetsKey('odd'), '{"not":"a list"}');
  eq('and so is storage of the wrong shape', P.loadStudioPresets('odd'), []);
}

/* ------------------------------------------------------------- the wiring */

{
  const panel = fs.readFileSync(path.join(ROOT, 'src/StudioPanel.jsx'), 'utf8');
  const sync = fs.readFileSync(path.join(ROOT, 'src/syncEngine.js'), 'utf8');
  const records = fs.readFileSync(path.join(ROOT, 'server/records.js'), 'utf8');
  const store_ = fs.readFileSync(path.join(ROOT, 'src/settingsStore.js'), 'utf8');

  check('the Studio saves and loads them', /withPreset\(presets/.test(panel) && /applyPreset\(f, preset\.values/.test(panel));
  check('both ways round', /'replace'/.test(panel) && /'add'/.test(panel));
  check('they travel to the account', /studioPrompts: `studioPrompts:\$\{scope\}`/.test(sync));
  check('  as one of the whole-list records', /WHOLE_LISTS = \[[^\]]*'studioPrompts'/.test(sync));
  /* A kind the browser uploads and the server does not know is not "that kind
     does not sync" -- it fails the whole batch. That cost an account a day of
     syncing once already. */
  check('  and the account knows the kind', /'studioPrompts',/.test(records));
  check('  which re-reads in place rather than reloading the page',
    /STUDIO_LISTS = new Set\(\[[^\]]*'studioPrompts'/.test(sync));
  check('and are not swept up as a plain setting as well',
    /'studioSettings', 'studioHistory', 'studioPrompts',/.test(store_));

  const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.jsx'), 'utf8');
  const dicts = (i18n.match(/^const [a-zA-Z]+ = \{$/gm) || []).length;
  const keys = [...new Set([...panel.matchAll(/t\('(block\.[a-zA-Z]+)'/g)].map(m => m[1]))];
  check('the block controls have strings', keys.length >= 6, `${keys.length}`);
  const missing = keys.filter((key) => {
    const n = (i18n.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) || []).length;
    return n !== dicts;
  });
  check(`all ${keys.length} of them are in all ${dicts} languages`, missing.length === 0, missing.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
