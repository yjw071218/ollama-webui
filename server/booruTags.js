/**
 * Two hundred thousand danbooru tags, and the posts they came from.
 *
 * ## Why the tag list lives on the server
 *
 * `assets/danbooru-tags.csv` is 22MB: every tag danbooru knows, how many posts
 * carry it, and a Korean description carrying the words a Korean speaker would
 * actually search by — so typing `홍조` finds `blush` and `긴 머리` finds
 * `long hair`. That is the half of this worth having, and it is also the half
 * that makes the file large.
 *
 * Sending it to the browser is not an option: this app is opened from a phone
 * over the LAN as a matter of course, and 22MB per page load to make a text box
 * suggest words is not a trade anybody would take. So the file is parsed once
 * here and the browser asks a question per keystroke instead. The server is on
 * the same machine or in the same room; the round trip costs a millisecond and
 * the download would cost thirty seconds.
 *
 * Loaded lazily, for the same reason: somebody who never opens the Studio
 * should not pay for a feature they are not using.
 *
 * ## Why the CSV needs a real parser
 *
 * It looks like `tag,category,count,description` and is not. Tags contain
 * commas and quotes of their own — `"don't say ""lazy"""` is a real row — and
 * at least one description contains a newline, so splitting on lines loses the
 * row after it. Every shortcut was tried and produced a tag list with a hole in
 * it, which is the kind of bug nobody notices until the one tag they wanted is
 * the one that vanished.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TAG_FILE = path.resolve(HERE, '..', 'assets', 'danbooru-tags.csv');

/* --------------------------------------------------------------- the CSV */

/**
 * RFC 4180, as much of it as this file uses.
 *
 * A field may be quoted; a quoted field may contain commas, newlines and `""`
 * for a literal quote. A character loop rather than a regex, because that
 * newline case means this is not a line-oriented format and a regex that
 * pretends otherwise is exactly where the hole comes from.
 *
 * Rows go to a callback when one is given. Two hundred thousand four-element
 * arrays, materialised before anything reads them, is a copy of the whole file
 * in the shape most expensive to hold — and the caller wants three of the four
 * columns in a different shape anyway.
 *
 * Fields are `slice`d out of the source rather than accumulated a character at
 * a time. The obvious `field += c` version works and costs twenty-two million
 * string concatenations to read this one file.
 */
export const parseCsv = (text, onRow) => {
  // A byte-order mark is not data. Left in, it makes the first tag `﻿1girl` —
  // which matches nothing anybody types and is invisible in every error message
  // it later causes.
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const rows = onRow ? null : [];
  const emit = (row) => { if (onRow) onRow(row); else rows.push(row); };

  let row = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    let value;
    if (source[i] === '"') {
      i += 1;
      const from = i;
      let escaped = false;
      while (i < n) {
        if (source[i] !== '"') { i += 1; continue; }
        if (source[i + 1] === '"') { escaped = true; i += 2; continue; }
        break;
      }
      value = source.slice(from, i);
      if (escaped) value = value.replace(/""/g, '"');
      i += 1;                                     // past the closing quote
    } else {
      const from = i;
      while (i < n && source[i] !== ',' && source[i] !== '\n') i += 1;
      value = source.slice(from, i > from && source[i - 1] === '\r' ? i - 1 : i);
    }
    row.push(value);

    if (i < n && source[i] === ',') { i += 1; continue; }
    while (i < n && source[i] === '\r') i += 1;
    if (i < n && source[i] === '\n') i += 1;
    if (row.length > 1 || row[0] !== '') emit(row);
    row = [];
  }
  if (row.length) emit(row);
  return rows;
};

/* ------------------------------------------------------------- the index

   Parallel arrays rather than an array of objects, and a lower-cased copy of a
   string only where one is actually needed. What is being avoided is not the
   text — 22MB is 22MB — but the two things that multiply it: a second copy of
   every description for case-insensitive search, and a per-row object with its
   own header. */

let cache = null;

/**
 * Every tag, parsed once.
 *
 * Returns an empty index rather than throwing when the file is not there: a
 * missing tag list should cost the Studio its autocomplete, not its ability to
 * generate a picture.
 */
