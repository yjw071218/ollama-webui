// One prompt, many pictures: `{red|blue|silver} hair` and `__poses__`.
//
// The Studio could vary a number across a batch and could not vary a word,
// which is most of what exploring a prompt is. And the one pinned character per
// conversation, which stops a model re-inventing the person in every picture.
// Both are string handling whose mistakes do not throw: a choice made twice
// records a different picture from the one drawn, and a character written twice
// is a heavier character than anybody asked for.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const W = await import(pathToFileURL(path.join(ROOT, 'src/wildcards.js')).href);
const first = () => 0;
const second = () => 1;

/* ----------------------------------------------------------------- lists */

eq('lists are one per line, name: a | b | c',
  W.parseWildcardLists('poses: standing | sitting\nhair : red hair|blue hair|\n'),
  { poses: ['standing', 'sitting'], hair: ['red hair', 'blue hair'] });
eq('  and a line with no name, or no choices, is skipped rather than breaking the rest',
  W.parseWildcardLists(': a | b\nempty:\nok: x'), { ok: ['x'] });
eq('  names are not case-sensitive', Object.keys(W.parseWildcardLists('Poses: a')), ['poses']);

/* ------------------------------------------------------------ choosing */

eq('an inline choice picks one', W.expandWildcards('{smile|frown}', { pick: second }), 'frown');
eq('a named list picks one of its lines',
  W.expandWildcards('__poses__', { lists: { poses: ['standing', 'sitting'] }, pick: second }), 'sitting');
eq('choices nest', W.expandWildcards('{a|{b|c}}', { pick: second }), 'c');
// A name with no list stays as typed: it says "that list does not exist" far
// more plainly than a gap in the prompt would.
eq('a list that does not exist is left as it was typed', W.expandWildcards('__nope__, x', { pick: first }), '__nope__, x');
// Braces mean other things in prompts; one with no bar is not a choice.
eq('braces with no choice in them are not touched', W.expandWildcards('{sic}, {a|b}', { pick: first }), '{sic}, a');
eq('a prompt with none is returned untouched', W.expandWildcards('1girl, (smile:1.2)'), '1girl, (smile:1.2)');
eq('and says so cheaply', [W.hasWildcards('1girl'), W.hasWildcards('{a|b}'), W.hasWildcards('__x__')], [false, true, true]);

/* A conversation's prompt travels twice -- whole, and as the subject inside it
   -- and a choice made independently for each would draw red hair and record
   blue. One memo, one choice. */
{
  let n = 0;
  const alternating = () => (n++) % 2;
  const memo = new Map();
  const whole = W.expandWildcards('masterpiece, {red|blue} hair, smile', { memo, pick: alternating });
  const subject = W.expandWildcards('{red|blue} hair', { memo, pick: alternating });
  check('the same group is chosen the same way across one request',
    whole.includes('red hair') && subject === 'red hair', `${whole} / ${subject}`);
}

/* ------------------------------------------------------------ the wiring */

const studio = read('server/studio.js');
check('the server chooses, once per picture, before anything reads the prompt',
  /const typedPrompt = job\.prompt;/.test(studio)
  && /job\.prompt = expandWildcards\(job\.prompt, \{ lists, memo \}\);/.test(studio));
check('  including the subject, with the same memo',
  /job\.subject = expandWildcards\(job\.subject, \{ lists, memo \}\);/.test(studio));
check('both senders hand it the lists',
  /wildcards: getSetting\('wildcards'\) \|\| ''/.test(read('src/App.jsx'))
  && /wildcards: getSetting\('wildcards'\) \|\| ''/.test(read('src/StudioPanel.jsx')));
// The card shows what was drawn; `parts` keeps the template for loading back.
check('the Studio card shows the prompt that was drawn', /\.\.\.\(data\.prompt \? \{ prompt: data\.prompt \} : \{\}\)/.test(read('src/StudioPanel.jsx')));

/* ============================================= the conversation's character

   Reported: a model writing `iseri nina (blue archive)` for a character who has
   nothing to do with that game, and a different spelling of her in every
   picture of the same conversation. */

const C = await import(pathToFileURL(path.join(ROOT, 'src/characters.js')).href);

eq('the character goes at the front, exactly as chosen',
  C.withPinnedCharacter('iseri nina, black hair', 'sitting, classroom'), 'iseri nina, black hair, sitting, classroom');
eq('  and anything the model also wrote about her is not said twice',
  C.withPinnedCharacter('iseri nina, black hair', 'black hair, iseri nina, sitting'), 'iseri nina, black hair, sitting');
// The same tag in the other bracket spelling is the same tag.
eq('  in either spelling of the brackets',
  C.withPinnedCharacter('hoshino \\(blue archive\\)', 'hoshino (blue archive), smile'), 'hoshino \\(blue archive\\), smile');
eq('with nothing pinned, the prompt is the prompt', C.withPinnedCharacter('', 'a, b'), 'a, b');

const app = read('src/App.jsx');
check('a drawing in the chat starts with the pinned character',
  /const prompt = withPinnedCharacter\(pinned, \(m\[2\] \|\| ''\)\.trim\(\)\);/.test(app));
// Adding the tags is half of it. Telling the model not to write its own is the
// half that stops the wrong series getting in at all.
check('  and the model is told not to write her itself',
  /This conversation's character is fixed as:/.test(app)
  && /Do not write\\n'\s*\n\s*\+ '  any character, series or appearance tags/.test(app));
check('  set from the model menu, for this chat alone',
  /onChange=\{\(e\) => updateCurrentSession\(\{ character: e\.target\.value \}\)\}/.test(app));

const i18n = read('src/i18n.jsx');
for (const key of ['picset.corrected', 'character.title', 'character.help', 'wildcards.title', 'wildcards.help', 'schedule.helpServer']) {
  check(`${key} is translated everywhere`, (i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length === 12);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
