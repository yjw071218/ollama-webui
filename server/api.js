// The dev server and the production server expose the same API. It lives here
// so that neither owns it: vite.config.js mounts these on its middleware stack,
// and server/index.js dispatches to them directly.
//
// Handlers are (req, res) => void, connect style. Only the Kakao callback reads
// req.url, and only for query parameters, so mounting with or without the path
// stripped behaves identically.

import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import os from 'os';
import {
  parseNewsFeed, newsFeedUrl, looksLikeNewsQuery, newsTopic,
  sortByRecency, withinHours, formatNews,
} from '../src/newsFeed.js';
import {
  registerUser, verifyPassword, updateUser, changePassword, deleteAccount,
  findUser, countUsers, findOrCreateSocialUser,
  addCredential, findByCredentialId, touchCredential, listCredentials,
  credentialIds, removeCredential,
} from './accounts.js';
import {
  createSession, rotateSession, forkSession, readSession, destroySession,
  destroyUserSessions, listUserSessions, sessionIdOf, liveTokens, pickSession,
  sessionRequest, attachSessions, clearSessionCookies, csrfOk, isSecureRequest,
  throttleState, recordFailedLogin, clearFailedLogins, clientIp,
  MAX_SESSIONS, IDLE_TTL_MS,
} from './session.js';
import {
  issueChallenge, consumeChallenge, verifyRegistration, verifyAssertion,
  SUPPORTED_ALGORITHMS,
} from './webauthn.js';
import { verifyGoogleIdToken } from './social.js';
import { createGoogleHandoffs, nativeGooglePage } from './nativeGoogle.js';
import { googleNativeRedirect, nativeGoogleDirectPage, nativeGoogleCallbackPage, createRedirectProbe, GOOGLE_LOOPBACK_REDIRECT } from './nativeGoogleDirect.js';
import {
  changesSince, applyChanges, accountStats, sweepTombstones,
  OwnerMismatch, MAX_RECORD_BYTES, MAX_BATCH_RECORDS,
} from './records.js';
import { listRevisions, readRevision, recordsWithHistory } from './recordHistory.js';
import {
  createShare, readShare, listShares, revokeShare, revokeAllShares, MAX_SHARE_BYTES,
} from './shares.js';
import { addListener, publishRev, dropListeners } from './liveSync.js';
import { normaliseOrigin } from './origin.js';
import {
  fetchWithTimeout, fetchPageResponse, blockReason,
  htmlToText, decodeEntities, mainContent, readAsText, textOf,
  marketFor, rankByRelevance, relevantResults, parseNaverResults,
} from './webText.js';
import { createLlamaRoutes, backendOf, listModels as listLlamaModels } from './llamacpp.js';
import {
  browserSearchEnabled, searchGoogleInBrowser, readPageInBrowser, browserSearchStatus,
} from './browserSearch.js';
import { createSpeculativeRoutes } from './speculative.js';
import { createOpenAiRoutes } from './openaiCompat.js';
import { createApiKey, listApiKeys, revokeApiKey } from './apiKeys.js';
import {
  botUsername, makeLinkCode, linksOf as telegramLinksOf, unlink as telegramUnlink,
} from './telegram.js';
import { createStudioRoutes } from './studio.js';
import { commitStats } from './resourceSafety.js';
import { vramGuard } from './vram.js';
import { listSchedules, createSchedule, setScheduleEnabled, deleteSchedule } from './serverSchedules.js';
import { enginesFor, ENGINE_SPECS } from './engines.js';
import { createMusicRoutes } from './music.js';
import { createMcpRoutes } from './mcp.js';
import { createCliRoutes } from './cliModels.js';
import { readRequestBody } from './requestBody.js';
import { createRisuRoutes } from './risuai.js';
import { createRisuSyncHandler } from './risuSync.js';
import { scanFolder, readFileBytes } from './folderWatch.js';
import { readChatJob, replayChatJob, cancelChatJob, followChatJob, liveChatJobs } from './chatJobs.js';
import {
  pushPublicKey, rememberSubscription, forgetSubscription, lastFinished, subscriptionLabel, subscriptionLabels, labelFor,
} from './push.js';


// Previous CPU tick snapshot; usage is only meaningful as a delta.
let previousCpuSample = null;

// Turns off after the first failure so a machine without nvidia-smi does not
// pay for a process spawn on every poll.
let gpuProbeAvailable = true;

const NVIDIA_QUERY = [
  '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
  '--format=csv,noheader,nounits',
];

let gpuProbePending = null;
const readGpuStats = () => {
  if (!gpuProbePending) gpuProbePending = probeGpuStats().finally(() => { gpuProbePending = null; });
  return gpuProbePending;
};
const probeGpuStats = () => new Promise((resolve) => {
  if (!gpuProbeAvailable) return resolve([]);

  execFile('nvidia-smi', NVIDIA_QUERY, { timeout: 2500, windowsHide: true }, (err, stdout) => {
    if (err) {
      // ENOENT means no NVIDIA tooling; anything else is likely transient.
      if (err.code === 'ENOENT') gpuProbeAvailable = false;
      return resolve([]);
    }

    const gpus = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const [name, util, memUsed, memTotal, temp, power] = line.split(',').map(v => v.trim());
        const num = (v) => {
          const parsed = parseFloat(v);
          return Number.isFinite(parsed) ? parsed : null;
        };
        return {
          index,
          name,
          utilization: num(util),
          memoryUsed: num(memUsed) === null ? null : num(memUsed) * 1024 * 1024,
          memoryTotal: num(memTotal) === null ? null : num(memTotal) * 1024 * 1024,
          temperature: num(temp),
          power: num(power),
        };
      });

    resolve(gpus);
  });
});

/* ---- MCP web access ----
   These used to go through api.allorigins.win from the browser purely to dodge
   CORS. That proxy is a single point of failure — when it returns 5xx every web
   feature dies at once, which is exactly what happened. The dev server has no
   CORS restriction, so it does the fetching itself.

   Reading a page, deciding what encoding it is in, and deciding whether a
   result is about the question are all in `webText.js`: they are pure, they
   were all wrong in ways only a test would have caught, and nothing could
   reach them while they sat in the middle of this file. */

/* ---- Search providers ----
   Scraping a search engine is not a stable foundation: DuckDuckGo answers a
   challenge page (HTTP 202) after a handful of requests, public SearXNG
   instances return 403, and Mojeek's markup shifts. So the chain prefers a
   real API when the user has configured one, and treats scraping as a
   best-effort last resort with a cooldown after a block.

   Keys live in .env without a VITE_ prefix, so they stay on the server. */

// Per-provider cooldown after a refusal, so a blocked engine is not hammered.
const providerCooldown = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

const isCoolingDown = (name) => (providerCooldown.get(name) || 0) > Date.now();
const startCooldown = (name) => providerCooldown.set(name, Date.now() + COOLDOWN_MS);

const trimResult = (r) => ({
  title: String(r.title || '').slice(0, 200),
  url: String(r.url || '').slice(0, 500),
  snippet: String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 400),
});

const searchBrave = async (query, limit, key) => {
  const res = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
      + (isKorean(query) ? '&country=KR&search_lang=ko' : ''),
    15000,
    { 'X-Subscription-Token': key, Accept: 'application/json' }
  );
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, limit).map(r => trimResult({
    title: r.title, url: r.url, snippet: r.description,
  }));
};

/* A Korean query is asked of the Korean web: without it the APIs answer from
   their English-leaning default index, which is where Korean events and
   communities are thinnest. */
const isKorean = (query) => /[가-힣]/.test(query);

