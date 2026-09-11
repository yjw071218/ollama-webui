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
import {
  issueState, consumeState, authorizeUrl, exchangeCode, fetchProfile,
  validAccessToken, readTokens, writeTokens, clearTokens,
  logout as kakaoLogout, unlink as kakaoUnlink,
} from './kakao.js';
import {
  changesSince, applyChanges, accountStats, sweepTombstones,
  OwnerMismatch, MAX_RECORD_BYTES, MAX_BATCH_RECORDS,
} from './records.js';
import {
  createShare, readShare, listShares, revokeShare, revokeAllShares, MAX_SHARE_BYTES,
} from './shares.js';
import { addListener, publishRev, dropListeners } from './liveSync.js';
import { normaliseOrigin } from './origin.js';
import {
  fetchWithTimeout, fetchPageResponse, blockReason,
  htmlToText, decodeEntities, mainContent, readAsText, textOf,
  marketFor, rankByRelevance,
} from './webText.js';
import { createLlamaRoutes, backendOf } from './llamacpp.js';
import { createStudioRoutes } from './studio.js';


// Previous CPU tick snapshot; usage is only meaningful as a delta.
let previousCpuSample = null;

// Turns off after the first failure so a machine without nvidia-smi does not
// pay for a process spawn on every poll.
let gpuProbeAvailable = true;

const NVIDIA_QUERY = [
  '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
  '--format=csv,noheader,nounits',
];

const readGpuStats = () => new Promise((resolve) => {
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
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    15000,
    { 'X-Subscription-Token': key, Accept: 'application/json' }
  );
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, limit).map(r => trimResult({
    title: r.title, url: r.url, snippet: r.description,
  }));
};

