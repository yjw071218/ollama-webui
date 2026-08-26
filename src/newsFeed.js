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