export const loadTags = (file = TAG_FILE) => {
  if (cache && cache.file === file) return cache.index;

  const names = [];
  const lower = [];
  const counts = [];
  // 0 general, 1 artist, 3 copyright, 4 character, 5 meta -- danbooru's own numbering.
  const categories = [];
  const descriptions = [];
  /* The lower-cased description, and only for the rows where that is a
     different string. Fourteen per cent of these descriptions contain an
     upper-case letter (measured, not assumed) — the rest are Korean, which has
     no case, so a blanket second copy would be six-sevenths waste. `null` here
     means "the description is already its own lower-case form". */
  const descLower = [];

  try {
    parseCsv(fs.readFileSync(file, 'utf8'), (row) => {
      const name = (row[0] || '').trim();
      if (!name) return;
      /* Three rows of this file are broken: their description contains a bare
         `"` — `오잇스!"라고 말하는` — which closes the quoted field early and
         spills the rest of the sentence across new fields. The fragments then
         look like tags whose names are half a Korean sentence, and they turn up
         in description searches for common words.

         The count column is what tells them apart: a real row has a number
         there and a fragment has prose. Checked rather than trusted, because
         "the file is well formed" is exactly the assumption that produced the
         fragments. */
      if (!/^\d+$/.test(row[2] || '')) return;
      const description = (row[3] || '').trim();
      const folded = description.toLowerCase();
      names.push(name);
      lower.push(name.toLowerCase());
      counts.push(Number(row[2]) || 0);
      categories.push(Number(row[1]) || 0);
      descriptions.push(description);
      descLower.push(folded === description ? null : folded);
    });
  } catch (e) {
    /* No file, or an unreadable one. An empty index is the right answer. */
  }

  /* Most frequent first, so a query matching hundreds still leads with the tag
     people mean, and the search can stop early knowing the rest are rarer.
     Sorted once here rather than compared on every query. */
  const order = names.map((_, i) => i).sort((a, b) => counts[b] - counts[a]);
  const index = {
    names: order.map(i => names[i]),
    lower: order.map(i => lower[i]),
    counts: Int32Array.from(order, i => counts[i]),
    categories: Int8Array.from(order, i => categories[i]),
    descriptions: order.map(i => descriptions[i]),
    descLower: order.map(i => descLower[i]),
    get size() { return this.names.length; },
  };

  cache = { file, index };
  return index;
};

/** For tests, and for picking up an edited file without a restart. */
export const forgetTags = () => { cache = null; exact = null; series = null; };

/* ----------------------------------------------------------- exact lookup

   "Is this a tag?" asked of every phrase in a prompt, which the linear search
   below is the wrong shape for. A Map from the folded name, built the first
   time it is asked for and kept with the index it came from. The file writes a
   few names with their brackets already escaped -- `bob cut girl \(memekko\)`
   -- so the key has the backslashes taken out. */

let exact = null;

/** The folded form a phrase and a tag are compared in. */
export const tagKey = (text) => String(text || '')
  .toLowerCase()
  .replace(/\\([()])/g, '$1')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** The row a phrase names exactly, or -1. */
export const findTag = (index, phrase) => {
  if (!exact || exact.index !== index) {
    const map = new Map();
    // Most frequent first, so a key shared by two rows keeps the common one.
    for (let i = index.names.length - 1; i >= 0; i -= 1) map.set(tagKey(index.names[i]), i);
    exact = { index, map };
  }
  return exact.map.get(tagKey(phrase)) ?? -1;
};

/* ------------------------------------------ a tag as a model writes it

   Reported: the model writes `iseri nina (blue archive)`, and two separate
   things are wrong with it.

   The parentheses are the first. To every one of these encoders `(...)` is
   emphasis -- `(blue archive)` reads as "weight these two words by 1.1" -- so a
   character tag written plainly is not the character's name at all. What
   danbooru carries, and what the model has seen during training, is
   `iseri nina \(blue archive\)`, escaped; the unescaped form draws somebody
   else entirely.

   The second is the series. `iseri nina (genshin impact)` is a tag that does
   not exist, and a tag that does not exist contributes noise and nothing else.
   The list is right here and knows there is exactly one `iseri nina (...)` in
   two hundred thousand tags, so it can be corrected from the file rather than
   argued with in the system prompt.

   Nothing is touched that the list does not recognise. A prompt is somebody's
   words, and a helpful rewrite of a phrase this file has never heard of is a
   rewrite nobody asked for. */

/** `(` and `)` that are not already escaped, escaped. */
export const escapeTagParens = (text) => String(text || '').replace(/(?<!\\)([()])/g, '\\$1');

/* `(subject:1.2)` -- a weight, not a tag. The tag is inside it. */
const WEIGHTED = /^\(\s*([\s\S]+?)\s*:\s*(-?\d+(?:\.\d+)?)\s*\)$/;