const searchTavily = async (query, limit, key) => {
  const res = await fetchWithTimeout('https://api.tavily.com/search', 20000, { 'Content-Type': 'application/json' }, {
    method: 'POST',
    body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic' }),
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
  }, { method: 'POST', body: JSON.stringify({ q: query, num: limit }) });
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

  // Key-free providers, best first. Bing currently answers plain requests;
  // DuckDuckGo rate-limits after a handful, so it sits below.
  chain.push(['bing', () => searchBing(query, limit)]);
  chain.push(['duckduckgo', () => searchDuckDuckGo(query, limit)]);
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
  const routes = [];
  const route = (routePath, handler) => routes.push({ path: routePath, handler });


    route('/localfs/read',(req, res) => {
      let body = '';
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

    route('/localfs/search',(req, res) => {
      let body = '';
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

          const response = await fetchPageResponse(url);
          if (!response.ok) {
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
          const cap = Number(limit) > 0 ? Number(limit) : 8000;

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

    route('/api/auth/stats', (req, res) => {
      const auth = guard(req, res, { methods: ['GET'] });
      if (!auth) return;
      sendJson(res, { success: true, ownerId: auth.user.id, ...accountStats(auth.user.id) });
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
        const { chatId, title, snapshot, expiresInDays } =
          await jsonBody(req, MAX_SHARE_BYTES + 64 * 1024);
        const made = createShare(auth.user.id, { chatId, title, snapshot, expiresInDays });
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
      sendJson(res, { success: true, share: shared });
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
    // The Kakao *client secret* is not here; it never leaves the server.
    route('/api/config', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        googleClientId: env.VITE_GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_ID || '',
        kakaoRestKey: env.VITE_KAKAO_REST_KEY || env.KAKAO_REST_KEY || '',
        kakaoSecretConfigured: !!env.KAKAO_CLIENT_SECRET,
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

    route('/mcp/search',(req, res) => {
      let body = '';
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
          gpus: await readGpuStats(),
          host: { platform: os.platform(), uptime: os.uptime(), load: os.loadavg() },
        });
      } catch (e) {
        json({ ok: false, error: e.message }, 500);
      }
    });

    // ---- Kakao Login ----
    // The JS SDK v2 dropped Kakao.Auth.login(); the supported flow is the
    // OAuth authorization code grant, and the token endpoint neither works
    // from a browser (no CORS) nor accepts the JavaScript key. So the popup
    // relays the code back here and the exchange happens server-side.

    /**
     * Where Kakao sends the browser back, and where the login finishes.
     *
     * This used to be an HTML page that posted the authorization code to the
     * opener so a popup could exchange it. That put the code through the
     * browser for no reason, needed a popup — which is blocked often and is
     * miserable on a phone — and made the redirect URI a page rather than an
     * endpoint. The documented flow is a plain redirect: the code arrives here,
     * is exchanged here, and the browser leaves with a session cookie having
     * never seen it.
     */
    route('/kakao/callback', async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const back = (params) => {
        res.writeHead(302, { Location: `/?${new URLSearchParams(params)}` });
        res.end();
      };

      const error = url.searchParams.get('error');
      if (error) {
        // Cancelling at the consent screen is not a failure worth shouting about.
        const description = url.searchParams.get('error_description') || error;
        return back(error === 'access_denied'
          ? { kakao: 'cancelled' }
          : { kakao: 'error', detail: description });
      }

      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      if (!code) return back({ kakao: 'cancelled' });

      // Verified here, where it was issued. A state that was never issued, has
      // expired, or has already been spent means this callback is not one we
      // started.
      if (!consumeState(state)) {
        return back({ kakao: 'error', detail: 'That sign-in could not be verified. Start it again.' });
      }

      const { restKey, clientSecret } = kakaoCreds();
      if (!restKey) return back({ kakao: 'error', detail: 'Kakao is not configured on this server.' });

      // Must match the authorize request exactly, so it is rebuilt from the
      // address this request actually arrived on.
      const host = req.headers.host || `localhost:${env.PORT || 5173}`;
      const scheme = req.socket?.encrypted ? 'https' : 'http';
      const redirectUri = `${scheme}://${host}/kakao/callback`;

      try {
        const tokens = await exchangeCode({ code, restKey, redirectUri, clientSecret });
        const identity = await fetchProfile(tokens.accessToken);
        const user = findOrCreateSocialUser(identity);

        writeTokens(user.id, tokens);
        // Arrives as a top-level redirect from Kakao, so this is the one
        // sign-in that cannot carry a CSRF header; the `state` parameter
        // checked above is what stands in for it.
        startSession(req, res, user);
        res.writeHead(302, { Location: '/?kakao=ok' });
        res.end();
      } catch (e) {
        const raw = e.message || 'Sign-in failed';
        let hint = '';
        if (!clientSecret && /client_secret|invalid_client|KOE010/i.test(raw)) {
          hint = ' — Client Secret is enabled on this app. Turn it off in the Kakao console '
            + 'or set KAKAO_CLIENT_SECRET in .env and restart.';
        } else if (/redirect|KOE006|KOE320/i.test(raw)) {
          hint = ` — ${redirectUri} must be registered verbatim under 카카오 로그인 → Redirect URI.`;
        }
        back({ kakao: 'error', detail: raw + hint });
      }
    });

    // ---- Kakao Login ----
    //
    // The documented flow: authorize, exchange, profile, logout, unlink. The
    // exchange and everything after it happen here because they need the REST
    // key and the client secret, and because `state` is only worth checking
    // somewhere the browser cannot reach.

    const kakaoCreds = () => ({
      restKey: env.VITE_KAKAO_REST_KEY || env.KAKAO_REST_KEY || '',
      clientSecret: env.KAKAO_CLIENT_SECRET || '',
    });

    // Step 1. The browser asks for a state rather than inventing one, so the
    // value it later returns is one this server actually issued.
    route('/kakao/start', (req, res) => {
      const { restKey } = kakaoCreds();
      if (!restKey) {
        return sendJson(res, { success: false, error: 'Kakao is not configured on this server.' }, 501);
      }
      const url = new URL(req.url, 'http://localhost');
      const redirectUri = url.searchParams.get('redirect_uri') || '';
      const scope = url.searchParams.get('scope') || '';
      const state = issueState();
      sendJson(res, {
        success: true,
        state,
        authorizeUrl: authorizeUrl({ restKey, redirectUri, state, scope }),
      });
    });

    // Step 4. Signing out of this app should not leave the Kakao session up.
    route('/kakao/logout', async (req, res) => {
      const user = currentUser(req);
      if (!user) return sendJson(res, { success: false, error: 'Not signed in.' }, 401);
      try {
        const token = await validAccessToken(user.id, kakaoCreds());
        if (token) await kakaoLogout(token);
        clearTokens(user.id);
        sendJson(res, { success: true });
      } catch (e) {
        // The local session still ends; the Kakao one may already have.
        clearTokens(user.id);
        sendJson(res, { success: true, warning: e.message });
      }
    });

    // Step 5. What "연결 끊기" means, and what deleting an account should do.
    route('/kakao/unlink', async (req, res) => {
      const user = currentUser(req);
      if (!user) return sendJson(res, { success: false, error: 'Not signed in.' }, 401);
      try {
        const token = await validAccessToken(user.id, kakaoCreds());
        if (!token) return sendJson(res, { success: false, error: 'This account has no Kakao connection.' }, 400);
        await kakaoUnlink(token);
        clearTokens(user.id);
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
    });

    // Whether this account still has a live Kakao connection.
    route('/kakao/status', (req, res) => {
      const user = currentUser(req);
      const tokens = user ? readTokens(user.id) : null;
      sendJson(res, {
        success: true,
        connected: !!tokens?.accessToken,
        scope: tokens?.scope || '',
        expiresAt: tokens?.accessTokenExpiresAt || null,
        refreshable: !!tokens?.refreshToken,
      });
    });

    // GPT-SoVITS lives outside this repository — it is tens of gigabytes of
    // weights and a bundled Python runtime. The web UI only needs to know where
    // it is, and that comes from .env so no one's install layout ends up here.
    const ttsRoot = env.GPT_SOVITS_PATH || '';
    const ttsHost = env.TTS_HOST || '127.0.0.1';
    const ttsPort = Number(env.TTS_PORT || 9880);

    route('/api/tts-status',(req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        configured: !!ttsRoot,
        installed: !!ttsRoot && fs.existsSync(ttsRoot),
        root: ttsRoot ? path.basename(ttsRoot) : null,   // never the full path
        host: ttsHost,
        port: ttsPort,
      }));
    });

    route('/api/start-tts',(req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (!ttsRoot) {
        res.statusCode = 501;
        res.end(JSON.stringify({
          success: false,
          error: 'GPT_SOVITS_PATH is not set. Copy .env.example to .env and point it at your GPT-SoVITS folder.',
        }));
        return;
      }
      if (!fs.existsSync(ttsRoot)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: `GPT_SOVITS_PATH does not exist: ${ttsRoot}` }));
        return;
      }
      try {
        const script = path.resolve(process.cwd(), 'tts', 'start-tts-api.ps1');
        const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
          detached: true,
          stdio: 'ignore',
          cwd: process.cwd(),
        });
        ps.unref();
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });

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
  }

  /* Pictures and video. Always mounted: unlike the backend switch these do not
   * take a path away from anything, and they answer with a legible "ComfyUI is
   * not running" rather than a 404 when it is not — which is the difference
   * between a feature that looks broken and one that says what to start. */
  for (const studioRoute of createStudioRoutes(env)) routes.push(studioRoute);

  return allowLocalFs
    ? routes
    : routes.filter(r => !r.path.startsWith('/localfs'));
};
