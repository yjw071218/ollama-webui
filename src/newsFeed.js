// Scraping a search engine for "today's news" returns portal front pages —
// naver.com, yna.co.kr — whose snippets describe the site rather than any story.
// The model then correctly reports that it has nothing to summarise.
//
// Google News publishes an RSS feed of actual headlines with sources and
// timestamps, in the reader's language, without an API key. That is what a
// question about today's news actually needs.

const entities = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
};

export const decodeEntities = (text) =>
  String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => entities[m.toLowerCase()] ?? m);

// Only real HTML elements. A headline like `삼성 <가속> 발표` is text, and a
// blanket /<[^>]*>/ would silently delete the part inside the brackets.
const HTML_TAGS = 'a|b|br|div|em|font|i|img|li|ol|p|span|strong|table|td|tr|u|ul';
const stripTags = (html) =>
  String(html || '').replace(new RegExp(`</?(?:${HTML_TAGS})(?:\\s[^>]*)?/?>`, 'gi'), ' ');

const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

const tagValue = (item, tag) => {
  const match = item.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  if (!match) return '';
  // Google wraps anything containing markup characters in CDATA.
  const cdata = match[1].match(CDATA);
  const inner = cdata ? cdata[1] : match[1];
  return decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
};

// Google appends the publisher to every headline, sometimes twice, and the
// <source> element already carries it. Once is enough.
export const stripSourceSuffix = (title, source) => {
  let out = String(title || '').trim();
  if (!source) return out;
  const suffix = ` - ${source}`;
  while (out.toLowerCase().endsWith(suffix.toLowerCase())) {
    out = out.slice(0, -suffix.length).trim();
  }
  return out || String(title || '').trim();
};

// The feed's top-stories items carry a bundle of related links in <description>;
// a search item carries a one-line snippet. Both reduce to plain text usefully.
export const parseNewsFeed = (xml, limit = 8) => {
  const items = String(xml || '').match(/<item>[\s\S]*?<\/item>/gi) || [];
  const out = [];

  for (const item of items) {
    const title = tagValue(item, 'title');
    if (!title) continue;

    const sourceMatch = item.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = sourceMatch ? decodeEntities(stripTags(sourceMatch[1])).trim().slice(0, 80) : '';
    const published = tagValue(item, 'pubDate');

    out.push({
      title: stripSourceSuffix(title, source).slice(0, 300),
      url: tagValue(item, 'link').slice(0, 500),
      source,
      published,
      publishedAt: published ? Date.parse(published) || null : null,
    });

    if (out.length >= limit) break;
  }

  return out;
};

// Google News wants a language, a country and a "ceid" that repeats both.
const LOCALES = {
  ko: ['ko', 'KR'], ja: ['ja', 'JP'], 'zh-Hans': ['zh-CN', 'CN'], 'zh-Hant': ['zh-TW', 'TW'],
  es: ['es', 'ES'], fr: ['fr', 'FR'], de: ['de', 'DE'], pt: ['pt-BR', 'BR'],
  ru: ['ru', 'RU'], vi: ['vi', 'VN'], ar: ['ar', 'EG'], en: ['en-US', 'US'],
};

export const newsFeedUrl = (query, uiLanguage = 'en') => {
  const [hl, gl] = LOCALES[uiLanguage] || LOCALES.en;
  const params = `hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split('-')[0]}`;
  const term = String(query || '').trim();
  return term
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&${params}`
    : `https://news.google.com/rss?${params}`;
};

// "What is in the news" is a different question from "search the web for X", and
// only the first one wants a headline feed.
const HEADLINE_CUES = [
  /\bnews\b/i, /\bheadlines?\b/i, /\bbreaking\b/i, /\btop stor(y|ies)\b/i, /\bcurrent events\b/i,
  /뉴스/, /헤드라인/, /속보/, /주요\s*소식/, /시사/,
  /ニュース/, /見出し/, /速報/,
  /新闻/, /新聞/, /头条/, /頭條/, /快讯/,
  /noticias?/i, /titulares/i, /actualit[ée]s?/i, /schlagzeilen/i, /nachrichten/i,
  /новост/i, /tin\s*t[uứ]c/i, /أخبار/,
];