/** What comes before the parenthesised part: `iseri nina (blue archive)` → `iseri nina`. */
export const tagBase = (phrase) => {
  const key = tagKey(phrase);
  const at = key.indexOf(' (');
  return at === -1 ? key : key.slice(0, at).trim();
};

/* Every tag of the form `name (something)`, grouped by the name in front, built
   once per index. The alternative is a scan of two hundred thousand rows per
   tag in the prompt, which is forty milliseconds each and forty tags a
   prompt. */
let series = null;

const seriesMap = (index) => {
  if (series?.index === index) return series.map;
  const map = new Map();
  for (let i = 0; i < index.names.length; i += 1) {
    const key = tagKey(index.names[i]);
    if (!key.includes(' (')) continue;
    const base = key.slice(0, key.indexOf(' (')).trim();
    if (!base) continue;
    const held = map.get(base);
    if (held) held.push(i); else map.set(base, [i]);
  }
  series = { index, map };
  return map;
};

/** Every `name (something)` tag sharing this name, most used first. */
export const seriesFor = (index, base) =>
  (seriesMap(index).get(tagKey(base)) || []).map(i => index.names[i]);

/**
 * One tag, as the list would have it written.
 *
 * `fromModel` is the whole of the difference between correcting and meddling.
 * A prompt typed into the Studio's box is somebody writing tags on purpose,
 * with autocomplete beside them; the only thing safe to do to it is escape the
 * brackets of tags that really exist. A prompt a language model wrote is a
 * different thing: it is confidently wrong about which series a character is
 * from, and a series that is wrong is not a small inaccuracy -- `blue archive`
 * in a prompt drags the whole picture towards Blue Archive, which is exactly
 * what nobody asked for.
 *
 * So, in order:
 *
 *   * a tag the list knows, with brackets in it -- escaped, and nothing else.
 *     `hoshino (blue archive)` is real and the only thing wrong with it is that
 *     the brackets read as emphasis;
 *   * a tag the list does not know whose name has exactly one parenthesised
 *     form -- that form. The wrong series corrected from the file;
 *   * (a model's prompt only) a name the list knows with something invented
 *     after it -- `iseri nina (blue archive)`, where `iseri nina` is a tag and
 *     the two together are not. The brackets are dropped. They were a guess,
 *     and a guess about a franchise is not free: it is a tag that exists
 *     nowhere pulling the picture somewhere nobody asked for;
 *   * anything else -- left exactly as written. `arisu (blue archive)` has
 *     twenty `arisu (...)` tags and is none of them, and "which arisu" is not
 *     a question this file can answer.
 */
export const fixTagPhrase = (index, phrase, { fromModel = false } = {}) => {
  const tag = String(phrase || '').trim();
  if (!tag || !index?.size) return tag;
  // Somebody already escaped it. Their prompt, their spelling.
  if (/\[()]/.test(tag)) return tag;

  if (findTag(index, tag) !== -1) return escapeTagParens(tag);

  const base = tagBase(tag);
  if (!base || base === tagKey(tag)) {
    // No brackets at all: only a name with exactly one form is safe to finish.
    const only = seriesFor(index, base);
    return only.length === 1 && base !== '' ? escapeTagParens(only[0]) : tag;
  }

  const variants = seriesFor(index, base);
  if (variants.length === 1) return escapeTagParens(variants[0]);

  /* The name is a tag on its own and the bracket is not part of any tag. From a
     model that is an invented series, and inventing one is worse than leaving
     it out. From a person it is their words. */
  if (fromModel && findTag(index, base) !== -1) return base;
  return tag;
};

/**
 * A whole prompt, tag by tag.
 *
 * Split on commas, which is what a tag prompt is. A weight around a tag --
 * `(iseri nina (blue archive):1.2)` -- is kept and its inside fixed: the
 * emphasis was deliberate and the tag inside it was not meant to be emphasis at
 * all, which is the whole confusion this untangles.
 */
export const fixTagPrompt = (index, prompt, options) => fixTagPromptReport(index, prompt, options).text;

/**
 * The same, and what it changed.
 *
 * A correction nobody can see is one nobody can trust or argue with. The
 * prompt recorded beside a picture used to change silently, so there was no way
 * to tell that `iseri nina (blue archive)` had become `iseri nina` -- nor, more
 * usefully, to notice when the *list* was the thing that was wrong, which it is
 * for any tag danbooru added after the file was made. `changes` is what the
 * picture's settings show.
 *
 * Escaping alone is not reported. It changes nothing a person would read as a
 * different tag, and a list of every bracket that was escaped would bury the
 * one line that matters.
 */
