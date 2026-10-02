// Two hundred thousand danbooru tags, and the posts they came from.
//
// Almost everything here fails silently when it is wrong. A CSV parser that
// mishandles a quoted comma produces a tag list with a hole in it — no error,
// just the one tag somebody wanted quietly missing. A ranking that puts
// description matches above name matches produces suggestions that are all
// technically correct and never the one meant. A tag sent to the model with its
// brackets unescaped reweights the whole prompt.
//
// So the fixtures below are the awkward rows from the real file rather than
// invented ones, and the real file is used for the parts that need its size.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const B = await import(pathToFileURL(path.join(ROOT, 'server/booruTags.js')).href);
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deep = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* ------------------------------------------------------------- the parser

   This file looks like `tag,category,count,description` and is not. Every
   shortcut was tried against the real thing and each one lost rows. */

deep('an ordinary row', B.parseCsv('a,0,1,hello\n'), [['a', '0', '1', 'hello']]);

// A description is prose and prose has commas in it. Splitting on `,` merges
// the description into the next columns and loses the row after it.
deep('a comma inside a quoted field is not a separator',
  B.parseCsv('a,0,1,"one, two, three"\n'), [['a', '0', '1', 'one, two, three']]);

// `"don't say ""lazy"""` is a real tag in this file.
deep('a doubled quote is one literal quote',
  B.parseCsv('"say ""hi""",0,1,x\n'), [['say "hi"', '0', '1', 'x']]);

/* And at least one description contains a newline, which is what makes this not
   a line-oriented format. A parser that reads it line by line does not merely
   mangle that row — it loses the one after it too. */
deep('a newline inside a quoted field is not the end of the row',
  B.parseCsv('a,0,1,"line\nbreak"\nb,0,2,next\n'),
  [['a', '0', '1', 'line\nbreak'], ['b', '0', '2', 'next']]);

deep('a row without a trailing newline still arrives',
  B.parseCsv('a,0,1,x'), [['a', '0', '1', 'x']]);
deep('CRLF is not part of the last field', B.parseCsv('a,0,1,x\r\n'), [['a', '0', '1', 'x']]);
deep('an empty trailing field is a field', B.parseCsv('a,0,1,\n'), [['a', '0', '1', '']]);
deep('nothing at all is no rows', B.parseCsv(''), []);
// Left in, this makes the first tag of the file `﻿1girl` — which matches
// nothing anyone types and is invisible in every error it causes.
deep('the byte-order mark is not part of the first tag',
  B.parseCsv('﻿1girl,0,1,x\n'), [['1girl', '0', '1', 'x']]);

// Rows can go to a callback instead of an array: the real file is 205,000 of
// them and materialising all four columns is a copy of it in the most
// expensive shape available.
const streamed = [];
B.parseCsv('a,0,1,x\nb,0,2,y\n', row => streamed.push(row[0]));
deep('rows can be streamed rather than collected', streamed, ['a', 'b']);

/* ------------------------------------------------------------ the index */

const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'tags-sample.csv');
B.forgetTags();
const index = B.loadTags(FIXTURE);

/* Three rows of the real file are broken: a bare `"` inside a description
   closes the field early and the rest of the sentence — commas and all —
   spills into fields of its own. The fixture carries one of the same shape.
   What survives is the front of that row, which is a real tag with a real
   count and is worth keeping; what has to be dropped is the spill, whose
   "name" is half a Korean sentence and whose "count" is the other half. */
// Fifteen rows: seven of the original shapes, and eight character and
// copyright tags added for the escaping and the series correction below.
eq('the fixture loads, spill excluded', index.size, 15);
check('the front of a broken row is kept', index.names.includes('witch'), index.names.join(' | '));
check('and the spill is not', !index.names.some(n => n.includes('말하는 경향이')), index.names.join(' | '));

