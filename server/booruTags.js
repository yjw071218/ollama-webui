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
export const forgetTags = () => { cache = null; exact = null; };

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