export const fixTagPromptReport = (index, prompt, { fromModel = false } = {}) => {
  const text = String(prompt ?? '');
  const changes = [];
  if (!text.trim() || !index?.size) return { text, changes };
  const fixedText = text.split(',').map((segment) => {
    const core = segment.trim();
    if (!core) return segment;
    const weight = WEIGHTED.exec(core);
    const inner = weight ? weight[1] : core;
    const fixed = fixTagPhrase(index, inner, { fromModel });
    const rebuilt = weight ? `(${fixed}:${weight[2]})` : fixed;
    if (rebuilt === core) return segment;
    if (tagKey(fixed) !== tagKey(inner)) changes.push({ from: inner, to: fixed });
    // The spacing around it was somebody's; only the tag changes.
    return segment.replace(core, rebuilt);
  }).join(',');
  return { text: fixedText, changes };
};

/* ------------------------------------------------------------ searching

   Five kinds of match, and the order between them is the whole quality of the
   feature. Somebody typing `blue` wants `blue eyes` before `eyebrows visible
   through hair` — even though the second mentions blue in its description and
   the first does not mention it anywhere but its name. */

const RANK_EXACT = 0;
const RANK_PREFIX = 1;
const RANK_WORD = 2;      // starts a word inside the tag: "hair" in "long hair"
const RANK_INSIDE = 3;    // anywhere else in the tag
const RANK_DESCRIBED = 4; // only in the description — which is where Korean lands

const rankOf = (index, i, needle) => {
  const name = index.lower[i];
  if (name === needle) return RANK_EXACT;
  if (name.startsWith(needle)) return RANK_PREFIX;
  const at = name.indexOf(needle);
  if (at > 0) {
    const before = name[at - 1];
    return (before === ' ' || before === '_' || before === '-') ? RANK_WORD : RANK_INSIDE;
  }
  const described = index.descLower[i] ?? index.descriptions[i];
  return described.includes(needle) ? RANK_DESCRIBED : -1;
};

/**
 * The tags a query means, best first.
 *
 * The scan is linear over every tag, which sounds worse than it is: one
 * `indexOf` against a string that is already lower case, two hundred thousand
 * times, measured at under 40ms. The alternative — a prefix index — would
 * answer `blue` quickly and be no help whatsoever for `홍조`, which is the
 * reason the descriptions are carried at all.
 */
export const searchTags = (index, query, limit = 15) => {
  const needle = String(query || '').trim().toLowerCase().replace(/_/g, ' ');
  if (!needle) return [];

  /* Collected per rank rather than sorted at the end. The index is already
     ordered by post count, so each bucket comes out ranked, and the whole
     search is one pass with no comparison sort over two hundred thousand
     rows. */
  const buckets = [[], [], [], [], []];
  let found = 0;
  const size = index.names.length;

  for (let i = 0; i < size; i += 1) {
    const rank = rankOf(index, i, needle);
    if (rank === -1) continue;
    if (buckets[rank].length < limit) { buckets[rank].push(i); found += 1; }
    // Everything a prefix match could still outrank has already been found.
    if (buckets[RANK_EXACT].length + buckets[RANK_PREFIX].length >= limit) break;
    if (found >= limit * 5) break;
  }

  /* A description-only match is a fallback, and it should behave like one.
   *
   * With one name match and room for twelve, the list padded itself out with
   * eleven tags that merely mention the word somewhere in their description —
   * `black choker` followed by four obscure characters whose costume is
   * described as having one. Technically matches; not what anybody scanning a
   * dropdown is looking for.
   *
   * But they cannot simply be cut: a Korean query produces *nothing else*.
   * `홍조` matches no tag name at all and every useful hit is a description
   * match. So they are trimmed only when the name matches have already given
   * the reader something to choose from. */
  const byName = buckets[RANK_EXACT].length + buckets[RANK_PREFIX].length
    + buckets[RANK_WORD].length + buckets[RANK_INSIDE].length;
  /* One name match is enough to know which of the two kinds of query this is.
     `black choker` matches exactly one tag by name and a hundred by
     description — a dozen obscure characters whose costume happens to be
     described as having one, each with two hundred pictures against the real
     tag's hundred and eighty thousand. Two are kept rather than none, in case
     the name match was the incidental one. */
  if (byName >= 1) buckets[RANK_DESCRIBED] = buckets[RANK_DESCRIBED].slice(0, 2);

  return buckets.flat().slice(0, limit).map(i => ({
    name: index.names[i],
    count: index.counts[i],
    description: index.descriptions[i],
  }));
};