// Ordered by how many pictures carry the tag, so a query that matches many
// still leads with the one people mean.
eq('the most used tag comes first', index.names[0], '1girl');
{
  const popular = B.tagsAboveCount(index, 1000);
  check('popular tags use a strict count threshold',
    popular.includes('1girl') && !popular.includes('rare'));
}

/* ----------------------------------------------------------- searching */

const names = (q, n = 5) => B.searchTags(index, q, n).map(h => h.name);

eq('an exact match wins', names('blush')[0], 'blush');
// `blue` must find `blue eyes` before something that merely mentions blue in
// its description.
eq('a prefix beats a mention', names('blue')[0], 'blue eyes');
// The tag is `long hair` and people type `hair`; a match at a word boundary is
// worth more than one in the middle of another word.
check('a word inside the tag is found', names('hair').includes('long hair'), names('hair').join(' | '));

/* The reason the descriptions are carried at all. Nobody with a Korean keyboard
   is going to guess that the tag for 홍조 is spelled `blush`. */
eq('Korean finds the English tag', names('홍조')[0], 'blush');
eq('and a Korean phrase does too', names('긴 머리')[0], 'long hair');

/* Fourteen per cent of these descriptions contain an upper-case letter, so a
   description search that only matched lower case would silently miss them. */
eq('a description match ignores case', names('SMILING')[0], 'smile');

eq('an empty query suggests nothing', B.searchTags(index, '', 5).length, 0);
eq('and so does whitespace', B.searchTags(index, '   ', 5).length, 0);
eq('a query that matches nothing returns nothing', B.searchTags(index, 'qqqzzz', 5).length, 0);
// People type the tag as it is written on the site, underscores and all.
eq('an underscore is typed but not stored', names('long_hair')[0], 'long hair');
eq('the list is capped', B.searchTags(index, 'a', 2).length, 2);

/* A description-only match is a fallback and behaves like one. With one name
   match and room for twelve, the list used to pad itself with tags that merely
   mention the word somewhere in their description — `black choker` followed by
   four obscure characters whose costume is described as having one.

   They cannot simply be cut, though: a Korean query produces nothing else, so
   they are trimmed only once the name matches have given the reader something
   to choose from. */
const blueHits = B.searchTags(index, 'blue', 12).map(h => h.name);
check('name matches come first', blueHits[0] === 'blue eyes', blueHits.join(' | '));
check('and a thin tail of description matches follows, not a long one',
  blueHits.length <= 6, blueHits.join(' | '));
/* One name match is enough to know which kind of query this is. `black choker`
   matches exactly one tag by name and a hundred by description — obscure
   characters whose costume is described as having one, each with a couple of
   hundred pictures against the real tag's hundred and eighty thousand. */
const oneName = B.searchTags(index, 'aqua', 12).map(h => h.name);
check('a single name match still trims the tail', oneName.length <= 3, oneName.join(' | '));
check('and that name is first', oneName[0] === 'aqua hair', oneName.join(' | '));
// `홍조` matches no tag name at all — every useful hit is a description match,
// so the trim must not apply.
check('a query answered only by descriptions keeps them all',
  B.searchTags(index, '홍조', 12).length >= 1);

const hit = B.searchTags(index, 'blush', 1)[0];
check('a hit carries what it is for', typeof hit.description === 'string' && hit.description.length > 0);
check('and how many pictures have it', hit.count > 0);

// A missing file costs the Studio its autocomplete, not its ability to work.
B.forgetTags();
eq('a missing tag file is an empty index', B.loadTags(path.join(ROOT, 'nope.csv')).size, 0);
B.forgetTags();

/* ================================================== a post, from its link */

const parsed = (url) => B.parseBooruUrl(url);

deep('danbooru, by path',
  parsed('https://danbooru.donmai.us/posts/7108138'), { site: 'danbooru', id: '7108138', host: 'danbooru.donmai.us' });
// donmai runs several subdomains and they all speak the same API.
eq('and its other subdomains', parsed('https://safebooru.donmai.us/posts/1')?.site, 'danbooru');
deep('safebooru, by query string',
  parsed('https://safebooru.org/index.php?page=post&s=view&id=7108138'),
  { site: 'safebooru', id: '7108138', host: 'safebooru.org' });
