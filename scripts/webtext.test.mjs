// Reading the web, as text.
//
// Two bugs met here and produced the same symptom from opposite directions.
//
// A page was always decoded as UTF-8, because `response.text()` does that
// whenever the server did not say otherwise in a header — and a great deal of
// the Korean, Japanese and Chinese web says otherwise in a `<meta charset>`
// tag inside the bytes, which by definition nothing has read yet. An EUC-KR
// page put through a UTF-8 decoder is a wall of replacement characters, and
// that wall went into the model's prompt, into the citation panel, and into
// every export made from the answer.
//
// And a search was always answered from whichever index the *server's* address
// suggested, with no check that the results had anything to do with the query.
// "modern responsive landing page code example", asked from Korea, came back as
// a furniture shop, a dictionary entry for the word "modern", and a Chinese Q&A
// site. Twenty sources, six readable, and a report that correctly reported it
// could not answer from any of them.
//
// Both are pure functions now, which is the point of this file.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const bundle = await rolldown({ input: path.resolve(ROOT, 'server/webText.js'), platform: 'node' });
const out = path.resolve(ROOT, 'node_modules/.webtext-test-bundle.mjs');
await bundle.write({ file: out, format: 'esm' });
await bundle.close();
const W = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* A stand-in for a fetch Response: the two things `readAsText` asks of one. */
const response = (bytes, contentType = '') => ({
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const utf8 = (text) => new TextEncoder().encode(text);
const encode = (label, text) => {
  // Node has the decoders but not the encoders, so legacy bytes are written by
  // hand from the one table this needs: EUC-KR for 한국어.
  const table = { '한': [0xc7, 0xd1], '국': [0xb1, 0xb9], '어': [0xbe, 0xee] };
  const bytes = [];
  for (const ch of text) {
    if (table[ch]) bytes.push(...table[ch]);
    else bytes.push(ch.charCodeAt(0));
  }
  return new Uint8Array(bytes);
};

/* --------------------------------------------------- which encoding is it */

const KOREAN = '한국어';

// The header wins when there is one. This is the easy case and it already
// worked; it is here so the harder ones below have something to differ from.
eq('a charset in the header is used',
  (await W.readAsText(response(encode('euc-kr', KOREAN), 'text/html; charset=euc-kr'))).text,
  KOREAN);

// The case that was broken. No header, the declaration is inside the document,
// and the document cannot be read until it is known.
const metaPage = new Uint8Array([
  ...utf8('<html><head><meta charset="euc-kr"></head><body>'),
  ...encode('euc-kr', KOREAN),
  ...utf8('</body></html>'),
]);
check('a charset declared only in the document is found',
  (await W.readAsText(response(metaPage, 'text/html'))).text.includes(KOREAN),
  (await W.readAsText(response(metaPage, 'text/html'))).text.slice(0, 80));

// RSS still does this, and the news feed goes through the same reader.
const xmlFeed = new Uint8Array([
  ...utf8('<?xml version="1.0" encoding="EUC-KR"?><rss><title>'),
  ...encode('euc-kr', KOREAN),
  ...utf8('</title></rss>'),
]);
check('and an XML declaration counts as one',
  (await W.readAsText(response(xmlFeed))).text.includes(KOREAN));

// A BOM is unambiguous, so it outranks a header that disagrees with it.
const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(KOREAN)]);
eq('a byte-order mark beats a header that contradicts it',
  (await W.readAsText(response(bom, 'text/html; charset=euc-kr'))).charset, 'utf-8');

// The other half of the mojibake problem: pages that declare a legacy encoding
// and then serve UTF-8 anyway. Trusting the label blindly is its own bug, so a
// legacy label is only believed when the bytes are not valid UTF-8.
eq('a page that declares EUC-KR but serves UTF-8 is read as UTF-8',
  (await W.readAsText(response(utf8(KOREAN), 'text/html; charset=euc-kr'))).text, KOREAN);

// Nothing said, and the bytes are valid UTF-8: that is what they are.
eq('an undeclared UTF-8 page is read as UTF-8',
  (await W.readAsText(response(utf8('café ' + KOREAN)))).text, 'café ' + KOREAN);
// Nothing said and the bytes are not UTF-8: HTML's own fallback, which keeps
// western text readable instead of turning it into diamonds.
eq('and an undeclared non-UTF-8 page falls back the way HTML does',
  (await W.readAsText(response(new Uint8Array([0x63, 0x61, 0x66, 0xe9])))).charset, 'windows-1252');
eq('which reads it correctly',
  (await W.readAsText(response(new Uint8Array([0x63, 0x61, 0x66, 0xe9])))).text, 'café');

// An encoding this build has no table for must not lose the page.
eq('an encoding nothing knows about still yields text',
  typeof (await W.readAsText(response(utf8('hello'), 'text/html; charset=x-nonsense-9'))).text,
  'string');

/* ------------------------------------------------------ text out of markup */

eq('tags come out', W.htmlToText('<p>hello <b>there</b></p>'), 'hello there');
eq('and scripts take their contents with them',
  W.htmlToText('<p>a</p><script>var x = "b";</script><p>c</p>'), 'a\nc');