/** Every tag used often enough to be useful as an LLM candidate. */
export const tagsAboveCount = (index, minimum = 1000) => {
  const threshold = Number(minimum) || 1000;
  return index.names.filter((_, i) => index.counts[i] > threshold);
};

/* ================================================== a post, from its link

   Pasting a link is the fastest way to describe a picture somebody has already
   found — which is why the workflow this app runs had a booru node wired into
   it in the first place. */

/**
 * Which site, and which post.
 *
 * Each of these puts the id somewhere different, and two of them put it in the
 * query string. Returns null for anything that is not a booru post link, which
 * is how a pasted paragraph is told apart from a pasted URL.
 */
export const parseBooruUrl = (raw) => {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (e) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  // `/posts/123` on danbooru, `/post/show/123` on the older software.
  const inPath = /\/posts?\/(?:show\/)?(\d+)/.exec(url.pathname);
  const id = url.searchParams.get('id') || inPath?.[1] || null;
  if (!id || !/^\d+$/.test(id)) return null;

  if (/(^|\.)donmai\.us$/.test(host)) return { site: 'danbooru', id, host };
  if (host === 'safebooru.org') return { site: 'safebooru', id, host };
  if (host === 'gelbooru.com') return { site: 'gelbooru', id, host };
  if (host === 'yande.re') return { site: 'yandere', id, host };
  if (host === 'konachan.com' || host === 'konachan.net') return { site: 'konachan', id, host };
  return null;
};

/** Where to ask that site about that post, as JSON. */
export const apiUrlFor = ({ site, id, host } = {}) => {
  switch (site) {
    case 'danbooru': return `https://${host}/posts/${id}.json`;
    case 'safebooru': return `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&id=${id}`;
    case 'gelbooru': return `https://gelbooru.com/index.php?page=dapi&s=post&q=index&json=1&id=${id}`;
    case 'yandere': return `https://yande.re/post.json?tags=id:${id}`;
    case 'konachan': return `https://${host}/post.json?tags=id:${id}`;
    default: return null;
  }
};

/* Danbooru's own other front doors.
 *
 * `danbooru.donmai.us` is blocked by several countries' ISPs, this one
 * included: the connection is refused in under a tenth of a second, which is a
 * block rather than an outage. These are Danbooru's own instances of the same
 * database -- the same post ids, the same API, the same tags -- and measured
 * from the machine this runs on, they answer in about two thirds of a second
 * while the main host answers not at all.
 *
 * Tried in the order written: `safebooru.donmai.us` first because it is the
 * long-standing mirror, `betabooru.donmai.us` after it.
 *
 * Deliberately not applied to the other sites. gelbooru is blocked here too
 * and has no mirror to fall back to, and inventing hostnames for it would mean
 * three failed connections instead of one before saying so. */
export const DANBOORU_MIRRORS = ['safebooru.donmai.us', 'betabooru.donmai.us'];

/**
 * Every address worth trying for one post, best first.
 *
 * One entry for everything that is not danbooru. A caller walks the list and
 * stops at the first that answers; see the `/studio/booru` route.
 */
export const apiUrlsFor = (post) => {
  const first = apiUrlFor(post);
  if (!first) return [];
  if (post?.site !== 'danbooru') return [first];
  return [first, ...DANBOORU_MIRRORS
    .filter(host => host !== post.host)
    .map(host => apiUrlFor({ ...post, host }))];
};

/**
 * A tag, as these models want to read it.
 *
 * Boorus write `long_hair` and `chocho_(homelessfox)`. The underscore is a
 * convention, and every one of these models was trained on the words with
 * spaces between them. The parenthesis is worse than a convention: bare
 * brackets are prompt-weighting syntax, so an unescaped character name silently
 * reweights everything inside it.
 */
export const cleanTag = (tag) => String(tag || '')
  .replace(/_/g, ' ')
  .replace(/([()])/g, '\\$1')
  .trim();

/* Tags that describe the *post* rather than the picture — how large the file
   is, whether somebody has asked for a translation. A model handed "commentary
   request" draws a caption. */