eq('gelbooru', parsed('https://gelbooru.com/index.php?page=post&s=view&id=42')?.id, '42');
eq('yande.re', parsed('https://yande.re/post/show/12345')?.site, 'yandere');
eq('konachan', parsed('https://konachan.net/post/show/999')?.site, 'konachan');
eq('www is not part of the host', parsed('https://www.gelbooru.com/index.php?id=7')?.site, 'gelbooru');

check('a site nobody asked for is refused', parsed('https://example.com/posts/1') === null);
check('a booru link with no post is refused', parsed('https://danbooru.donmai.us/tags') === null);
check('prose is not a URL', parsed('draw me a picture of a lighthouse') === null);
check('and neither is a file path', parsed('file:///etc/passwd') === null);
check('nor an empty string', parsed('') === null);

eq('the API url for danbooru',
  B.apiUrlFor({ site: 'danbooru', id: '7', host: 'danbooru.donmai.us' }),
  'https://danbooru.donmai.us/posts/7.json');
check('safebooru asks its dapi', /page=dapi/.test(B.apiUrlFor({ site: 'safebooru', id: '7' })));
check('an unknown site has no API url', B.apiUrlFor({ site: 'nope' }) === null);

/* ---- tags, as a model wants to read them ---- */

// Every one of these models was trained on the words with spaces between them.
eq('an underscore becomes a space', B.cleanTag('long_hair'), 'long hair');
/* And this one is not cosmetic: bare brackets are prompt-weighting syntax, so
   an unescaped character name silently reweights everything inside it. */
eq('brackets are escaped', B.cleanTag('chocho_(homelessfox)'), 'chocho \\(homelessfox\\)');
eq('nothing is nothing', B.cleanTag(''), '');

const danbooruPost = {
  tag_string_general: 'long_hair blush highres commentary_request',
  tag_string_character: 'hakurei_reimu',
  tag_string_copyright: 'touhou',
  tag_string_artist: 'some_artist',
  rating: 's',
};
const split = B.tagsFromPost(danbooruPost);
// Copyright and character first: they say what this *is*, and a prompt reads
// better with the subject before the adjectives.
eq('the subject comes first', split.general[0], 'touhou');
eq('then the character', split.general[1], 'hakurei reimu');
/* `highres` and `commentary request` describe the *post*, not the picture. A
   model handed "commentary request" draws a caption. */
check('post metadata is not a description of the picture',
  !split.general.includes('highres') && !split.general.includes('commentary request'),
  split.general.join(' | '));
deep('the artist comes back separately', split.artist, ['some artist']);

// The gelbooru family returns one flat string with artists mixed in unmarked,
// so a guess would be a guess.
const flat = B.tagsFromPost({ tags: 'long_hair blush', rating: 'general' });
deep('a flat tag list still works', flat.general, ['long hair', 'blush']);
deep('and claims no artists rather than guessing', flat.artist, []);
check('a post that is not a post is null', B.tagsFromPost(null) === null);
check('and neither is an object with no tags in it', B.tagsFromPost({ id: 1 }) === null);

eq('an array of posts gives the first', B.firstPost([{ id: 1 }, { id: 2 }])?.id, 1);
eq('and so does gelbooru\'s wrapper', B.firstPost({ post: [{ id: 3 }] })?.id, 3);
eq('a bare post is the post', B.firstPost({ id: 4 })?.id, 4);
check('an empty answer is no post', B.firstPost([]) === null);
check('and so is an empty object', B.firstPost({}) === null);

/* ------------------------------------------------------------ the wiring */

const studio = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8');
check('the tag route exists', /'\/studio\/tags'/.test(studio));
check('the design route exposes all popular tags',
  /'\/studio\/design-tags'/.test(studio)
  && /tagsAboveCount\(index, 1000\)/.test(studio));