const searchTavily = async (query, limit, key) => {
  const res = await fetchWithTimeout('https://api.tavily.com/search', 20000, { 'Content-Type': 'application/json' }, {
    method: 'POST',
    body: JSON.stringify({
      api_key: key, query, max_results: limit, search_depth: 'basic',
      ...(isKorean(query) ? { country: 'south korea' } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, limit).map(r => trimResult({
    title: r.title, url: r.url, snippet: r.content,
  }));
};

const searchSerper = async (query, limit, key) => {
  const res = await fetchWithTimeout('https://google.serper.dev/search', 15000, {
    'X-API-KEY': key, 'Content-Type': 'application/json',
  }, { method: 'POST', body: JSON.stringify({ q: query, num: limit, ...(isKorean(query) ? { gl: 'kr', hl: 'ko' } : {}) }) });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, limit).map(r => trimResult({
    title: r.title, url: r.link, snippet: r.snippet,
  }));
};

/** Any SearXNG with the JSON format enabled — including a self-hosted one. */
const searchSearxng = async (query, limit, base) => {
  const url = `${base.replace(/\/$/, '')}/search?format=json&q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, 15000);
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('SearXNG did not return JSON (is the json format enabled?)'); }
  return (data.results || []).slice(0, limit).map(r => trimResult({
    title: r.title, url: r.url, snippet: r.content,
  }));
};

/**
 * Bing's HTML page. Currently the most reliable key-free source: it answers a
 * plain browser request where DuckDuckGo now returns a challenge, and it
 * handles non-English queries well.
 */
const unwrapBingUrl = (href) => {
  const raw = decodeEntities(href);
  // Every result is wrapped in https://www.bing.com/ck/a?...&u=a1<base64url>
  const match = raw.match(/[?&]u=a1([^&]+)/);
  if (!match) return raw;
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : raw;
  } catch (e) {
    return raw;
  }
};

const searchBing = async (query, limit) => {
  // The market is chosen by the query's script rather than by the address this
  // server happens to run from. Without it an English query typed in Korea is
  // answered from the Korean index, which is where the dictionary entries and
  // the furniture shop came from.
  const market = marketFor(query);
  const res = await fetchWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}`
      + `&mkt=${market.mkt}&setlang=${market.setlang}&cc=${market.cc}`,
    15000,
    {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': `${market.mkt},${market.setlang};q=0.9`,
    }
  );
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await textOf(res);
  if (/b_captcha|challenge-form/i.test(html)) throw new Error('Bing is challenging this address');

  const results = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const title = htmlToText(anchor[2]);
    if (!title) continue;

    const url = unwrapBingUrl(anchor[1]);
    const cite = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

    results.push(trimResult({
      title,
      url: /^https?:\/\//i.test(url) ? url : (cite ? htmlToText(cite[1]).split(' ')[0] : ''),
      snippet: snippet ? htmlToText(snippet[1]) : '',
    }));
  }

  if (results.length === 0) throw new Error('Bing returned no parsable results');
  return results;
};

/** Naver's search page: the key-free source that still answers Korean well. */
const searchNaver = async (query, limit) => {
  const res = await fetchWithTimeout(
    `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent(query)}`,
    15000,
    { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' }
  );
  if (res.status === 403 || res.status === 429) throw new Error(`Naver is rate-limiting this address (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`Naver HTTP ${res.status}`);
  const results = parseNaverResults(await textOf(res), limit).map(trimResult);
  if (results.length === 0) throw new Error('Naver returned no parsable results');
  return results;
};

/** Marginalia: a small open index with a public JSON API and no key. */
const searchMarginalia = async (query, limit) => {
  const res = await fetchWithTimeout(
    `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}`,
    15000,
    { Accept: 'application/json' }
  );
  if (!res.ok) throw new Error(`Marginalia HTTP ${res.status}`);
  const data = await res.json();
  const hits = (data.results || []).slice(0, limit).map(r => trimResult({
    title: r.title, url: r.url, snippet: r.description,
  }));
  if (hits.length === 0) throw new Error('Marginalia returned no results');
  return hits;
};

/** Best-effort scrape. DuckDuckGo blocks quickly, hence the challenge check. */
const searchDuckDuckGo = async (query, limit) => {
  const market = marketFor(query);
  const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', 15000, {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, { method: 'POST', body: new URLSearchParams({ q: query, kl: market.ddg }).toString() });

  const html = await textOf(res);
  // 202 plus an "anomaly" page is DuckDuckGo's rate-limit response.
  if (res.status === 202 || /anomaly-modal|challenge|captcha/i.test(html)) {
    throw new Error('DuckDuckGo is rate-limiting this address');
  }
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);

  const results = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const titleMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const hrefMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/i);

    let link = hrefMatch ? decodeEntities(hrefMatch[1]) : '';
    const wrapped = link.match(/[?&]uddg=([^&]+)/);
    if (wrapped) link = decodeURIComponent(wrapped[1]);

    results.push(trimResult({
      title: htmlToText(titleMatch[1]),
      url: link,
      snippet: snippetMatch ? htmlToText(snippetMatch[1]) : '',
    }));
  }
  if (results.length === 0) throw new Error('DuckDuckGo returned no parsable results');
  return results;
};

/** Narrow, but it never blocks — worth having as the final fallback. */
const searchWikipedia = async (query, limit) => {
  const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*'
    + `&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, 12000);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  const hits = (data.query?.search || []).slice(0, limit).map(r => trimResult({
    title: r.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: htmlToText(r.snippet || ''),
  }));

  // Wikipedia always answers with *something*: "ollama keep_alive" came back
  // as "Mesoamerican ballgame". Feeding that to the model is worse than
  // admitting the search failed, so require an actual term overlap.
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  if (terms.length === 0) return hits;

  return hits.filter(hit => {
    const haystack = `${hit.title} ${hit.snippet}`.toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
};

/**
 * Walks the chain until something returns results, and reports which
 * provider answered plus why the others did not.
 */
// Google News RSS. No key, real headlines with publishers and timestamps, in
// the reader's language — which is what a question about the news needs and what
// scraping a search engine conspicuously fails to give.
const searchGoogleNews = async (query, limit, uiLanguage) => {
  // Searching the sentence itself matches articles *titled* "today's main
  // news" from any date, which is how a question about today came back with
  // stories from three months ago. Only a real subject becomes a query.
  const topic = newsTopic(query);
  const res = await fetchWithTimeout(newsFeedUrl(topic, uiLanguage), 12000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let items = sortByRecency(parseNewsFeed(await textOf(res), limit * 3));
  // "What is the news" means today's; a subject search may legitimately turn up
  // the best coverage from a while back.
  if (!topic) items = withinHours(items, 48);
  items = items.slice(0, limit);

  return items.map(item => trimResult({
    title: item.title,
    url: item.url,
    snippet: [item.source, item.published].filter(Boolean).join(' · '),
  }));
};

const searchWeb = async (query, limit = 5, env = {}, uiLanguage = 'en') => {
  const chain = [];

  // A news question goes to a headline feed first. Every other query skips it,
  // because a feed is a poor answer to "how do I configure keep_alive".
  if (looksLikeNewsQuery(query)) {
    chain.push(['google-news', () => searchGoogleNews(query, limit, uiLanguage)]);
  }

  if (env.BRAVE_API_KEY) chain.push(['brave', () => searchBrave(query, limit, env.BRAVE_API_KEY)]);
  if (env.TAVILY_API_KEY) chain.push(['tavily', () => searchTavily(query, limit, env.TAVILY_API_KEY)]);
  if (env.SERPER_API_KEY) chain.push(['serper', () => searchSerper(query, limit, env.SERPER_API_KEY)]);
  if (env.SEARXNG_URL) chain.push(['searxng', () => searchSearxng(query, limit, env.SEARXNG_URL)]);

  // Key-free providers, best first. Bing's page now answers a script with
  // results about something else entirely -- "일러스타 페스 일정" came back as
  // Zhihu threads and a 1973 horror film -- so DuckDuckGo goes first; when it
  // rate-limits it cools down and Bing is still there behind it.
  // Google in Chrome, when switched on (server/browserSearch.js). It paces
  // itself; a search that is not its turn falls through to the next source.
  if (browserSearchEnabled(env)) chain.push(['google-browser', () => searchGoogleInBrowser(query, limit, env)]);

  // A Korean query goes to Naver first: it indexes Korean sites (blogs, cafes,
  // namu.wiki, DC) the others barely reach, and it answers a plain request.
  const korean = /[가-힣]/.test(query);
  if (korean) chain.push(['naver', () => searchNaver(query, limit)]);
  chain.push(['duckduckgo', () => searchDuckDuckGo(query, limit)]);
  if (!korean) chain.push(['naver', () => searchNaver(query, limit)]);
  chain.push(['bing', () => searchBing(query, limit)]);
  chain.push(['marginalia', () => searchMarginalia(query, limit)]);
  chain.push(['wikipedia', () => searchWikipedia(query, limit)]);

  const attempts = [];
  for (const [name, run] of chain) {
    if (isCoolingDown(name)) {
      attempts.push(`${name}: cooling down after a recent block`);
      continue;
    }
    try {
      const found = await run();
      /* Results none of which mention the query are not an answer from this
         provider, they are its failure: the next one is asked. Handing them on
         made the model apologise for a search about a festival that had
         returned a horror film. */
      if (found.length > 0 && relevantResults(query, found).length === 0) {
        attempts.push(`${name}: ${found.length} results, none about the query`);
        continue;
      }
      // Off-topic results are not weak evidence, they are a different subject,
      // and every one of them pushes a real source out of the read budget.
      const results = rankByRelevance(query, found).slice(0, limit);
      if (results.length > 0) {
        if (found.length > results.length) {
          attempts.push(`${name}: ${found.length} results, ${results.length} on topic`);
        }
        return { results, provider: name, attempts };
      }
      attempts.push(`${name}: no results`);
    } catch (e) {
      attempts.push(`${name}: ${e.message}`);
      if (/rate-limit|challeng|429|403|202/i.test(e.message)) startCooldown(name);
    }
  }

  return { results: [], provider: null, attempts };
};


/**
 * Every API route, in mount order.
 *
 * `options.allowLocalFs` gates the filesystem endpoints. They read and write
 * anywhere the server process can reach, which is exactly what you want from
 * localhost and never what you want from the open internet, so the production
 * server turns them off unless told otherwise.
 */
export const createApiRoutes = (env = {}, options = {}) => {
  const { allowLocalFs = true } = options;
  const routes = [...createRisuRoutes({ env })];
  const route = (routePath, handler) => routes.push({ path: routePath, handler });

  route('/api/chat/replay', (req, res) => {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const job = readChatJob(id);
    if (!job) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Chat generation not found' }));
      return;
    }
    const replayUrl = new URL(req.url, 'http://localhost');
    if (replayUrl.searchParams.get('follow') === '1') return followChatJob(req, res, job, replayUrl.searchParams.get('offset'));
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.end(replayChatJob(job));
  });

  /* An answer another of this reader's devices is writing, right now.
   *
   * The same gap `/studio/live` closes for pictures, for the words. A second
   * device does see the answer arrive -- the conversation is saved every few
   * hundred milliseconds and uploaded, so the phone gets it in chunks, a second
   * or two behind and in lumps. The live bytes were there all along:
   * `/api/chat/replay?follow=1` streams them to anyone, from any offset, and
   * reconnects mid-character. What the phone could not do was learn the id,
   * which lived only in the localStorage of the browser that started the turn.
   *
   * So it is asked for here, by conversation, for the account asking. The
   * answer is the id and nothing else; the bytes come from the route that
   * already served them. See `live` in server/chatJobs.js.
   *
   * `authenticate` is defined further down this function and read when the
   * request arrives, which is long after. */
  route('/api/chat/live', (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chat = url.searchParams.get('chat') || '';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');

    /* Asked about one id instead: "is the generation I wrote down still a
       generation?" A browser keeps the id of the turn it started so it can pick
       the answer up after a reload -- and an id this server has never heard of
       is one that finished for good, whatever that browser wrote down. Asked
       before the app takes the screen over for it; see the restore in App.jsx
       for the loop that came of not asking. */
    const id = url.searchParams.get('id') || '';
    if (id) {
      const job = readChatJob(id);
      return res.end(JSON.stringify({ success: true, running: !!job && !job.finished, known: !!job }));
    }

    if (!chat) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ success: false, error: 'A chat is required' }));
    }
    const [job = null] = liveChatJobs(authenticate(req).user?.id || '', chat);
    /* `now` is this server's clock: the follower times the answer from
       `job.startedAt` against it, not against its own, which may be off. */
    res.end(JSON.stringify({ success: true, job, now: Date.now() }));
  });

  route('/api/chat/cancel', (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let id = '';
      try { id = JSON.parse(body).id || ''; } catch (e) { /* invalid body */ }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: cancelChatJob(id) }));
    });
  });


    route('/localfs/read',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { targetPath } = JSON.parse(body);
          if (fs.existsSync(targetPath)) {
            const content = fs.readFileSync(targetPath, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, content }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ success: false, error: 'File not found' }));
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
    });

    route('/localfs/write',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { targetPath, content } = JSON.parse(body);
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, content, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
    });
    
    route('/localfs/list',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { targetPath } = JSON.parse(body);
          if (fs.existsSync(targetPath)) {
            const items = fs.readdirSync(targetPath);
            const detailedItems = items.map(item => {
              try {
                const stat = fs.statSync(path.join(targetPath, item));
                return stat.isDirectory() ? `[DIR]  ${item}/` : `[FILE] ${item}`;
              } catch(e) {
                return `[?] ${item}`;
              }
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, files: detailedItems }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ success: false, error: 'Directory not found' }));
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
    });

    /* ---- Watched folders ----
       The server lists a directory and hands over bytes; everything that turns
       a file into vectors stays in the browser, where it already lives. See
       server/folderWatch.js for why there is no file watcher here. */
    route('/localfs/scan',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        try {
          const { targetPath } = JSON.parse(body || '{}');
          if (!targetPath) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ success: false, error: 'A folder is required' }));
          }
          res.end(JSON.stringify({ success: true, ...scanFolder(targetPath) }));
        } catch (e) {
          res.statusCode = e.statusCode || 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
    });

    route('/localfs/bytes',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        try {
          const { targetPath } = JSON.parse(body || '{}');
          if (!targetPath) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ success: false, error: 'A file is required' }));
          }
          res.end(JSON.stringify({ success: true, ...readFileBytes(targetPath) }));
        } catch (e) {
          res.statusCode = e.statusCode || (e.code === 'ENOENT' ? 404 : 500);
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
    });

    route('/localfs/search',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          const { targetPath, query } = JSON.parse(body);
          if (fs.existsSync(targetPath)) {
            const results = [];
            const searchRecursive = (dir) => {
              if (results.length >= 30) return; // Limit results
              const items = fs.readdirSync(dir);
              for (const item of items) {
                if (results.length >= 30) break;
                if (item.startsWith('.') || item === 'node_modules') continue;
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                  searchRecursive(fullPath);
                } else if (stat.size < 1024 * 1024) { // < 1MB
                  const content = fs.readFileSync(fullPath, 'utf-8');
                  if (content.includes(query)) {
                    results.push(fullPath);
                  }
                }
              }
            };
            searchRecursive(targetPath);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, results }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ success: false, error: 'Directory not found' }));
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
    });

    // ---- MCP: fetch a page ----
    route('/mcp/fetch',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const json = (payload, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        try {
          const { url, limit } = JSON.parse(body || '{}');
          if (!url || !/^https?:\/\//i.test(url)) return json({ success: false, error: 'A http(s) URL is required' }, 400);

          const cap = Number(limit) > 0 ? Number(limit) : 8000;
          /* The page as Chrome renders it: for a site that refuses a plain
             request or sends a shell that JavaScript fills in. Only with
             WEB_SEARCH_BROWSER on; the plain read is always tried first. */
          const inBrowser = async () => {
            const page = await readPageInBrowser(url, env);
            const text = htmlToText(mainContent(page.html));
            return json({
              success: true, url: page.url, contentType: 'text/html', charset: 'utf-8', via: 'browser',
              truncated: text.length > cap, text: text.slice(0, cap),
            });
          };

          let response;
          try {
            response = await fetchPageResponse(url);
          } catch (e) {
            if (browserSearchEnabled(env)) return await inBrowser();
            throw e;
          }
          if (!response.ok) {
            if (browserSearchEnabled(env) && [401, 403, 429, 503].includes(response.status)) {
              try { return await inBrowser(); } catch { /* the refusal below says more */ }
            }
            return json({ success: false, status: response.status, error: blockReason(response.status) }, 400);
          }

          const type = response.headers.get('content-type') || '';
          // Not a document. A PDF or an image decoded as text is a megabyte of
          // noise, and a model handed noise treats it as evidence.
          if (type && !/text\/|html|xml|json|javascript/i.test(type)) {
            return json({ success: false, status: 415, error: `That link is ${type.split(';')[0]}, not a page.` }, 400);
          }

          const { text: raw, charset } = await readAsText(response);
          const isMarkup = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(raw);
          const text = isMarkup ? htmlToText(mainContent(raw)) : raw;
          // Next to nothing from a whole page is a page drawn by script.
          if (isMarkup && text.trim().length < 300 && browserSearchEnabled(env)) {
            try { return await inBrowser(); } catch { /* what little there was, below */ }
          }

          json({
            success: true,
            url: response.url || url,
            contentType: type,
            // Which encoding this was read as. The first question when a page
            // still comes out garbled, and it used to be unanswerable.
            charset,
            truncated: text.length > cap,
            text: text.slice(0, cap),
          });
        } catch (e) {
          json({ success: false, error: e.name === 'AbortError' ? 'The request timed out' : e.message }, 500);
        }
      });
    });

    // ---- MCP: web search ----
    /* ------------------------------------------------ accounts on the server

       Browser storage is per origin, so a device-local account cannot carry a
       history to a phone. These can: the server knows who signed in and hands
       the same records back to whatever device asks.

       Three things below are load-bearing and easy to get subtly wrong.

       A browser holds a *set* of sessions, not one, because two tabs can be
       two people. Anything that writes the cookie back writes the whole set —
       replacing it with just this tab's is exactly the bug where signing out
       of one tab signed out the rest.

       Signing in always issues a fresh session id, so a cookie planted before
       sign-in is worthless afterwards.

       And CSRF is checked on every write. 401 means "no session, show the
       sign-in screen"; 403 with `code: 'csrf'` means the session is fine but
       the request did not prove it came from this app, which is a bug or an
       attack and never something to retry quietly. */

    const readBody = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += chunk;
        if (body.length > limit) {
          reject(new Error('That request body is too large.'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });

    const sendJson = (res, payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(payload));
    };

    /** One shape for every failure, so the code reaches the UI to be translated. */
    const sendError = (res, e, status = 400) =>
      sendJson(res, { success: false, error: e.message, code: e.code || '' }, status);

    const jsonBody = async (req, limit = 64 * 1024) => {
      const raw = await readBody(req, limit);
      try {
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        throw new Error('That request body is not JSON.');
      }
    };

    /**
     * The session and the account behind this request, or nulls.
     *
     * `tokens` is every session the browser sent, not just the one in use. It
     * is carried through because anything that writes the cookie back has to
     * write the whole set.
     */
    const authenticate = (req) => {
      const { tokens, token, session } = pickSession(req);
      if (!session) return { tokens, token: '', session: null, user: null };
      const user = findUser(session.userId);
      // A session whose account was deleted is not a session.
      if (!user) { destroySession(token); return { tokens, token: '', session: null, user: null }; }
      return { tokens, token, session, user };
    };

    /** Everything a protected route needs, or a reply already sent. */
    const guard = (req, res, { methods = null } = {}) => {
      if (methods && !methods.includes(req.method)) {
        sendJson(res, { success: false, error: `${methods.join(' or ')} required.` }, 405);
        return null;
      }
      const auth = authenticate(req);
      if (!auth.user) {
        sendJson(res, { success: false, error: 'Not signed in.', code: 'unauthenticated' }, 401);
        return null;
      }
      if (!csrfOk(req, auth.session)) {
        sendJson(res, { success: false, error: 'That request could not be verified.', code: 'csrf' }, 403);
        return null;
      }
      return auth;
    };

    /** The account this request is acting as, or null. */
    const currentUser = (req) => authenticate(req).user;
    route('/api/risu/sync', createRisuSyncHandler({ guard }));

    /* Who the browser could switch to, so a tab can offer the choice.

       One entry per live *session*, not per account. Two tabs signed into
       the same account are two sessions, and a browser that has hit the
       cap has to report the cap -- otherwise there is no way to see from
       outside that old sessions are being retired. */
    const accountsOf = (tokens) => liveTokens(tokens).map((token) => {
      const session = readSession(token);
      const user = session && findUser(session.userId);
      return user ? { user, sessionId: sessionIdOf(session.key) } : null;
    }).filter(Boolean);

    /**
     * Sign in: always a fresh session id, never the one that arrived.
     *
     * What happens to the browser's other sessions depends on what this tab
     * already was. A tab that was signed in is signing in *again*, so its
     * session is replaced and the other tabs are untouched. A tab that was the
     * guest is adding an account, so a new session joins the set.
     */
    const startSession = (req, res, user, { attach = true } = {}) => {
      const auth = authenticate(req);
      const { tokens } = auth;
      // A tab that has not been given a session of its own yet has nothing to
      // replace; `authenticate` would hand it one belonging to another tab.
      const current = sessionRequest(req).fork ? '' : auth.token;
      const set = liveTokens(tokens);

      const meta = { userAgent: req.headers['user-agent'] || '', ip: clientIp(req) };
      let token;
      if (current) {
        token = rotateSession(current, { userId: user.id, ...meta });
        const at = set.indexOf(current);
        if (at === -1) set.push(token); else set[at] = token;
      } else {
        token = createSession(user.id, meta);
        set.push(token);
      }

      // The oldest goes if that would take the browser past the cap. Signing
      // out of a tab nobody is looking at is the least surprising thing to lose.
      while (set.length > MAX_SESSIONS) destroySession(set.shift());

      const session = readSession(token);
      if (attach) attachSessions(req, res, set, session?.csrf || '');
      return {
        tokens: set,
        token,
        sessionId: session ? sessionIdOf(session.key) : null,
        csrfToken: session?.csrf || null,
      };
    };

    route('/api/auth/session', (req, res) => {
      const auth = authenticate(req);
      const { tokens, user } = auth;
      let session = auth.session;

      // The one place the cookie is pruned. Expiry, a password change and a
      // "sign out other devices" all kill sessions without the browser ever
      // hearing, so the dead ids are dropped here -- where every tab arrives
      // at boot and after any identity change anywhere.
      const set = liveTokens(tokens);

      /* A tab with no session of its own is given one, forked from whoever is
         signed in on this browser. This is what makes two tabs two tabs.

         A GET that creates a row is not something to do lightly, so it is
         fenced: only a request that asks in the header, which is something only
         this origin's own script can set. A navigation, a crawler and a
         cross-site request all arrive without it and fork nothing. */
      if (sessionRequest(req).fork && session && user) {
        const forked = forkSession(auth.token, {
          userAgent: req.headers['user-agent'] || '',
          ip: clientIp(req),
        });
        if (forked) {
          set.push(forked);
          // Dropped from the server too: a session no browser can present is
          // one nobody can revoke.
          while (set.length > MAX_SESSIONS) destroySession(set.shift());
          session = readSession(forked);
        }
      }

      // Refreshed on every look, so an active browser's sessions slide forward
      // rather than expiring on a fixed date.
      attachSessions(req, res, set, session?.csrf || '');

      const who = session ? findUser(session.userId) : null;
      sendJson(res, {
        success: true,
        user: who || null,
        // Which of the browser's sessions answered. A tab pins itself to this
        // and sends it back, so it keeps its own identity no matter what the
        // other tabs do.
        sessionId: session ? sessionIdOf(session.key) : null,
        csrfToken: session?.csrf || null,
        state: who ? accountStats(who.id) : null,
        anyAccounts: who ? true : countUsers() > 0,
        accounts: accountsOf(set),
        session: session ? {
          createdAt: session.createdAt,
          expiresAt: Math.min(session.absoluteExpiresAt, session.lastSeenAt + IDLE_TTL_MS),
        } : null,
      });
    });

    route('/api/auth/register', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      try {
        const { name, email, password } = await jsonBody(req);
        const user = await registerUser({ name, email, password });
        const started = startSession(req, res, user);
        sendJson(res, {
          success: true, user, csrfToken: started.csrfToken,
          sessionId: started.sessionId, accounts: accountsOf(started.tokens),
          state: accountStats(user.id),
        });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/auth/login', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      try {
        const { email, password } = await jsonBody(req);
        const ip = clientIp(req);

        /* Guessing is slowed per address *and* per address-plus-account, so
           one account being hammered does not lock out everybody else behind
           the same NAT. */
        const throttle = throttleState(ip, email);
        if (throttle.blocked) {
          res.setHeader('Retry-After', String(Math.ceil(throttle.retryAfterMs / 1000)));
          return sendJson(res, {
            success: false,
            error: 'Too many attempts. Wait a minute and try again.',
            code: 'throttled',
            retryAfterMs: throttle.retryAfterMs,
          }, 429);
        }

        const user = await verifyPassword(email, password);
        if (!user) {
          recordFailedLogin(ip, email);
          // One message for a wrong password and an address nobody has
          // registered: telling them apart is an account-enumeration oracle.
          return sendJson(res, {
            success: false, error: 'That email and password do not match.', code: 'bad-credentials',
          }, 401);
        }

        clearFailedLogins(ip, email);
        const started = startSession(req, res, user);
        sendJson(res, {
          success: true, user, csrfToken: started.csrfToken,
          sessionId: started.sessionId, accounts: accountsOf(started.tokens),
          state: accountStats(user.id),
        });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/auth/logout', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      const auth = authenticate(req);
      // A tab that is already nobody can always sign out; only a real session
      // has to prove the request came from this app.
      if (auth.session && !csrfOk(req, auth.session)) {
        return sendJson(res, { success: false, error: 'That request could not be verified.', code: 'csrf' }, 403);
      }
      if (auth.token) destroySession(auth.token);

      // Only this tab's session goes. The others belong to other tabs.
      const set = liveTokens(auth.tokens).filter(t => t !== auth.token);
      if (set.length === 0) clearSessionCookies(req, res);
      else attachSessions(req, res, set, '');

      sendJson(res, { success: true, remaining: set.length, accounts: accountsOf(set) });
    });

    route('/api/auth/logout-others', (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      const ended = destroyUserSessions(auth.user.id, { keepToken: auth.token });
      const set = liveTokens(auth.tokens);
      attachSessions(req, res, set, auth.session.csrf || '');
      // Both spellings: the profile screen reads one and the tab tests the
      // other, and renaming either would be a silent break.
      sendJson(res, {
        success: true, ended, endedSessions: ended, accounts: accountsOf(set),
      });
    });

    route('/api/auth/sessions', (req, res) => {
      const auth = guard(req, res, { methods: ['GET'] });
      if (!auth) return;
      sendJson(res, { success: true, sessions: listUserSessions(auth.user.id, auth.token) });
    });

    route('/api/auth/profile', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        // An avatar is a data URI, which is why this is not the 64 KB default.
        const patch = await jsonBody(req, 2 * 1024 * 1024);
        sendJson(res, { success: true, user: await updateUser(auth.user.id, patch) });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/auth/password', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const { currentPassword, newPassword } = await jsonBody(req);
        await changePassword(auth.user.id, currentPassword, newPassword);
        /* Every other device is signed out. A password is changed because it
           might be known, and leaving the sessions it could have started alive
           makes the change theatre. */
        const ended = destroyUserSessions(auth.user.id, { keepToken: auth.token });
        attachSessions(req, res, liveTokens(auth.tokens), auth.session.csrf || '');
        sendJson(res, { success: true, endedSessions: ended });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/auth/account', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST', 'DELETE'] });
      if (!auth) return;
      deleteAccount(auth.user.id);
      // The foreign keys take the records, sessions and credentials with it.
      const set = liveTokens(auth.tokens);
      if (set.length === 0) clearSessionCookies(req, res);
      else attachSessions(req, res, set, '');
      sendJson(res, { success: true, accounts: accountsOf(set) });
    });

    /* Signing in with Google is already proof of who you are, so it is also the
       server account. Otherwise there are two notions of "your account" and
       only the obscure one makes a history follow you anywhere. */
    const googleHandoffs = createGoogleHandoffs();
    route('/api/auth/native/google/callback', (req, res) => {
      if (req.method !== 'GET') return sendJson(res, { error: 'GET required.' }, 405);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.end(nativeGoogleCallbackPage());
    });
    /* Whether the apps may open Google's account chooser directly, through
       their loopback listener (nativeGoogleDirect.js). No means the page below. */
    const googleRedirectProbe = createRedirectProbe();
    route('/api/auth/native/google/ready', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') return sendJson(res, { error: 'GET required.' }, 405);
      const clientId = env.VITE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
      if (!clientId) return sendJson(res, { direct: false, reason: 'not-configured' });
      const direct = await googleRedirectProbe(clientId, GOOGLE_LOOPBACK_REDIRECT);
      sendJson(res, { direct, redirectUri: GOOGLE_LOOPBACK_REDIRECT, ...(direct ? {} : { reason: 'redirect-not-registered' }) });
    });
    route('/api/auth/native/page', (req, res) => {
      if (req.method !== 'GET') return sendJson(res, { error: 'GET required.' }, 405);
      const clientId = env.VITE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
      if (!clientId) return sendJson(res, { error: 'Google login is not configured.' }, 501);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      // GIS needs the origin as referrer; never expose paths or the handoff fragment.
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
      res.setHeader('X-Frame-Options', 'DENY');
      try {
        const redirectUri = googleNativeRedirect(env);
        res.end(redirectUri ? nativeGoogleDirectPage(clientId, redirectUri) : nativeGooglePage(clientId));
      } catch (error) { sendError(res, error, 503); }
    });
    for (const action of ['start', 'finish', 'poll']) route('/api/auth/native/' + action, async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') return sendJson(res, { error: 'POST required.' }, 405);
      if (!String(req.headers['content-type'] || '').startsWith('application/json'))
        return sendJson(res, { error: 'JSON required.' }, 415);
      try {
        const clientId = env.VITE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
        if (!clientId) return sendJson(res, { error: 'Google login is not configured.' }, 501);
        const body = await jsonBody(req);
        if (action === 'start') return sendJson(res, googleHandoffs.start());
        if (action === 'poll') return sendJson(res, googleHandoffs.poll(body.id, body.secret));
        await googleHandoffs.finish(body.id, body.credential,
          (credential, nonce) => verifyGoogleIdToken(credential, clientId, nonce));
        sendJson(res, { success: true });
      } catch (error) { sendError(res, error, 400); }
    });

    route('/api/auth/google', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      try {
        const { credential } = await jsonBody(req);
        const clientId = env.VITE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '';
        // Verified against Google, not taken on trust from the browser.
        const identity = await verifyGoogleIdToken(credential, clientId);
        const user = findOrCreateSocialUser(identity);
        const started = startSession(req, res, user);
        sendJson(res, {
          success: true, user, csrfToken: started.csrfToken,
          sessionId: started.sessionId, accounts: accountsOf(started.tokens),
          state: accountStats(user.id),
        });
      } catch (e) {
        sendError(res, e, 401);
      }
    });

    /* ------------------------------------------------------------ passkeys

       The relying party is the host the browser is talking to, and the origin
       it must have signed over is this exact origin. Both are derived from the
       request rather than configured, because this server is reached on a
       different address from every device that uses it. */

    const rpIdOf = (req) => String(req.headers.host || 'localhost').split(':')[0];
    const originsOf = (req) => {
      const host = req.headers.host || 'localhost';
      return [`http://${host}`, `https://${host}`];
    };

    route('/api/auth/passkey/register/options', (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      const issued = issueChallenge('register', { userId: auth.user.id });
      sendJson(res, {
        success: true,
        challengeId: issued.id,
        publicKey: {
          challenge: issued.challenge,
          rp: { id: rpIdOf(req), name: 'Ollama WebUI' },
          user: {
            id: Buffer.from(auth.user.id).toString('base64url'),
            name: auth.user.email || auth.user.name,
            displayName: auth.user.name,
          },
          pubKeyCredParams: SUPPORTED_ALGORITHMS.map(alg => ({ type: 'public-key', alg })),
          timeout: 120000,
          attestation: 'none',
          /* The full credential id, not a display prefix. A truncated one
             decodes to different bytes, so the authenticator does not
             recognise the key it already holds and quietly makes a second one
             for the same account. */
          excludeCredentials: credentialIds(auth.user.id).map(id => ({ type: 'public-key', id })),
          authenticatorSelection: {
            // Sign-in offers no username, so the key has to be discoverable.
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'preferred',
          },
        },
      });
    });

    route('/api/auth/passkey/register/verify', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const body = await jsonBody(req, 256 * 1024);
        const pending = consumeChallenge(body.challengeId, 'register');
        if (!pending || pending.meta?.userId !== auth.user.id) {
          throw Object.assign(new Error('That registration has expired. Try again.'), { code: 'challenge' });
        }
        const verified = verifyRegistration({
          challenge: pending.challenge,
          // The browser sends these base64url-encoded; the verifier reads bytes.
          attestationObject: Buffer.from(body.attestationObject || '', 'base64url'),
          clientDataJSON: Buffer.from(body.clientDataJSON || '', 'base64url'),
          rpId: rpIdOf(req),
          origins: originsOf(req),
        });
        addCredential(auth.user.id, {
          credentialId: body.credentialId || verified.credentialId,
          publicKeyJwk: verified.publicKeyJwk,
          algorithm: verified.algorithm,
          signCount: verified.signCount,
          label: body.label || 'Passkey',
          aaguid: verified.aaguid || null,
        });
        sendJson(res, {
          success: true,
          user: findUser(auth.user.id),
          passkeys: listCredentials(auth.user.id),
        });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/auth/passkey/login/options', (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      const issued = issueChallenge('login');
      sendJson(res, {
        success: true,
        challengeId: issued.id,
        publicKey: {
          challenge: issued.challenge,
          rpId: rpIdOf(req),
          timeout: 120000,
          userVerification: 'preferred',
          // Deliberately empty: naming credentials here would tell an
          // unauthenticated caller which accounts exist.
          allowCredentials: [],
        },
      });
    });

    route('/api/auth/passkey/login/verify', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      const refuse = () => sendJson(res, {
        success: false, error: 'That passkey was not accepted.', code: 'passkey',
      }, 401);
      try {
        const body = await jsonBody(req, 256 * 1024);
        const pending = consumeChallenge(body.challengeId, 'login');
        if (!pending) return refuse();

        const held = findByCredentialId(body.credentialId);
        // A passkey nobody registered names no account, and says so without
        // revealing whether any account exists.
        if (!held?.user) return refuse();

        /* `verifyAssertion` throws on anything wrong -- the origin, the site,
           the challenge, the signature, and a counter that did not move
           forward, which means the credential has been cloned or the
           assertion replayed. The catch below turns all of those into the
           same refusal. */
        const verified = verifyAssertion({
          challenge: pending.challenge,
          credential: held.credential,
          authenticatorData: Buffer.from(body.authenticatorData || '', 'base64url'),
          clientDataJSON: Buffer.from(body.clientDataJSON || '', 'base64url'),
          signature: Buffer.from(body.signature || '', 'base64url'),
          rpId: rpIdOf(req),
          origins: originsOf(req),
        });
        touchCredential(held.user.id, held.credential.credentialId, { signCount: verified.signCount });

        const user = held.user;
        const started = startSession(req, res, user);
        sendJson(res, {
          success: true, user, csrfToken: started.csrfToken,
          sessionId: started.sessionId, accounts: accountsOf(started.tokens),
          state: accountStats(user.id),
        });
      } catch (e) {
        refuse();
      }
    });

    route('/api/auth/passkey/list', (req, res) => {
      const auth = guard(req, res, { methods: ['GET'] });
      if (!auth) return;
      sendJson(res, { success: true, passkeys: listCredentials(auth.user.id) });
    });

    route('/api/auth/passkey/remove', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const { id } = await jsonBody(req);
        removeCredential(auth.user.id, id);
        sendJson(res, {
          success: true,
          user: findUser(auth.user.id),
          passkeys: listCredentials(auth.user.id),
        });
      } catch (e) {
        sendError(res, e);
      }
    });

    /* -------------------------------------------------------------- syncing

       One record at a time rather than one blob per account. See
       server/records.js for why: a blob cannot express a deletion, and two
       devices pushing one loses data three different ways. */

    route('/api/auth/sync', async (req, res) => {
      const auth = req.method === 'GET'
        ? (() => {
          const a = authenticate(req);
          if (!a.user) {
            sendJson(res, { success: false, error: 'Not signed in.', code: 'unauthenticated' }, 401);
            return null;
          }
          return a;
        })()
        : guard(req, res, { methods: ['POST'] });
      if (!auth) return;

      try {
        if (req.method === 'GET') {
          const since = Number(new URL(req.url, 'http://x').searchParams.get('since') || 0);
          const page = changesSince(auth.user.id, since);
          return sendJson(res, { success: true, ownerId: auth.user.id, ...page });
        }

        const body = await jsonBody(req, MAX_RECORD_BYTES * 4);
        const result = applyChanges(auth.user.id, body);

        /* Tombstones are swept occasionally rather than on a timer: this is
           the only code that runs regularly, and a sweep on every write would
           be a full table scan per sync. */
        if (result.applied > 0 && Math.random() < 0.02) sweepTombstones(auth.user.id);
        // Anything listening on this account is told there is something new.
        // Labelled with the tab that rang it: a device hears its own bell
        // too, and needs to know it was its own.
        if (result.applied > 0) publishRev(auth.user.id, result.rev, sessionRequest(req).id || '');

        sendJson(res, { success: true, ownerId: auth.user.id, ...result });
      } catch (e) {
        if (e instanceof OwnerMismatch) {
          return sendJson(res, {
            success: false, error: e.message, code: 'owner-mismatch',
            expected: e.expected, claimed: e.claimed,
          }, 409);
        }
        sendError(res, e);
      }
    });

    /* Keys for /v1 (server/openaiCompat.js).
         GET                      the account's keys, without the keys
         POST { name }            a new key -- the one time it is shown
         POST { revoke: id }      gone */
    route('/api/auth/apikeys', async (req, res) => {
      if (req.method === 'GET') {
        const auth = guard(req, res, { methods: ['GET'] });
        if (!auth) return;
        return sendJson(res, { success: true, keys: listApiKeys(auth.user.id) });
      }
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const body = await jsonBody(req);
        if (body.revoke) {
          const gone = revokeApiKey(auth.user.id, body.revoke);
          return sendJson(res, { success: gone, keys: listApiKeys(auth.user.id) }, gone ? 200 : 404);
        }
        const made = createApiKey(auth.user.id, body.name);
        sendJson(res, { success: true, created: made, keys: listApiKeys(auth.user.id) });
      } catch (e) {
        sendError(res, e);
      }
    });

    /* Telegram (server/telegram.js).
         GET                      whether the bot runs, its name, linked chats
         POST { link: true }      a one-time code and the t.me link carrying it
         POST { unlink: id }      forget a linked Telegram chat */
    route('/api/auth/telegram', async (req, res) => {
      if (req.method === 'GET') {
        const auth = guard(req, res, { methods: ['GET'] });
        if (!auth) return;
        return sendJson(res, {
          success: true,
          configured: !!String(env.TELEGRAM_BOT_TOKEN || '').trim(),
          bot: botUsername(),
          links: telegramLinksOf(auth.user.id),
        });
      }
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const body = await jsonBody(req);
        if (body.unlink) {
          telegramUnlink(auth.user.id, body.unlink);
          return sendJson(res, { success: true, links: telegramLinksOf(auth.user.id) });
        }
        const name = botUsername();
        if (!name) return sendJson(res, { success: false, error: 'The Telegram bot is not running. Set TELEGRAM_BOT_TOKEN in .env and restart.' }, 409);
        const code = makeLinkCode(auth.user.id);
        sendJson(res, { success: true, code, bot: name, url: `https://t.me/${name}?start=${code}` });
      } catch (e) {
        sendError(res, e);
      }
    });

    /* What a record used to be: the timeline behind "restore yesterday's
       version". Read-only. Restoring is an ordinary edit made by the client
       with the old payload, so it syncs, and is itself undoable, like any
       other write. See server/recordHistory.js.

         GET ?kind=chat                  records of that kind that have history
         GET ?kind=chat&id=X             the revisions kept for one record
         GET ?kind=chat&id=X&rev=N       one revision, whole */
    route('/api/auth/history', (req, res) => {
      const auth = guard(req, res, { methods: ['GET'] });
      if (!auth) return;
      try {
        const q = new URL(req.url, 'http://x').searchParams;
        const kind = q.get('kind') || 'chat';
        const id = q.get('id');
        const rev = q.get('rev');
        if (!id) return sendJson(res, { success: true, records: recordsWithHistory(auth.user.id, kind) });
        if (rev == null) return sendJson(res, { success: true, revisions: listRevisions(auth.user.id, kind, id) });
        const revision = readRevision(auth.user.id, kind, id, rev);
        if (!revision) return sendJson(res, { success: false, error: 'That version is not kept.', code: 'not-found' }, 404);
        sendJson(res, { success: true, revision });
      } catch (e) {
        sendError(res, e);
      }
    });

    /* A doorbell, not a delivery.
     *
     * The event carries a revision number and nothing else; the client then
     * asks for the delta the ordinary way. Sending the records down this
     * stream would mean two code paths that have to agree about merging, and
     * the one that is harder to test would be the one nobody watches. */
    route('/api/auth/events', (req, res) => {
      const auth = authenticate(req);
      /* Nobody signed in gets an empty answer rather than a refusal.
         This stream is opened by an EventSource, and an EventSource
         retries a failure for ever -- so answering 401 to the guest turns
         a signed-out tab into a reconnect loop. 204 closes it and stays
         closed. */
      if (!auth.user) {
        res.statusCode = 204;
        res.end();
        return;
      }
      addListener(auth.user.id, req, res);
    });

    /* ------------------------------------------------ schedules on the server

       An account's schedules, answered here whether or not a browser is open.
       Signed-in only: a guest has no chats on this server to answer in, and
       keeps the browser runner. See server/serverSchedules.js. */
    route('/api/schedules', async (req, res) => {
      if (req.method === 'GET') {
        const auth = authenticate(req);
        if (!auth.user) return sendJson(res, { success: false, error: 'Not signed in.', code: 'unauthenticated' }, 401);
        return sendJson(res, { success: true, schedules: listSchedules(auth.user.id) });
      }
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const made = createSchedule(auth.user.id, await jsonBody(req));
        if (made.error) return sendJson(res, { success: false, error: made.error }, 400);
        sendJson(res, { success: true, schedule: made.schedule });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/schedules/enabled', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const { id, enabled } = await jsonBody(req);
        sendJson(res, { success: setScheduleEnabled(auth.user.id, id, !!enabled) });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/schedules/delete', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        const { id } = await jsonBody(req);
        sendJson(res, { success: deleteSchedule(auth.user.id, id) });
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/auth/stats', (req, res) => {
      const auth = guard(req, res, { methods: ['GET'] });
      if (!auth) return;
      sendJson(res, { success: true, ownerId: auth.user.id, ...accountStats(auth.user.id) });
    });

    /* --------------------------------------------------------------- push

       The half of "tell me when it is done" that works when the app is not
       open anywhere. See server/push.js for why these carry no payload, and
       src/notify.js for the half that works when it is. */

    // The key a browser subscribes with. Public by definition -- it is handed
    // to every browser that subscribes -- and '' where none can be made.
    route('/api/push/key', (req, res) => {
      sendJson(res, { success: true, key: pushPublicKey() });
    });

    route('/api/push/subscribe', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] })
        // A guest can ask for notifications too; the account is the scope, and
        // '' is the guest's. `guard` refuses that, so it is only used to check
        // the method and CSRF when there *is* a session.
        || (authenticate(req).user ? null : { user: null, session: null });
      if (!auth) return;
      try {
        const body = await jsonBody(req);
        const kept = rememberSubscription(auth.user?.id || '', body.subscription, labelFor(body.label || '', body.labels));
        sendJson(res, kept ? { success: true } : { success: false, error: 'That is not a push endpoint.' }, kept ? 200 : 400);
      } catch (e) {
        sendError(res, e);
      }
    });

    route('/api/push/unsubscribe', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      try {
        const body = await jsonBody(req);
        sendJson(res, { success: true, forgotten: forgetSubscription(body.endpoint) });
      } catch (e) {
        sendError(res, e);
      }
    });

    /* What just finished, for a worker that has been woken with no payload to
       read. The sentence is the one the app handed over when it subscribed,
       because the worker has no translations of its own. */
    route('/api/push/last', (req, res) => {
      const owner = authenticate(req).user?.id || '';
      sendJson(res, { success: true, last: lastFinished(owner), label: subscriptionLabel(owner), labels: subscriptionLabels(owner) });
    });

    /* ------------------------------------------------------- share links */

    /* Publish a conversation. What comes back is the only copy of the token:
       the row holds a hash, so this response is the one chance to keep it. */
    route('/api/share/create', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      try {
        // The default body limit is 64 KB, which is a setting or a password.
        // A transcript is not, so this route is given the share cap plus room
        // for the JSON around it -- and `createShare` still checks the real
        // size, because the wrapper is not what is being stored.
        const { chatId, title, snapshot, picture, expiresInDays } =
          await jsonBody(req, MAX_SHARE_BYTES + 64 * 1024);
        // `picture` publishes one picture instead of a transcript; it names a
        // file rather than carrying it. See `createShare`.
        const made = createShare(auth.user.id, { chatId, title, snapshot, picture, expiresInDays });
        sendJson(res, { success: true, ...made });
      } catch (e) {
        sendJson(res, { success: false, error: e.message, code: e.code || 'share' }, e.status || 400);
      }
    });

    /* Read one, by its token, with no session at all.
     *
     * This is the only unauthenticated route here that returns something a
     * person wrote, so it is worth being explicit: `readShare` builds its reply
     * field by field and there is no path from a token to the account behind
     * it. A wrong, revoked or expired token gets the same 404 as a made-up one
     * -- telling them apart would tell a stranger that a guess had landed on
     * something real. `no-store` because a shared link is meant to be
     * revocable, and a copy sitting in a proxy is not. */
    route('/api/share/view', (req, res) => {
      if (req.method !== 'GET') return sendJson(res, { success: false, error: 'GET required.' }, 405);
      const token = new URL(req.url, 'http://x').searchParams.get('token') || '';
      const shared = readShare(token);
      res.setHeader('Cache-Control', 'no-store');
      if (!shared) return sendJson(res, { success: false, error: 'That link is not available.' }, 404);
      /* Everything except the file it names. The page asks for the picture by
         token and gets it from `/api/share/image`; handing the browser the
         filename as well would be handing it a second address for the same
         bytes, one that revoking the link does not reach. */
      const { file, ...page } = shared;
      sendJson(res, { success: true, share: page });
    });

    route('/api/share/list', (req, res) => {
      const auth = guard(req, res, { methods: ['GET'] });
      if (!auth) return;
      sendJson(res, { success: true, shares: listShares(auth.user.id) });
    });

    route('/api/share/revoke', async (req, res) => {
      const auth = guard(req, res, { methods: ['POST'] });
      if (!auth) return;
      const { id, all } = await jsonBody(req).catch(() => ({}));
      const removed = all ? revokeAllShares(auth.user.id) : (revokeShare(auth.user.id, id) ? 1 : 0);
      sendJson(res, { success: true, removed });
    });

    // Public identity of the app, served at runtime rather than baked in at
    // build time. A client ID is meant to be public — it names the app, not the
    // user — and serving it means any origin this backend answers on gets a
    // working sign-in button without anyone pasting keys into a settings box.
    route('/api/config', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        googleClientId: env.VITE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '',
        // Kakao sign-in was removed; an empty key keeps older clients from
        // offering a button that no longer has a server behind it.
        kakaoRestKey: '',
        accounts: true,
        // So the sign-in screen offers the passkey button only where this
        // server can actually verify one.
        passkeys: true,
        // Delta sync rather than whole-blob replacement. The client checks
        // this so an older backend still gets something that works.
        sync: 'records',
        /* The address everything should be opened on, if whoever runs this
           server named one. A browser keys its storage and its cookies to an
           origin, so a phone on `http://<address>.nip.io:5173` and a desktop
           on `http://localhost:5173` are two websites as far as the browser
           is concerned: two caches, two logins. The client compares this
           with the address it was loaded from and says so when they differ.
           Empty means nobody named one and every address is equally fine. */
        canonicalOrigin: normaliseOrigin(env.PUBLIC_ORIGIN, {
          scheme: isSecureRequest(req) ? 'https' : 'http',
          port: Number(env.PORT) || 5173,
        }),
        maxRecordBytes: MAX_RECORD_BYTES,
        maxBatchRecords: MAX_BATCH_RECORDS,
        secure: isSecureRequest(req),
      }));
    });

    // Headlines, deliberately separate from search: the answer shape is a dated
    // list from named publishers, not a page of links.
    route('/mcp/news',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const json = (payload, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        try {
          const { topic, limit, language } = JSON.parse(body || '{}');
          const count = Number(limit) > 0 ? Math.min(Number(limit), 20) : 8;
          // A model may pass the user's whole sentence as the topic, so it goes
          // through the same reduction the search chain uses.
          const subject = newsTopic(topic || '');
          const res2 = await fetchWithTimeout(newsFeedUrl(subject, String(language || 'en')), 12000);
          if (!res2.ok) throw new Error(`HTTP ${res2.status}`);

          let items = sortByRecency(parseNewsFeed(await textOf(res2), count * 3));
          if (!subject) items = withinHours(items, 48);
          items = items.slice(0, count);

          json({
            success: true,
            topic: subject || null,
            fetchedAt: Date.now(),
            items,
            text: formatNews(items),
          });
        } catch (e) {
          json({ success: false, error: e.name === 'AbortError' ? 'The news feed timed out' : e.message }, 500);
        }
      });
    });

    /* Where Google-in-Chrome's pacing stands: how many searches this hour and
       today, and whether it is resting after a CAPTCHA. Starts nothing. */
    route('/api/browser-search/status', (req, res) => sendJson(res, { success: true, ...browserSearchStatus(env) }));

    route('/mcp/search',(req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const json = (payload, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        try {
          const { query, limit, language } = JSON.parse(body || '{}');
          if (!query || !String(query).trim()) return json({ success: false, error: 'A query is required' }, 400);

          const { results, provider, attempts } = await searchWeb(
            String(query).trim(),
            Number(limit) > 0 ? Number(limit) : 5,
            env,
            String(language || 'en'),
          );
          json({ success: true, query, results, provider, attempts });
        } catch (e) {
          json({ success: false, error: e.name === 'AbortError' ? 'The search timed out' : e.message }, 500);
        }
      });
    });

    // ---- System stats ----
    // A browser cannot see host CPU/GPU/RAM, so the dev server samples them.
    // CPU load is a delta between polls, hence the module-level snapshot.

    /* The card back to the language model, after a picture has had it.
     *
     * Taking it *off* for a picture has always happened (`releaseLlm` in
     * server/studio.js). Putting it back waited until something next asked a
     * question -- so a reply that draws a picture and then keeps writing paid
     * for a 22GB reload in the middle of itself, with the reader watching.
     * Asked for as soon as the picture is finished instead, and answered
     * straight away: the loading happens behind whatever the app does next. */
    route('/api/vram/warm', async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST required.' }, 405);
      let model = '';
      try { ({ model } = await jsonBody(req)); } catch (e) { /* no model, nothing to warm */ }
      sendJson(res, { success: true, warming: !!model });
      if (!model) return;
      // Deliberately not awaited by the response: a cold model is minutes and
      // an HTTP request held open for it is a request that times out.
      vramGuard(env).warmLlm(String(model)).catch(() => {});
    });

    route('/system/stats',async (req, res) => {
      const json = (payload, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(payload));
      };

      try {
        const cpus = os.cpus();

        const sample = cpus.map(c => {
          const t = c.times;
          return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
        });

        let overall = null;
        let cores = [];
        if (previousCpuSample && previousCpuSample.length === sample.length) {
          let idleDiff = 0;
          let totalDiff = 0;
          cores = sample.map((core, i) => {
            const prev = previousCpuSample[i];
            const dIdle = core.idle - prev.idle;
            const dTotal = core.total - prev.total;
            idleDiff += dIdle;
            totalDiff += dTotal;
            return dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
          });
          if (totalDiff > 0) overall = Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
        }
        previousCpuSample = sample;

        const totalMem = os.totalmem();
        const freeMem = os.freemem();

        json({
          ok: true,
          at: Date.now(),
          cpu: {
            model: (cpus[0] && cpus[0].model || '').trim(),
            count: cpus.length,
            usage: overall,          // null on the very first poll
            cores,
          },
          memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
          /* Commit -- RAM plus the page file -- is what a model load actually
             needs, and running out of it is not slow, it is ComfyUI exiting.
             See commitAvailable in server/resourceSafety.js. */
          commit: await commitStats().catch(() => null),
          gpus: await readGpuStats(),
          host: { platform: os.platform(), uptime: os.uptime(), load: os.loadavg() },
        });
      } catch (e) {
        json({ ok: false, error: e.message }, 500);
      }
    });

    /* The engines this app runs: GPT-SoVITS for speech, ACE-Step for songs.
     *
     * They live in `engines/` now -- inside the project, gitignored, started by
     * the app when something needs one. `.env` still wins where it names a
     * path, so an install kept elsewhere on purpose goes on working. See
     * server/engines.js. */
    const engines = enginesFor(env);

    route('/api/engines', async (req, res) => {
      sendJson(res, { success: true, engines: await engines.list() });
    });

    route('/api/engines/start', async (req, res) => {
      let body = {};
      try { body = await jsonBody(req); } catch (e) { return sendJson(res, { success: false, error: e.message }, 400); }
      const id = String(body.id || '').trim();
      if (!ENGINE_SPECS[id]) return sendJson(res, { success: false, error: `Unknown engine: ${id}` }, 400);
      /* Not waited for by default: starting one is minutes of loading weights,
         and a browser that waits for it has already given up. The caller polls
         /api/engines, which is the same question asked cheaply. */
      const started = await engines.ensure(id, { wait: body.wait === true });
      sendJson(res, { success: started.ok !== false, ...started }, started.ok === false ? 502 : 200);
    });

    // Kept at their old addresses: the Voice settings and the speak button call
    // these, and an engine is not a reason to change what they call.
    route('/api/tts-status', async (req, res) => {
      const voice = await engines.status('gpt-sovits');
      sendJson(res, {
        configured: voice.installed,
        installed: voice.installed,
        root: voice.root,             // the folder's name, never the full path
        host: engines.resolve('gpt-sovits').host,
        port: voice.port,
        running: voice.running,
        problem: voice.problem,
      });
    });

    route('/api/start-tts', async (req, res) => {
      const started = await engines.ensure('gpt-sovits', { wait: false });
      if (started.ok === false) return sendJson(res, { success: false, error: started.error }, 502);
      sendJson(res, { success: true, ...started });
    });

  /* The OpenAI-compatible API, with the account's context. Authenticated by
     API key inside the route; see server/openaiCompat.js. */
  routes.push(...createOpenAiRoutes(env, {
    backend: backendOf(env),
    beforeInference: () => vramGuard(env).beforeInference(),
  }));

  /* The inference backend.
   *
   * Under Ollama nothing is registered here and `/api/*` falls through to the
   * proxy it has always fallen through to. Under llama.cpp these handlers claim
   * the same paths and translate — see server/llamacpp.js for why the client
   * keeps speaking Ollama's dialect either way.
   *
   * Registered from inside `createApiRoutes` on purpose: it is the one thing
   * both the dev middleware stack and the production server already call, so
   * `npm run dev` and `npm start` cannot end up on different backends. */
  if (backendOf(env) === 'llamacpp') {
    for (const llamaRoute of createLlamaRoutes(env)) routes.push(llamaRoute);
    // Draft models per model, in the preset file llama-server reads. See
    // server/speculative.js.
    const llamaBase = (env.LLAMACPP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
    routes.push(...createSpeculativeRoutes({
      env,
      allowLocalFs,
      listModels: () => listLlamaModels(llamaBase),
      /* A JSON content type cannot be sent cross-site without a preflight
         this server never grants, so a page elsewhere cannot rewrite the
         preset through a visitor's browser. */
      guard: (req, res) => {
        if (req.method === 'POST' && !/^application\/json/i.test(req.headers['content-type'] || '')) {
          res.statusCode = 415;
          res.end(JSON.stringify({ success: false, error: 'JSON required.' }));
          return false;
        }
        return true;
      },
    }));
  }

  /* Pictures and video. Always mounted: unlike the backend switch these do not
   * take a path away from anything, and they answer with a legible "ComfyUI is
   * not running" rather than a 404 when it is not — which is the difference
   * between a feature that looks broken and one that says what to start. */
  /* `identify` is only for `/studio/live`, which says what is being generated
     in one conversation: that answer belongs to the account that asked for the
     picture and to nobody else. Every other studio route is unchanged. */
  for (const studioRoute of createStudioRoutes(env, {
    identify: (req) => String(authenticate(req).user?.id || ''),
  })) routes.push(studioRoute);

  /* Songs, for the same reason and on the same terms: mounted always, and they
   * say "ACE-Step is not installed" rather than 404ing. See server/music.js. */
  for (const musicRoute of createMusicRoutes(env, {
    identify: (req) => String(authenticate(req).user?.id || ''),
  })) routes.push(musicRoute);

  /* Tools from servers this repository did not write. Mounted always and inert
     until `mcp.json` exists: with no config the routes answer with an empty
     list and the name of the file they looked for, which is what lets the
     panel explain itself instead of 404ing. See server/mcp.js. */
  for (const mcpRoute of createMcpRoutes(env, { readBody: readRequestBody })) routes.push(mcpRoute);

  /* What the signed-in CLIs are, and what they have done since start. See
     server/cliModels.js. */
  for (const cliRoute of createCliRoutes(env)) routes.push(cliRoute);

  return allowLocalFs
    ? routes
    : routes.filter(r => !r.path.startsWith('/localfs'));
};