const META = new Set([
  'highres', 'absurdres', 'lowres', 'incredibly absurdres', 'huge filesize',
  'commentary', 'commentary request', 'translated', 'translation request',
  'check translation', 'bad id', 'bad link', 'bad pixiv id', 'bad twitter id',
  'md5 mismatch', 'revision', 'artist request', 'character request',
  'copyright request', 'source request', 'tagme', 'non-web source',
  'scan', 'official art', 'game cg', 'third-party edit', 'resolution mismatch',
]);

/**
 * The tags of one post, split by what they are for.
 *
 * danbooru and its clones return the split for free, which is what makes the
 * separate artist box worth having. The gelbooru family returns one flat string
 * with the artists mixed in unmarked, so `artist` comes back empty rather than
 * filled with a guess.
 */
export const tagsFromPost = (post) => {
  if (!post || typeof post !== 'object') return null;

  const split = (value) => String(value || '').split(/\s+/).filter(Boolean).map(cleanTag);
  const usable = (list) => list.filter(t => !META.has(t.toLowerCase()));

  if (post.tag_string_general !== undefined || post.tag_string_artist !== undefined) {
    return {
      // Copyright and character first: they say what this *is*, and a prompt
      // reads better when the subject comes before the adjectives.
      general: usable([
        ...split(post.tag_string_copyright),
        ...split(post.tag_string_character),
        ...split(post.tag_string_general),
      ]),
      artist: split(post.tag_string_artist),
      rating: post.rating || '',
    };
  }

  const flat = post.tags ?? post.tag_string;
  if (flat === undefined) return null;
  return { general: usable(split(flat)), artist: [], rating: post.rating || '' };
};

/** The first post, in whatever shape the site answered with. */
export const firstPost = (payload) => {
  if (Array.isArray(payload)) return payload[0] || null;
  if (payload && Array.isArray(payload.post)) return payload.post[0] || null;
  if (payload && typeof payload === 'object' && Object.keys(payload).length) return payload;
  return null;
};

/* ---------------------------------------------------- keeping the list current

   The tag list is now the authority for correcting prompts -- a bracket it does
   not know is removed from a model's prompt -- so a list that is out of date
   corrects things wrongly: a character danbooru added last month is, to this
   file, a character nobody has ever heard of. These are the pure halves of
   `scripts/update-tags.mjs`; the network half is in the script. */

/** One row of the file, quoted the way `parseCsv` reads it back. */
export const csvRow = (fields) => fields.map((field) => {
  const text = String(field ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}).join(',');

/**
 * Danbooru's API tag, as a row of this file.
 *
 * The API speaks `arisu_(blue_archive)`; the file speaks `arisu \(blue archive\)`,
 * the way a prompt has to be written -- see `cleanTag`. Returns null for anything
 * that is not a live tag with posts.
 */
export const rowFromApiTag = (tag) => {
  const name = cleanTag(tag?.name);
  const count = Number(tag?.post_count);
  if (!name || !Number.isFinite(count) || count <= 0 || tag?.is_deprecated) return null;
  return { name, category: Number(tag?.category) || 0, count, description: '' };
};

/**
 * The file's rows with the API's laid over them.
 *
 * What the file already has is kept -- above all its Korean descriptions, which
 * are the reason the file exists and which danbooru does not have. What the API
 * adds is the tags the file never heard of, today's post counts, and the
 * category, which this file carries as 0 for every row and the API knows.
 * Most used first, which is the order everything that reads the file assumes.
 */
export const mergeTagRows = (existing = [], fetched = []) => {
  /* Every existing row is kept, including two that fold to the same key.
     The file has pairs like that -- a spelling with underscores beside one with
     spaces, a case variant -- and keying the rows by `tagKey` merged each pair
     into one, so an update that was meant only to add tags removed sixty-four.
     A row is a row; the key only decides which one the API's figures land on. */
  const rows = existing.filter(row => row?.name).map(row => ({ ...row }));
  const firstByKey = new Map();
  rows.forEach((row) => {
    const key = tagKey(row.name);
    if (!firstByKey.has(key)) firstByKey.set(key, row);
  });

  let added = 0;
  let updated = 0;
  for (const row of fetched) {
    if (!row?.name) continue;
    const key = tagKey(row.name);
    const held = firstByKey.get(key);
    if (!held) {
      const fresh = { ...row };
      rows.push(fresh);
      firstByKey.set(key, fresh);
      added += 1;
      continue;
    }
    const count = Math.max(Number(held.count) || 0, Number(row.count) || 0);
    const category = held.category || row.category || 0;
    if (count !== held.count || category !== held.category) updated += 1;
    held.count = count;
    held.category = category;
  }
  rows.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
  return { rows, added, updated };
};