// "오늘 주요 뉴스내용들을 알려줘" searched literally matches articles *titled*
// "오늘의 주요 뉴스" from any date — which is how a question about today came
// back with stories from May. Strip the words that only say "this is a news
// question" and see whether an actual subject is left.
// CJK alternatives are ordered longest-first: a bare 今 would otherwise consume
// the 今 of 今天 and leave 天 behind looking like the subject.
const FILLER = [
  // Korean: time words, "main/important", the ask, and the particles left over
  /오늘|지금|요즘|최근|현재|주요|중요한?|무슨|무엇|뭐가?|어떤|내용들?|소식들?/g,
  /알려\s*줘요?|말해\s*줘요?|보여\s*줘요?|정리해?\s*줘요?|해\s*줘요?|줘요?/g,
  /(?<=[가-힣])[을를이가은는의도들]+(?=\s|$)/g,
  // English
  /\b(today'?s?|now|latest|current|main|top|important|recent|big|major)\b/gi,
  /\b(tell|show|give|summar\w*|what'?s?|whats|is|are|the|an?|me|about|please|any|in|of|on)\b/gi,
  // Japanese and Chinese together, so the ordering holds across both
  /今日|本日|今天|今朝|今|最新|主要|重要|教えて|ください|何が|何|現在|现在|告诉我|什么|有哪些|請問|请问|的/g,
  // Spanish / French / German / Portuguese / Russian / Vietnamese / Arabic
  /\b(hoy|ahora|principales?|dime|cu[aá]les?|de|del|la|las|el|los|sobre)\b/gi,
  /\b(aujourd'?hui|maintenant|principales?|dis-?moi|quelles?|de|du|des|les?|la|sur|jour|journ[eé]e)\b/gi,
  /\b(heute|jetzt|wichtigsten?|sag|welche)\b/gi,
  /\b(hoje|agora|principais?|diga|quais)\b/gi,
  /\b(сегодня|сейчас|главные|расскажи|какие)\b/gi,
  /\b(h[oô]m nay|b[aâ]y gi[oờ]|ch[ií]nh|cho t[oô]i bi[eế]t)\b/gi,
  /(اليوم|الآن|أهم|أخبرني)/g,
];

// What the question is actually about, or '' when it is just "what is the news".
export const newsTopic = (query) => {
  let text = ` ${String(query || '')} `;
  for (const cue of HEADLINE_CUES) {
    text = text.replace(new RegExp(cue.source, cue.flags.includes('i') ? 'gi' : 'g'), ' ');
  }
  for (const filler of FILLER) text = text.replace(filler, ' ');
  const words = text
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !/^[을를이가은는의에서도들좀및와과로]+$/.test(w));
  const residue = words.join(' ').trim();
  // A single leftover character is a fragment of a stripped word, not a topic.
  return residue.length >= 2 ? residue : '';
};

// Newest first. Google returns the top-stories feed in its own order and a
// search feed by relevance, neither of which is what "today" means.
export const sortByRecency = (items) =>
  [...(items || [])].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

export const withinHours = (items, hours, now = Date.now()) => {
  if (!hours) return items || [];
  const cutoff = now - hours * 3600_000;
  return (items || []).filter(i => !i.publishedAt || i.publishedAt >= cutoff);
};

export const looksLikeNewsQuery = (query) => {
  const text = String(query || '');
  if (!text.trim()) return false;
  return HEADLINE_CUES.some(cue => cue.test(text));
};

// What the model is shown. Timestamps matter as much as the headlines: they are
// what let it say how fresh this is instead of implying it is live.
export const formatNews = (items, { fetchedAt = Date.now() } = {}) => {
  if (!items || items.length === 0) return '';
  const stamp = new Date(fetchedAt).toISOString().slice(0, 16).replace('T', ' ');
  // Google News links are 400-character redirect blobs. They are kept on the
  // result objects for the UI to link from, but feeding them to the model would
  // spend most of the context window on opaque base64.
  const lines = items.map((item, i) => {
    const when = item.publishedAt
      ? new Date(item.publishedAt).toISOString().slice(0, 16).replace('T', ' ')
      : '';
    const meta = [item.source, when && `${when} UTC`].filter(Boolean).join(', ');
    return `${i + 1}. ${item.title}${meta ? ` — ${meta}` : ''}`;
  });
  return `Headlines from Google News, retrieved ${stamp} UTC:\n${lines.join('\n')}`;
};