check('and the booru one', /'\/studio\/booru'/.test(studio));
/* A missing tag file has to be reported rather than answered with an empty
   list: "no suggestions" and "the file is gone" look identical from the
   browser, and only one of them is something the reader can fix. */
check('a missing tag file is reported, not silently empty',
  /if \(!index\.size\)[\s\S]{0,300}success: false/.test(studio));
// No booru sends `Access-Control-Allow-Origin`, so a browser fetch returns an
// opaque response and the page gets nothing.
check('the booru fetch happens on the server', /await fetch\(api, \{/.test(studio));
check('and names this app, as their terms ask', /'User-Agent': 'ollama-webui/.test(studio));

// The tag file itself, since the feature is nothing without it.
const csv = path.join(ROOT, 'assets', 'danbooru-tags.csv');
check('the tag file is in the project', fs.existsSync(csv));
if (fs.existsSync(csv)) {
  check('and it is the big one', fs.statSync(csv).size > 10 * 1024 * 1024);
}

/* ============================================== danbooru, on a network that blocks it

   Measured from the machine this runs on: `danbooru.donmai.us` refuses the
   connection in 0.06 seconds -- an ISP block, not an outage -- while
   `safebooru.donmai.us` and `betabooru.donmai.us` answer 200. Those are
   Danbooru's own instances of the same database, so the post ids are the same
   ones and the tags that come back are the same tags. */

{
  const danbooru = B.apiUrlsFor({ site: 'danbooru', id: '5000000', host: 'danbooru.donmai.us' });
  check('a danbooru post has more than one door', danbooru.length > 1, String(danbooru.length));
  check('  the one that was asked for comes first',
    danbooru[0].includes('danbooru.donmai.us'), danbooru[0]);
  check('  and the mirrors carry the same post id',
    danbooru.every(url => url.includes('/posts/5000000.json')), danbooru.join(' '));
  /* A link that already names a mirror must not list that mirror twice: the
     second attempt would be the same refusal, more slowly. */
  check('a link that already names a mirror does not repeat it',
    new Set(B.apiUrlsFor({ site: 'danbooru', id: '7', host: 'safebooru.donmai.us' })).size === 2);

  /* Only danbooru. gelbooru is blocked here too and has no mirror to fall back
     to; inventing hostnames for it would mean three failed connections instead
     of one before saying so. */
  eq('every other site has exactly one', B.apiUrlsFor({ site: 'safebooru', id: '7' }).length, 1);
  eq('and an unknown site has none', B.apiUrlsFor({ site: 'nope' }).length, 0);
}

{
  const studioSrc = fs.readFileSync(path.join(ROOT, 'server/studio.js'), 'utf8');
  check('the route walks them, stopping at the first that answers',
    /for \(const api of apis\)/.test(studioSrc));
  /* A refused connection moves on; an *answer* does not, however unwelcome. A
     404 from the first host is the real answer about that post id, and asking
     a mirror would produce the same 404 more slowly. */
  check('  and a 404 is an answer, not a reason to try the next one',
    /if \(!upstream\.ok\) \{[\s\S]{0,200}has no post/.test(studioSrc));
  check('  saying which door it came through when it was not the first',
    /reached && reached !== post\.host \? \{ via: reached \}/.test(studioSrc));
}


/* ============================ a tag as a model writes it, and as one is read

   Reported: the model writes `iseri nina (blue archive)`, and two separate
   things are wrong with it.

   The brackets are the first, and they are the silent one. To every one of
   these image encoders `(...)` is *emphasis* -- `(blue archive)` means "weight
   these two words by 1.1" -- so a character tag written plainly is not a name
   at all. Danbooru's own form, and the form these models were trained on, is
   `hoshino \(blue archive\)`.

   The series is the second: a character attached to the wrong franchise is a
   tag that exists nowhere, and contributes noise and nothing else.

   The tag list the Studio already reads for autocomplete is the authority for
   both, and nothing it does not recognise is touched -- a prompt is somebody's
   words, and a helpful rewrite of a phrase this file has never heard of is a
   rewrite nobody asked for. */

eq('brackets are escaped', B.escapeTagParens('hoshino (blue archive)'), 'hoshino \\(blue archive\\)');
eq('  and not escaped twice', B.escapeTagParens('hoshino \\(blue archive\\)'), 'hoshino \\(blue archive\\)');
eq('  including a bracket with nothing in it', B.escapeTagParens('()'), '\\(\\)');

eq('the name in front of the brackets', B.tagBase('hoshino (blue archive)'), 'hoshino');
eq('  written either way', B.tagBase('hoshino \\(blue archive\\)'), 'hoshino');
eq('  and a tag with no brackets is all name', B.tagBase('1girl'), '1girl');

/* A real tag. The only thing wrong with it is the brackets, so that is the
   only thing that changes. */
eq('a real character tag is escaped and left alone otherwise',
  B.fixTagPhrase(index, 'hoshino (blue archive)'), 'hoshino \\(blue archive\\)');
eq('  and one already escaped is not touched',
  B.fixTagPhrase(index, 'ganyu \\(genshin impact\\)'), 'ganyu \\(genshin impact\\)');
eq('an ordinary tag is left exactly as it is', B.fixTagPhrase(index, '1girl'), '1girl');

/* A name the list knows with something invented after it. `iseri nina` is a
   tag; `iseri nina (blue archive)` is not, and she has nothing to do with that
   game. The brackets were a guess, and a guessed franchise is not a harmless
   extra -- `blue archive` in a prompt pulls the whole picture towards that
   game's characters and art. So it goes. */
eq('an invented series is dropped from a model’s prompt',
  B.fixTagPhrase(index, 'iseri nina (blue archive)', { fromModel: true }), 'iseri nina');
/* And is not touched in somebody's own. The Studio's box is a person writing
   tags on purpose with autocomplete beside them; editing their words is not
   this function's business. */
eq('  and left alone in one somebody typed',
  B.fixTagPhrase(index, 'iseri nina (blue archive)'), 'iseri nina (blue archive)');
eq('  the same rule for any invented bracket',
  B.fixTagPhrase(index, 'smile (wide)', { fromModel: true }), 'smile');

/* And what it must not do. There are two `arisu (...)` tags in the fixture and
   this is neither of them; "which arisu" is not a question the file can
   answer, and guessing is worse than leaving it. */
eq('an unknown tag with brackets is left as written',
  B.fixTagPhrase(index, 'arisu (blue archive)'), 'arisu (blue archive)');
eq('  as is a phrase the list has never heard of',
  B.fixTagPhrase(index, 'a girl standing in the rain'), 'a girl standing in the rain');

/* ------------------------------------------------------------ a whole prompt */

eq('every tag in a prompt, one at a time',
  B.fixTagPrompt(index, '1girl, hoshino (blue archive), blush'),
  '1girl, hoshino \\(blue archive\\), blush');

// A weight was deliberate. The tag inside it was not meant to be one, which is
// the whole confusion being untangled.
eq('a weight is kept and its tag fixed inside it',
  B.fixTagPrompt(index, '(hoshino (blue archive):1.2), smile'),
  '(hoshino \\(blue archive\\):1.2), smile');
eq('  and a weight around an ordinary word is not a tag to fix',
  B.fixTagPrompt(index, '(masterpiece:1.4), 1girl'), '(masterpiece:1.4), 1girl');

eq('a whole prompt from a model loses its invented brackets',
  B.fixTagPrompt(index, 'iseri nina (blue archive), smile', { fromModel: true }),
  'iseri nina, smile');
eq('  and keeps the brackets of tags that are real',
  B.fixTagPrompt(index, 'iseri nina (blue archive), hoshino (blue archive)', { fromModel: true }),
  'iseri nina, hoshino \\(blue archive\\)');
eq('  while a prompt somebody typed is only ever escaped',
  B.fixTagPrompt(index, 'iseri nina (blue archive), smile'),
  'iseri nina (blue archive), smile');

eq('spacing around a tag is the writer’s', B.fixTagPrompt(index, '1girl,  blush  , smile'), '1girl,  blush  , smile');
eq('an empty prompt is an empty prompt', B.fixTagPrompt(index, ''), '');
// No tag file: nothing is known, so nothing is changed.
eq('with no list at all, a prompt is left alone',
  B.fixTagPrompt({ size: 0 }, 'hoshino (blue archive)'), 'hoshino (blue archive)');

/* --------------------------------------------------------------- the wiring */

const generateRoute = read('server/studio.js');
check('the generate route corrects the prompt it was given',
  /const fixedPrompt = fixTagPromptReport\(index, job\.prompt, \{ fromModel \}\);/.test(generateRoute)
  && /job\.prompt = fixedPrompt\.text;/.test(generateRoute));
check('  and the negative, which is tags too',
  /const fixedNegative = fixTagPromptReport\(index, job\.negative, \{ fromModel \}\);/.test(generateRoute)
  && /job\.negative = fixedNegative\.text;/.test(generateRoute));
/* Only a conversation sends `chat`, so it is what tells a model's words from a
   person's -- and the difference decides whether a bracket may be dropped. */
check('  knowing whose words it is correcting', /const fromModel = !!job\.chat;/.test(generateRoute));
// A clip's prompt is a timeline of sentences, not tags. Nothing in it would
// match a tag, but it is not a prompt this has any business reading.
check('  and leaves a video prompt alone', /if \(definition\.kind !== 'video'\)/.test(generateRoute));
// Whether the tag list corrected it or a wildcard chose, what is recorded
// beside the picture is what ComfyUI was actually given.
check('  reporting what was actually sent',
  /\.\.\.\(!shaped\?\.changed && \(tagged \|\| job\.prompt !== typedPrompt\) \? \{ prompt: job\.prompt \} : \{\}\)/.test(generateRoute));

const app = read('src/App.jsx');
check('the model is told how a character tag is written',
  /A character tag is written the way danbooru writes it/.test(app));
// Telling it the guess will be removed is what takes the upside out of
// guessing; "write the name alone if unsure" on its own had not.
check('  and that a series it is unsure of will be removed',
  /Put a series in brackets ONLY when you are certain/.test(app)
  && /a bracket that is not in it is\s*\n\s*removed/.test(app));
check('  and what unescaped brackets actually mean',
  /brackets mean \*emphasis\*/.test(app));
check('  with escaped examples, not plain ones',
  /"hoshino \\\\\(blue archive\\\\\)", "ganyu \\\\\(genshin impact\\\\\)"/.test(app));
check('the native tool schema says the same',
  /"hoshino \\\\\(blue archive\\\\\)", "ganyu \\\\\(genshin impact\\\\\)"/.test(read('src/tools.js')));
// Both spellings are one tag when a character is being taken out of a prompt.
check('and a character is matched in either spelling',
  /const sameTag = \(tag\) =>/.test(read('src/characters.js')));


/* ------------------------------------------------ saying what was corrected

   A correction nobody can see is one nobody can trust or argue with -- and the
   useful argument is the one where the *list* is wrong, which it is for any
   tag danbooru added after the file was made. */
{
  const report = B.fixTagPromptReport(index, 'iseri nina (blue archive), hoshino (blue archive), smile', { fromModel: true });
  deep('a correction is reported as what it was and what it became',
    report.changes, [{ from: 'iseri nina (blue archive)', to: 'iseri nina' }]);
  // Escaping changes nothing a person would read as a different tag, and a list
  // of every bracket escaped would bury the one line that matters.
  check('  and escaping alone is not a correction',
    !report.changes.some(c => /hoshino/.test(c.from)), JSON.stringify(report.changes));
  eq('  while the text is the same as fixTagPrompt gives',
    report.text, B.fixTagPrompt(index, 'iseri nina (blue archive), hoshino (blue archive), smile', { fromModel: true }));
}
check('the route sends the corrections back', /\.\.\.\(corrections\.length \? \{ corrections \} : \{\}\)/.test(read('server/studio.js')));
check('the chat keeps them on the picture', /queued\.corrections\?\.length \? \{ corrections: queued\.corrections \}/.test(read('src/App.jsx')));
{
  const { settingsRows } = await import(pathToFileURL(path.join(ROOT, 'src/pictureSettings.js')).href);
  const rows = settingsRows({ prompt: 'iseri nina', corrections: [{ from: 'iseri nina (blue archive)', to: 'iseri nina' }] });
  const row = rows.find(r => r.key === 'corrected');
  eq('and the picture settings say it, beside the prompt', row?.value, 'iseri nina (blue archive) → iseri nina');
  eq('  saying nothing when nothing was corrected', settingsRows({ prompt: 'x' }).some(r => r.key === 'corrected'), false);
}

/* --------------------------------------------------- keeping the list current

   The list is the authority the server corrects against, so a list from last
   month corrects last month's characters away. `arisu (blue archive)` is a real
   danbooru tag this file did not have. */
{
  deep('an API tag becomes a row the way the file writes one',
    B.rowFromApiTag({ name: 'arisu_(blue_archive)', post_count: 9000, category: 4 }),
    { name: 'arisu \\(blue archive\\)', category: 4, count: 9000, description: '' });
  deep('  and a deprecated or empty one is not a row',
    [B.rowFromApiTag({ name: 'x', post_count: 5, is_deprecated: true }), B.rowFromApiTag({ name: 'y', post_count: 0 })],
    [null, null]);

  const tricky = ['say "hi", ok', 'line\nbreak'];
  const csv = tricky.map((d, i) => B.csvRow([`tag${i}`, 0, 10, d])).join('\n') + '\n';
  deep('a written row reads back exactly, commas, quotes and newlines included',
    B.parseCsv(csv).map(r => r[3]), tricky);

  /* Every existing row is kept. The file has pairs that fold to one key -- an
     underscore spelling beside a spaced one -- and keying rows by that key made
     an update meant only to add tags remove sixty-four of them. */
  const { rows, added, updated } = B.mergeTagRows(
    [
      { name: 'long hair', category: 0, count: 10, description: '긴 머리' },
      { name: 'long_hair', category: 0, count: 3, description: '' },
    ],
    [
      { name: 'long hair', category: 0, count: 50, description: '' },
      { name: 'arisu \\(blue archive\\)', category: 4, count: 9000, description: '' },
    ],
  );
  eq('an update keeps every row it started with', rows.filter(r => /long.hair/.test(r.name)).length, 2);
  eq('  and adds what it did not have', added, 1);
  eq('  keeping a description danbooru does not provide',
    rows.find(r => r.name === 'long hair')?.description, '긴 머리');
  eq('  while taking the newer count', rows.find(r => r.name === 'long hair')?.count, 50);
  eq('  and counting what changed', updated, 1);
  eq('  most used first, as every reader of the file assumes', rows[0].name, 'arisu \\(blue archive\\)');
}
{
  const script = read('scripts/update-tags.mjs');
  // Swapped in only once complete, and only after it reads back: a file this
  // parser cannot read is not an update, it is a Studio with no autocomplete.
  check('the update script reads its file back before swapping it in',
    /readable !== rows\.length/.test(script) && /fs\.renameSync\(next, B\.TAG_FILE\)/.test(script));
  check('  keeps the old one', /copyFileSync\(B\.TAG_FILE, `\$\{B\.TAG_FILE\}\.bak`\)/.test(script));
  check('  and can be tried without touching anything', /if \(DRY\)/.test(script));
  check('  and is one command away', /"tags:update": "node scripts\/update-tags\.mjs"/.test(read('package.json')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
