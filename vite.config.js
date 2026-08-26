import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs';
import path from 'path';
import { spawn, execFile } from 'child_process';
import os from 'os';

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
   CORS restriction, so it does the fetching itself. */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTML_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/',
};

const decodeEntities = (text) => text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
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
const htmlToText = (html) => decodeEntities(
  html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
)
  .replace(/[ \t\u00a0]+/g, ' ')
  .replace(/\n\s*\n\s*\n+/g, '\n\n')
  .trim();

const fetchWithTimeout = async (url, ms = 15000, headers = {}, init = {}) => {
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
  const res = await fetchWithTimeout(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}`,
    15000,
    { Accept: 'text/html,application/xhtml+xml' }
  );
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
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
  const res = await fetchWithTimeout('https://html.duckduckgo.com/html/', 15000, {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, { method: 'POST', body: new URLSearchParams({ q: query }).toString() });

  const html = await res.text();
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
const searchWeb = async (query, limit = 5, env = {}) => {
  const chain = [];

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
      const results = await run();
      if (results.length > 0) return { results, provider: name, attempts };
      attempts.push(`${name}: no results`);
    } catch (e) {
      attempts.push(`${name}: ${e.message}`);
      if (/rate-limit|challeng|429|403|202/i.test(e.message)) startCooldown(name);
    }
  }

  return { results: [], provider: null, attempts };
};

const localFsPlugin = (env = {}) => ({
  name: 'local-fs-plugin',
  configureServer(server) {
    server.middlewares.use('/localfs/read', (req, res) => {
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

    server.middlewares.use('/localfs/write', (req, res) => {
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
    
    server.middlewares.use('/localfs/list', (req, res) => {
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

    server.middlewares.use('/localfs/search', (req, res) => {
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
    server.middlewares.use('/mcp/fetch', (req, res) => {
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

          const response = await fetchWithTimeout(url);
          if (!response.ok) return json({ success: false, error: `HTTP ${response.status}` }, 400);

          const type = response.headers.get('content-type') || '';
          const raw = await response.text();
          const text = /html/i.test(type) ? htmlToText(raw) : raw;
          const cap = Number(limit) > 0 ? Number(limit) : 8000;

          json({
            success: true,
            url: response.url || url,
            contentType: type,
            truncated: text.length > cap,
            text: text.slice(0, cap),
          });
        } catch (e) {
          json({ success: false, error: e.name === 'AbortError' ? 'The request timed out' : e.message }, 500);
        }
      });
    });

    // ---- MCP: web search ----
    server.middlewares.use('/mcp/search', (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const json = (payload, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        try {
          const { query, limit } = JSON.parse(body || '{}');
          if (!query || !String(query).trim()) return json({ success: false, error: 'A query is required' }, 400);

          const { results, provider, attempts } = await searchWeb(
            String(query).trim(),
            Number(limit) > 0 ? Number(limit) : 5,
            env
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

    server.middlewares.use('/system/stats', async (req, res) => {
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

    server.middlewares.use('/kakao/callback', (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      const error = url.searchParams.get('error') || '';
      const errorDescription = url.searchParams.get('error_description') || '';

      const payload = JSON.stringify({ source: 'kakao-login', code, state, error, errorDescription });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Kakao</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#444}</style>
</head><body>
<p>Returning to the app…</p>
<script>
  (function () {
    var payload = ${payload};
    try {
      if (window.opener) {
        window.opener.postMessage(payload, window.location.origin);
        window.close();
        return;
      }
    } catch (e) {}
    document.body.textContent = 'You can close this window.';
  })();
</script>
</body></html>`);
    });

    server.middlewares.use('/kakao/exchange', (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        const fail = (status, error, detail) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error, detail }));
        };

        try {
          const { code, restKey, redirectUri } = JSON.parse(body || '{}');
          if (!code || !restKey || !redirectUri) return fail(400, 'Missing code, restKey or redirectUri');

          // Kakao enables Client Secret by default on new REST keys. When it
          // is on, the token request must carry it — otherwise the exchange
          // fails even with a perfectly valid code. It stays server-side:
          // KAKAO_CLIENT_SECRET has no VITE_ prefix, so it never reaches the
          // browser bundle.
          const params = {
            grant_type: 'authorization_code',
            client_id: restKey,
            redirect_uri: redirectUri,
            code,
          };
          if (env.KAKAO_CLIENT_SECRET) params.client_secret = env.KAKAO_CLIENT_SECRET;

          const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
            body: new URLSearchParams(params).toString(),
          });
          const token = await tokenRes.json();
          if (!tokenRes.ok || !token.access_token) {
            const raw = JSON.stringify(token);
            let hint = '';
            if (!env.KAKAO_CLIENT_SECRET && /client_secret|invalid_client|KOE010/i.test(raw)) {
              hint = ' — Client Secret is enabled on this app. Either turn it off in the Kakao console '
                + '(카카오 로그인 → 클라이언트 시크릿 → 비활성화) or set KAKAO_CLIENT_SECRET in .env and restart the dev server.';
            } else if (env.KAKAO_CLIENT_SECRET && /client_secret|invalid_client|KOE010/i.test(raw)) {
              hint = ' — KAKAO_CLIENT_SECRET is set but Kakao rejected it. Check it matches the current code '
                + '(it changes when you press 코드 재발급), and restart the dev server after editing .env.';
            } else if (/redirect|KOE006|KOE320/i.test(raw)) {
              hint = ` — the redirect_uri sent (${redirectUri}) must be registered verbatim under 카카오 로그인 → Redirect URI.`;
            }
            const code = token.error_code ? `${token.error_code}: ` : '';
            return fail(400, code + (token.error_description || token.error || 'Token exchange failed') + hint, token);
          }

          const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
            headers: { Authorization: `Bearer ${token.access_token}` },
          });
          const me = await meRes.json();
          if (!meRes.ok || !me.id) {
            const code = me.code !== undefined ? `code ${me.code}: ` : '';
            const hint = /-402|insufficient scope/i.test(JSON.stringify(me))
              ? ' — enable the consent item in 카카오 로그인 → 동의항목 (닉네임 at minimum).'
              : '';
            return fail(400, code + (me.msg || 'Profile request failed') + hint, me);
          }

          const account = me.kakao_account || {};
          const profile = account.profile || {};
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            success: true,
            profile: {
              id: String(me.id),
              email: account.email || '',
              name: profile.nickname || me.properties?.nickname || 'Kakao user',
              avatar: profile.profile_image_url || me.properties?.profile_image || '',
            },
          }));
        } catch (e) {
          fail(500, e.message);
        }
      });
    });

    // GPT-SoVITS lives outside this repository — it is tens of gigabytes of
    // weights and a bundled Python runtime. The web UI only needs to know where
    // it is, and that comes from .env so no one's install layout ends up here.
    const ttsRoot = env.GPT_SOVITS_PATH || '';
    const ttsHost = env.TTS_HOST || '127.0.0.1';
    const ttsPort = Number(env.TTS_PORT || 9880);

    server.middlewares.use('/api/tts-status', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        configured: !!ttsRoot,
        installed: !!ttsRoot && fs.existsSync(ttsRoot),
        root: ttsRoot ? path.basename(ttsRoot) : null,   // never the full path
        host: ttsHost,
        port: ttsPort,
      }));
    });

    server.middlewares.use('/api/start-tts', (req, res) => {
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
  }
});

// https://vitejs.dev/config/
// The third argument to loadEnv is an empty prefix, so unprefixed values like
// KAKAO_CLIENT_SECRET are readable here without ever being exposed to the client.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react(), localFsPlugin(env)],
    server: {
      // OAuth redirect URIs are registered per exact origin, so the port must
      // not drift. Without strictPort a second `npm run dev` silently lands on
      // 5174 and every social sign-in fails with a redirect-URI mismatch.
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/start-tts': {
          // Handled by our middleware; kept separate from the Ollama proxy.
        },
        '/api': {
          target: 'http://localhost:11434',
          changeOrigin: true,
        },
        '/tts-api': {
          target: `http://${env.TTS_HOST || '127.0.0.1'}:${env.TTS_PORT || 9880}`,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/tts-api/, ''),
        },
      },
    },
  };
});
