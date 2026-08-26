// Covers the Google News feed parser, the locale mapping and the detector that
// decides a question is about the news at all.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = await rolldown({
  input: path.resolve(HERE, '../src/newsFeed.js'),
  platform: 'neutral',
});
const file = path.resolve(HERE, '../node_modules/.news-test-bundle.mjs');
await bundle.write({ file, format: 'esm' });
await bundle.close();
const N = await import(pathToFileURL(file).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// A trimmed copy of the shape Google actually returns.
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>주요 뉴스 - Google 뉴스</title>
<item>
  <title>네팔 홍수 지역, 한국인 8명 연락두절 - 경향신문</title>
  <link>https://news.google.com/rss/articles/CBMiWkFV?oc=5</link>
  <pubDate>Wed, 26 Aug 2026 10:30:00 GMT</pubDate>
  <source url="https://www.khan.co.kr">경향신문</source>
</item>
<item>
  <title><![CDATA[삼성 &amp; SK, HBM 경쟁 <가속> - 머니투데이]]></title>
  <link>https://news.google.com/rss/articles/CBMibEFV?oc=5</link>
  <pubDate>Tue, 25 Aug 2026 19:00:00 GMT</pubDate>
  <source url="https://news.mt.co.kr">머니투데이</source>
</item>
<item>
  <title>제목만 있는 기사</title>
  <link>https://example.com/x</link>
</item>
</channel></rss>`;

const items = N.parseNewsFeed(FEED, 10);
eq('every item is parsed', items.length, 3);
eq('the headline comes through', items[0].title, '네팔 홍수 지역, 한국인 8명 연락두절');
eq('the publisher is separated out', items[0].source, '경향신문');
eq('the link survives', items[0].url, 'https://news.google.com/rss/articles/CBMiWkFV?oc=5');
eq('the date is parsed to a number', items[0].publishedAt, Date.UTC(2026, 7, 26, 10, 30));

eq('CDATA is unwrapped and entities decoded', items[1].title, '삼성 & SK, HBM 경쟁 <가속>');
eq('angle brackets in a headline are text, not markup',
  N.parseNewsFeed('<rss><item><title>주가 &lt;급등&gt; 전망</title></item></rss>', 1)[0].title,
  '주가 <급등> 전망');
eq('real html in a description is still stripped',
  N.parseNewsFeed('<rss><item><title>t</title><description><![CDATA[<a href="x">link</a> text]]></description></item></rss>', 1)[0].title,
  't');
eq('an item with no source still parses', items[2].source, '');
eq('and gets a null timestamp', items[2].publishedAt, null);

eq('the limit is honoured', N.parseNewsFeed(FEED, 2).length, 2);
eq('an empty feed yields nothing', N.parseNewsFeed('', 5).length, 0);
eq('junk yields nothing', N.parseNewsFeed('<html>not a feed</html>', 5).length, 0);
eq('a null feed yields nothing', N.parseNewsFeed(null, 5).length, 0);

// The publisher appears in the title and in <source>; showing it twice is noise.
eq('a duplicated publisher is trimmed', N.stripSourceSuffix('제목 - 경향신문', '경향신문'), '제목');
eq('a repeated one is trimmed too', N.stripSourceSuffix('제목 - 머니투데이 - 머니투데이', '머니투데이'), '제목');
eq('a different publisher is left alone', N.stripSourceSuffix('제목 - 한겨레', '경향신문'), '제목 - 한겨레');
eq('no source means no change', N.stripSourceSuffix('제목 - 한겨레', ''), '제목 - 한겨레');
eq('a title that is only the source survives', N.stripSourceSuffix('경향신문', '경향신문'), '경향신문');
eq('an em-dash in the headline is kept', N.stripSourceSuffix('A — B', '경향신문'), 'A — B');

// Entity decoding, since headlines are full of them.
eq('named entities', N.decodeEntities('a &amp; b &lt;c&gt;'), 'a & b <c>');
eq('numeric entities', N.decodeEntities('&#54620;&#44397;'), '한국');
eq('hex entities', N.decodeEntities('&#xD55C;'), '한');
eq('an unknown entity is left alone', N.decodeEntities('&nope;'), '&nope;');

// Locale mapping.
check('Korean gets the Korean edition', N.newsFeedUrl('', 'ko').includes('hl=ko&gl=KR&ceid=KR:ko'));
check('Japanese gets the Japanese edition', N.newsFeedUrl('', 'ja').includes('hl=ja&gl=JP'));
check('simplified and traditional differ', N.newsFeedUrl('', 'zh-Hans') !== N.newsFeedUrl('', 'zh-Hant'));
check('an unknown language falls back to English', N.newsFeedUrl('', 'xx').includes('hl=en-US'));
check('no topic means the top-stories feed', !N.newsFeedUrl('', 'ko').includes('/search'));
check('a topic means the search feed', N.newsFeedUrl('반도체', 'ko').includes('/rss/search?q='));
check('the topic is url-encoded', N.newsFeedUrl('삼성 전자', 'ko').includes('%20') || N.newsFeedUrl('삼성 전자', 'ko').includes('%EC'));

// The detector: news questions yes, everything else no.
for (const q of ['오늘 주요 뉴스내용들을 알려줘', '속보 있어?', "what's in the news today",
                 'top stories', '今日のニュース', '今天的新闻', 'noticias de hoy',
                 'actualités du jour', 'последние новости', 'tin tức hôm nay', 'أخبار اليوم']) {
  check(`news query: ${q}`, N.looksLikeNewsQuery(q));
}
for (const q of ['ollama keep_alive 설정법', 'how do I center a div', 'react useEffect cleanup',
                 '삼성전자 주가', '', '   ']) {
  check(`not a news query: ${JSON.stringify(q)}`, !N.looksLikeNewsQuery(q));
}

// Topic extraction. Searching the sentence itself is what returned May's
// stories for a question about today.
for (const [q, want] of [
  ['오늘 주요 뉴스내용들을 알려줘', ''],
  ['오늘 뉴스', ''],
  ['속보 알려줘', ''],
  ['top stories', ''],
  ["what's in the news today", ''],
  ['今日のニュース', ''],
  ['今天的新闻', ''],
  ['noticias de hoy', ''],
  ['actualites du jour', ''],
  ['오늘 삼성전자 뉴스 알려줘', '삼성전자'],
  ['반도체 뉴스', '반도체'],
  ['부동산 뉴스 알려줘', '부동산'],
  ['tell me the latest AI news', 'AI'],
  ['特斯拉 新闻', '特斯拉'],
]) {
  eq(`topic of ${JSON.stringify(q)}`, N.newsTopic(q), want);
}
check('a word containing a particle character survives', N.newsTopic('반도체 뉴스').includes('도'));
eq('a null query has no topic', N.newsTopic(null), '');

// Recency. Google returns top stories in its own order and searches by
// relevance; "today" means neither.
const mixed = [
  { title: 'old', publishedAt: Date.UTC(2026, 4, 5) },
  { title: 'newest', publishedAt: Date.UTC(2026, 7, 26, 12) },
  { title: 'yesterday', publishedAt: Date.UTC(2026, 7, 25, 12) },
  { title: 'undated', publishedAt: null },
];
eq('newest first', N.sortByRecency(mixed)[0].title, 'newest');
eq('sorting does not mutate', mixed[0].title, 'old');
const now = Date.UTC(2026, 7, 26, 14);
const fresh = N.withinHours(mixed, 48, now);
check('stale items are dropped', !fresh.some(i => i.title === 'old'));
check('recent items are kept', fresh.some(i => i.title === 'newest'));
check('an undated item is kept rather than guessed at', fresh.some(i => i.title === 'undated'));
eq('no window means no filtering', N.withinHours(mixed, 0, now).length, 4);

// What the model is shown.
const text = N.formatNews(items, { fetchedAt: Date.UTC(2026, 7, 26, 14, 0) });
check('it says where the headlines came from', /Google News/.test(text));
check('it stamps when they were fetched', text.includes('2026-08-26 14:00'));
check('it carries the headline', text.includes('네팔 홍수'));
check('it names the publisher', text.includes('경향신문'));
check('it dates each item', text.includes('2026-08-26 10:30 UTC'));
check('it leaves out the redirect blobs', !text.includes('news.google.com/rss/articles'));
eq('an empty list produces nothing', N.formatNews([]), '');
eq('a null list produces nothing', N.formatNews(null), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
