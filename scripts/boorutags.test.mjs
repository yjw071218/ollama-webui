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
eq('the fixture loads, spill excluded', index.size, 7);
check('the front of a broken row is kept', index.names.includes('witch'), index.names.join(' | '));
check('and the spill is not', !index.names.some(n => n.includes('말하는 경향이')), index.names.join(' | '));

// Ordered by how many pictures carry the tag, so a query that matches many
// still leads with the one people mean.
eq('the most used tag comes first', index.names[0], '1girl');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
