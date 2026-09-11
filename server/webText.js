/**
 * Reading the web, as text.
 *
 * Four jobs that used to sit inside `api.js` between the account routes and the
 * GPU probe, where nothing could reach them: turning a document into readable
 * text, deciding what encoding that document was written in, deciding which
 * index a query is asking about, and deciding whether a search result is about
 * the question at all.
 *
 * All four are pure, and all four were wrong in ways only a test would have
 * caught. They live here so that one can.
 */

export const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/',
};

export const decodeEntities = (text) => text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
  if (HTML_ENTITIES[name] !== undefined) return HTML_ENTITIES[name];
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X'
      ? parseInt(name.slice(2), 16)
      : parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
  }
  return whole;
});

/** Readable text from an HTML document, without pulling in a DOM library. */
export const htmlToText = (html) => decodeEntities(
  html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
)
  .replace(/[ \t\u00a0]+/g, ' ')
  /* Every stripped tag leaves a space behind, so a line ends up indented by
     however many tags happened to close before it. Harmless on screen and not
     harmless here: this text is going into a prompt with a four-thousand
     character budget, and leading spaces are budget spent on nothing. */
  .replace(/[ \t]*\n[ \t]*/g, '\n')
  .replace(/\n\s*\n\s*\n+/g, '\n\n')
  .trim();

/* ---- Reading a page in the encoding it was actually written in ----

   `response.text()` decodes as UTF-8 whenever the server did not say
   otherwise, and a great deal of the Korean, Japanese and Chinese web does not
   say otherwise in the header — it says so in a `<meta charset>` tag inside
   the bytes, which by definition nothing has read yet. An EUC-KR page put
   through a UTF-8 decoder comes out as a wall of replacement characters, and
   that wall is what then went into the model's prompt, into the citation
   panel, and into every export made from the answer.

   So the bytes are held and the label is worked out first. */

/** A charset label from `Content-Type`, if the server gave one. */
export const charsetFromType = (type) => {
  const match = /charset\s*=\s*"?([\w:.+-]+)"?/i.exec(String(type || ''));
  return match ? match[1].toLowerCase() : '';
};

/**
 * A charset label from the document itself.
 *
 * Only the head is looked at, and only as Latin-1: the declaration is ASCII in
 * every encoding this can help with, and decoding the whole document to find
 * out how to decode the document is the circle being broken here.
 */
export const charsetFromDocument = (bytes) => {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 4096))
    .toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([\w:.+-]+)/i.exec(head)
    // `<?xml version="1.0" encoding="EUC-KR"?>` — RSS feeds still do this.
    || /<\?xml[^>]+encoding\s*=\s*["']([\w:.+-]+)["']/i.exec(head);
  return meta ? meta[1].toLowerCase() : '';
};

/** Byte-order marks, which outrank every label because they are unambiguous. */
export const charsetFromBom = (bytes) => {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return '';
};

/* Labels that mean "UTF-8, but the page is lying about it" often enough to be
 * worth checking. A page declaring EUC-KR while actually serving UTF-8 is
 * common enough that trusting the label blindly is its own source of mojibake,
 * so a declared legacy encoding is only used when the bytes are *not* valid
 * UTF-8 — valid UTF-8 of any length is essentially never valid text in one of
 * these by accident. */
export const LEGACY = /^(euc-kr|ks_c_5601|ksc5601|cp949|windows-949|gb2312|gbk|gb18030|big5|shift_jis|sjis|ms932|windows-31j|euc-jp|iso-8859-\d+|windows-125\d)$/;

export const isUtf8 = (bytes) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch (e) {
    return false;
  }
};

export const decodeBytes = (bytes, label) => {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch (e) {
    // An encoding this build of Node has no table for. UTF-8 is a better
    // wrong answer than throwing away the page.
    return new TextDecoder('utf-8').decode(bytes);
  }
};

/**
 * One response, as text, in its own encoding.
 *
 * Returns the label it settled on as well, because "which encoding did you
 * decide this was" is the first question asked when a page still comes out
 * wrong, and having to guess it from the outside is how this went unnoticed.
 */