eq('entities are decoded', W.htmlToText('<p>a &amp; b &#54620;</p>'), 'a & b 한');

// A run that reads a whole document reads the navigation, the cookie banner and
// the footer, and then the budget cuts the article off in the middle.
const page = `<html><body><nav>Home About Contact</nav>
  <article>${'The actual thing being researched. '.repeat(30)}</article>
  <footer>Newsletter signup</footer></body></html>`;
const main = W.mainContent(page);
check('the article is preferred over the page around it', !main.includes('Newsletter signup'), main.slice(0, 60));
check('and it is the article that survives', main.includes('actual thing being researched'));
// A `<main>` wrapping a single-page app shell is shorter than the boilerplate
// around it and worth ignoring.
const shell = '<html><body><nav>lots and lots of navigation</nav><main><div id="root"></div></main></body></html>';
eq('but a nearly-empty one is ignored', W.mainContent(shell), shell);

/* ------------------------------------------- which web the query is asking about */

eq('an English query wants the English index', W.marketFor('ollama keep_alive setting').mkt, 'en-US');
eq('a Korean one wants the Korean index', W.marketFor('서울 날씨 오늘').mkt, 'ko-KR');
eq('Japanese, which kana is what identifies', W.marketFor('東京の天気').mkt, 'ja-JP');
// Kanji are shared, so a query written entirely in them is genuinely ambiguous
// and falls to Chinese. Recorded rather than fixed: separating the two would
// take a dictionary, and a real Japanese query carries a particle.
eq('an all-kanji query is not distinguishable and falls to Chinese',
  W.marketFor('東京 天気').mkt, 'zh-CN');
// The script decides, not the address the server happens to run from. This is
// the whole of "an English query typed in Korea came back in Korean".
eq('and a Latin query is not made Korean by where it was typed',
  W.marketFor('modern responsive landing page code example').setlang, 'en');

/* ------------------------------------- whether a result is about the question */

const r = (title, snippet = '', url = 'https://example.com/') => ({ title, snippet, url });

const junk = W.rankByRelevance('modern responsive landing page code example', [
  r('모던하우스 공식몰', '가구와 생활용품', 'https://mhmall.co.kr'),
  r('modern - WordReference 영-한 사전', 'modern 뜻', 'https://wordreference.com/modern'),
  r('Responsive landing page template with code', 'A full HTML and CSS example', 'https://x.dev/landing'),
  r('Build a responsive landing page', 'Grid and flexbox code walkthrough', 'https://y.dev/page'),
]);
check('the two pages about the question are kept', junk.length === 2, JSON.stringify(junk.map(x => x.title)));
check('and the furniture shop is not', !junk.some(x => x.url.includes('mhmall')));
check('nor is the dictionary entry for one of the words',
  !junk.some(x => x.url.includes('wordreference')));

// The better match leads, so the read budget is spent on it first.
const ranked = W.rankByRelevance('ollama keep_alive gpu memory', [
  r('Ollama FAQ', 'How do I keep a model loaded in memory?', 'https://a/'),
  r('Ollama keep_alive and GPU memory', 'Setting keep_alive to control GPU memory', 'https://b/'),
]);
eq('the closer match comes first', ranked[0].url, 'https://b/');

// Deliberately not strict. A weak source is worse than a good one and much
// better than an empty run, and the report says which sources it used anyway.
const nothingMatches = W.rankByRelevance('zzzz qqqq', [r('Something else', 'entirely')]);
eq('a filter that would empty the list returns the list', nothingMatches.length, 1);
// A query with no words to match on cannot filter anything.
eq('and a query of nothing but stopwords filters nothing',
  W.rankByRelevance('the and of', [r('a'), r('b')]).length, 2);

// CJK has no spaces, so matching on whole words matches nothing at all.
const korean = W.rankByRelevance('올라마 모델 메모리 설정', [
  r('올라마 모델 메모리 설정 방법', '메모리를 조절하는 법'),
  r('오늘의 날씨', '전국이 맑겠습니다'),
]);
eq('a Korean query still tells its subject from another one', korean.length, 1);
check('and it keeps the right one', korean[0].title.includes('올라마'));

/* --------------------------------------------- why a page could not be read */

// "HTTP 418" is a site calling the reader a robot in the rudest way available.
// Saying so is the difference between a run that looks broken and one that
// looks blocked.
check('a teapot is reported as a refusal', /refused/i.test(W.blockReason(418)));
check('so is a 403', /refused/i.test(W.blockReason(403)));
check('a 404 is reported as a missing page', /gone/i.test(W.blockReason(404)));
check('and anything else is reported plainly', W.blockReason(500) === 'HTTP 500');
check('a refusal is retried, a missing page is not',
  W.BOT_BLOCK.has(418) && W.BOT_BLOCK.has(403) && !W.BOT_BLOCK.has(404));

// A page request has to look like a page request, or a large part of the web
// declines to answer it at all.
check('page requests carry a browser\'s headers', Object.keys(W.PAGE_HEADERS).length >= 6);
check('including the ones a fetch does not send by itself',
  'Sec-Fetch-Mode' in W.PAGE_HEADERS && 'Upgrade-Insecure-Requests' in W.PAGE_HEADERS);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