export const readAsText = async (response) => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const declared = charsetFromBom(bytes)
    || charsetFromType(response.headers.get('content-type'))
    || charsetFromDocument(bytes);

  // No claim at all: UTF-8 if it decodes as UTF-8, and otherwise the encoding
  // HTML itself falls back to, which keeps western text readable instead of
  // turning every accented letter into a diamond.
  if (!declared) {
    const label = isUtf8(bytes) ? 'utf-8' : 'windows-1252';
    return { text: decodeBytes(bytes, label), charset: label };
  }

  if (LEGACY.test(declared) && isUtf8(bytes)) {
    return { text: decodeBytes(bytes, 'utf-8'), charset: 'utf-8' };
  }
  return { text: decodeBytes(bytes, declared), charset: declared };
};

/** The common case: just the text. */
export const textOf = async (response) => (await readAsText(response)).text;

/* ---- Getting a page at all ---- */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const fetchWithTimeout = async (url, ms = 15000, headers = {}, init = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      ...init,
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9', ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
};

/*  Half the "could not read" lines in a research run were not network errors.
   They were 403s and 418s: a site looking at the request, seeing two headers
   where a browser sends fifteen, and refusing. A teapot is not a real status
   code — it is a site saying "you are a script" in the rudest way available.

   So a page request now looks like a page request. The ones that still refuse
   get one more try with a deliberately minimal header set, because a second
   population of servers rejects the *browser* fingerprint instead. Between
   them these two shapes get most of the open web. */

export const PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8,ja;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/** Statuses that mean "we decided you are a robot" rather than "no such page". */
export const BOT_BLOCK = new Set([401, 403, 405, 406, 418, 429, 503]);

export const blockReason = (status) => {
  if (BOT_BLOCK.has(status)) {
    return `The site refused the request (HTTP ${status}) — it blocks automated readers.`;
  }
  if (status === 404 || status === 410) return `That page is gone (HTTP ${status}).`;
  return `HTTP ${status}`;
};

export const fetchPageResponse = async (url, ms = 15000) => {
  const first = await fetchWithTimeout(url, ms, PAGE_HEADERS);
  if (first.ok || !BOT_BLOCK.has(first.status)) return first;

  // Drain it, so the refusal does not sit holding a socket open.
  await first.arrayBuffer().catch(() => {});
  try {
    return await fetchWithTimeout(url, ms, {
      Accept: 'text/html,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; ollama-webui research reader)',
    });
  } catch (e) {
    return first;
  }
};

/**
 * The part of a page that is the page.
 *
 * A research run that reads the whole of an HTML document reads the navigation,
 * the cookie banner, the newsletter box and the footer, and then hands four
 * thousand characters of that to a model as evidence — with the article itself
 * cut off somewhere in the middle by the budget. Preferring the element the
 * document says is its content is a few lines and buys most of what a real
 * readability pass would.
 */
export const ARTICLE = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/gi;

export const mainContent = (html) => {
  let best = '';
  for (const match of String(html).matchAll(ARTICLE)) {
    if (match[2].length > best.length) best = match[2];
  }
  // Only when it is substantial. A `<main>` wrapping a single-page app shell is
  // shorter than the boilerplate around it and worth ignoring.
  return best.length > 500 ? best : html;
};

/* ---- Which web the query is asking about ----

   A search engine reached from a Korean address answers as though the reader is
   in Korea, whatever the query says. That is right for "서울 날씨" and wrong for
   "modern responsive landing page code example", which came back as a Korean
   furniture shop, an English-Korean dictionary entry for the word "modern", and
   a Chinese Q&A site — three pages that share a word with the query and nothing
   else. A run built on those cannot produce an answer, and the model correctly
   said so after spending ninety seconds finding out.

   The script the query is written in is the best available signal for which
   index it wants, so it is what picks the market. */

/* Kana before Han, because kana is the only thing that separates Japanese from
 * Chinese here. A query written entirely in kanji -- `東京 天気` -- is read as
 * Chinese, and there is no honest way around that short of a dictionary: the
 * characters are shared. It costs little, because a real Japanese search query
 * almost always carries a particle or an okurigana, and the fallback index
 * still contains the pages. */
export const scriptOf = (query) => {
  if (/[가-힯ᄀ-ᇿ]/.test(query)) return 'ko';
  if (/[぀-ヿ]/.test(query)) return 'ja';
  if (/[一-鿿]/.test(query)) return 'zh';
  if (/[Ѐ-ӿ]/.test(query)) return 'ru';
  if (/[؀-ۿ]/.test(query)) return 'ar';
  return 'en';
};

export const MARKETS = {
  en: { mkt: 'en-US', setlang: 'en', cc: 'US', ddg: 'us-en' },
  ko: { mkt: 'ko-KR', setlang: 'ko', cc: 'KR', ddg: 'kr-kr' },
  ja: { mkt: 'ja-JP', setlang: 'ja', cc: 'JP', ddg: 'jp-jp' },
  zh: { mkt: 'zh-CN', setlang: 'zh-hans', cc: 'CN', ddg: 'cn-zh' },
  ru: { mkt: 'ru-RU', setlang: 'ru', cc: 'RU', ddg: 'ru-ru' },
  ar: { mkt: 'en-US', setlang: 'en', cc: 'US', ddg: 'wt-wt' },
};

export const marketFor = (query) => MARKETS[scriptOf(query)] || MARKETS.en;

/* ---- Whether a result is about the question ----

   Every engine answers *something*. Wikipedia's habit of returning
   "Mesoamerican ballgame" for "ollama keep_alive" was caught long ago and
   filtered; the same thing happens on every other provider and was not. A
   result that shares no word with the query is not a weak source, it is a
   different subject, and the only thing it can do downstream is push a real
   source out of the budget. */

export const CJK = /[぀-ヿ一-鿿가-힯]/;

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'how', 'why', 'best', 'top', 'vs', 'a', 'an',
  'is', 'are', 'to', 'of', 'in', 'on', 'or', 'my', 'your', 'this', 'that', 'it',
]);

/** The words worth matching on. CJK has no spaces, so it is matched in pairs. */
export const termsOf = (query) => {
  const text = String(query).toLowerCase();
  const words = text.split(/[^\p{L}\p{N}#+.]+/u).filter(w => w.length >= 2 && !STOPWORDS.has(w));
  if (!CJK.test(text)) return words;
  // Bigrams over the CJK runs: a two-character run is a word far more often
  // than a single character is, and single characters match everything.
  const grams = [];
  for (const run of text.match(/[぀-ヿ一-鿿가-힯]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return [...new Set([...words, ...grams])];
};

/**
 * Drop the results that are not about the query, and put the best first.
 *
 * Deliberately not strict. If filtering would leave nothing, the unfiltered
 * list is returned instead: a weak source is worse than a good one and much
 * better than an empty run, and the report says which sources it used either
 * way. The score is how many distinct query terms the result mentions, so a
 * page matching three of them outranks one matching the same word twice.
 */
export const rankByRelevance = (query, results) => {
  const terms = termsOf(query);
  if (terms.length === 0) return results;

  const scored = results.map((result, order) => {
    const haystack = `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
    const hits = terms.filter(term => haystack.includes(term)).length;
    return { result, hits, order };
  });

  const onTopic = scored.filter(s => s.hits > 0);
  // One match out of eight terms is a coincidence, not a subject. Require a
  // little more once the query is specific enough for that to mean something.
  const floor = terms.length >= 5 ? 2 : 1;
  const strong = onTopic.filter(s => s.hits >= floor);
  const kept = strong.length >= 2 ? strong : (onTopic.length ? onTopic : scored);

  return kept
    // Ties keep the engine's own order, which encodes more than term overlap.
    .sort((a, b) => (b.hits - a.hits) || (a.order - b.order))
    .map(s => s.result);
};
