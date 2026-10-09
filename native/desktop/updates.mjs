// Public release metadata only. Never send server addresses, cookies or credentials.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

export const repository = 'yjw071218/ollama-webui';
const base = 'https://github.com/' + repository + '/releases/';
export function versionParts(value) {
  const match = /^(?:native-v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}
export function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b || ![...a, ...b].every(Number.isSafeInteger)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Which installer this copy of the app replaces itself with. */
export const assetKinds = { setup: '-Setup.exe', portable: '-Portable.exe', android: '.apk' };
const assetOf = (release, kind) => release.assets?.find(a => a.state === 'uploaded'
  && /^OllamaWebUI-Client-[0-9.]+(-x64-(Setup|Portable)\.exe|\.apk)$/.test(a.name || '')
  && a.name.endsWith(assetKinds[kind]));

/** The "## 이번 버전" section of a release body, or its start when there is none. */
export function releaseNotes(body = '') {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const m = /^##\s*이번 버전[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text);
  const notes = (m ? m[1] : text).trim();
  return notes.length > 4000 ? notes.slice(0, 4000) + '…' : notes;
}

export function selectUpdate(releases, current, platform = 'windows') {
  if (!Array.isArray(releases)) return null;
  const kind = platform === 'android' ? 'android' : platform === 'portable' ? 'portable' : 'setup';
  const best = releases.filter(r => r && !r.draft && !r.prerelease && /^native-v/.test(r.tag_name)
    && newer(r.tag_name, current) && assetOf(r, kind))
    .sort((a, b) => newer(a.tag_name, b.tag_name) ? -1 : newer(b.tag_name, a.tag_name) ? 1 : 0)[0];
  if (!best) return null;
  const asset = assetOf(best, kind);
  const sums = best.assets.find(a => a.name === 'SHA256SUMS.txt' && a.state === 'uploaded');
  return {
    version: best.tag_name.slice(8), tag: best.tag_name,
    url: base + 'tag/' + encodeURIComponent(best.tag_name),
    notes: releaseNotes(best.body), publishedAt: best.published_at || null,
    asset: { name: asset.name, size: asset.size, url: asset.browser_download_url },
    sumsUrl: sums?.browser_download_url || null,
  };
}
export async function checkUpdate(current, fetcher = fetch, platform = 'windows') {
  // Native releases are not marked "latest": do not use /releases/latest.
  const response = await fetcher('https://api.github.com/repos/' + repository + '/releases?per_page=100', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OllamaWebUI-Client' },
    signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if ([403, 429].includes(response.status)) return checkPublicReleases(current, fetcher, platform, response.status);
  if (!response.ok) throw new Error('업데이트 확인 HTTP ' + response.status);
  return selectUpdate(await response.json(), current, platform);
}

// Public release pages use a separate quota from the unauthenticated REST API.
async function checkPublicReleases(current, fetcher, platform, status) {
  const get = async url => {
    const r = await fetcher(url, { headers: { Accept: 'text/html, application/atom+xml', 'User-Agent': 'OllamaWebUI-Client' }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!r.ok) throw new Error('업데이트 확인 HTTP ' + status + ' (공개 릴리스 조회 HTTP ' + r.status + ')');
    return r.text();
  };
  const feed = await get('https://github.com/' + repository + '/releases.atom');
  if (!/<feed[\s>]/.test(feed)) throw new Error('공개 릴리스 응답이 올바르지 않습니다.');
  const tags = [...new Set(feed.match(/native-v\d+\.\d+\.\d+(?![\w.-])/g) || [])]
    .filter(tag => newer(tag, current)).sort((a, b) => newer(a, b) ? -1 : 1);
  const kind = platform === 'android' ? 'android' : platform === 'portable' ? 'portable' : 'setup';
  for (const tag of tags) {
    const page = await get(base + 'tag/' + tag);
    if (/Pre-release<\//i.test(page)) continue;
    const html = await get(base + 'expanded_assets/' + tag);
    const assets = [...html.matchAll(/href="([^"<>]+)"/g)].map(m => {
      const url = new URL(m[1].replace(/&amp;/g, '&'), 'https://github.com');
      const prefix = '/' + repository + '/releases/download/' + tag + '/';
      if (url.origin !== 'https://github.com' || !url.pathname.startsWith(prefix)) return null;
      return { name: decodeURIComponent(url.pathname.slice(prefix.length)), state: 'uploaded', browser_download_url: url.href };
    }).filter(Boolean);
    const release = { tag_name: tag, assets };
    if (assetOf(release, kind)) return selectUpdate([release], current, platform);
  }
  return null;
}

/* The portable build cannot overwrite itself while it runs: a small PowerShell
   script waits for it to exit, moves the new file over the old one (so
   shortcuts keep working) and starts it. Sent as -EncodedCommand (UTF-16), so
   a Korean user name in the path survives, and with every path as a
   single-quoted literal. */
const psLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";
export function portableScript(next, target, relaunch = true) {
  if (![next, target].every(p => typeof p === 'string' && /^[A-Za-z]:\\[^\r\n\0]+$/.test(p)))
    throw new Error('설치 경로가 올바르지 않습니다.');
  return [
    `$next = ${psLiteral(next)}`, `$target = ${psLiteral(target)}`,
    'for ($i = 0; $i -lt 120; $i++) {',
    '  try { Move-Item -LiteralPath $next -Destination $target -Force -ErrorAction Stop;'
      + (relaunch ? ' Start-Process -FilePath $target;' : '') + ' exit 0 }',
    '  catch { Start-Sleep -Seconds 1 }',
    '}',
    relaunch ? 'Start-Process -FilePath $next' : '',
    'exit 1',
  ].join('\n');
}
export const encodePowerShell = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** The hash SHA256SUMS.txt lists for `name`, or null. */
export function expectedHash(sums, name) {
  for (const line of String(sums || '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

/* Release files live on github.com and are served from GitHub's own asset
   hosts. A redirect anywhere else, or to plain http, is refused. */
const TRUSTED = [/^github\.com$/, /^objects\.githubusercontent\.com$/, /^release-assets\.githubusercontent\.com$/,
  /^github-releases\.githubusercontent\.com$/];
export function trustedDownloadURL(value, extraHosts = []) {
  try {
    const u = new URL(value);
    if (extraHosts.includes(u.host)) return true;
    return u.protocol === 'https:' && !u.username && !u.password && TRUSTED.some(r => r.test(u.hostname));
  } catch { return false; }
}

/** GET following at most five redirects, each to a trusted host. */
async function trustedFetch(url, { fetcher, signal, extraHosts }) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!trustedDownloadURL(current, extraHosts)) throw new Error('신뢰하지 않는 다운로드 주소입니다.');
    const response = await fetcher(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'OllamaWebUI-Client', Accept: 'application/octet-stream' } });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) throw new Error('다운로드 리다이렉트 오류');
      current = new URL(next, current).href;
      continue;
    }
    if (!response.ok) throw new Error('다운로드 HTTP ' + response.status);
    return response;
  }
  throw new Error('리다이렉트가 너무 많습니다.');
}

/**
 * Download the release asset to `destination`, verified against the size the
 * release reports and the SHA-256 the release's SHA256SUMS.txt lists. The file
 * appears at `destination` only once both match; until then it is `.part`.
 */
export async function downloadUpdate(update, destination, { fetcher = fetch, signal, onProgress, extraHosts = [] } = {}) {
  if (!update?.asset?.url || !update.sumsUrl) throw new Error('이 릴리스에는 검증 정보(SHA256SUMS)가 없습니다.');
  const sumsResponse = await trustedFetch(update.sumsUrl, { fetcher, signal, extraHosts });
  const sumsText = await sumsResponse.text();
  if (sumsText.length > 64 * 1024) throw new Error('검증 정보가 올바르지 않습니다.');
  const hash = expectedHash(sumsText, update.asset.name);
  if (!hash) throw new Error('검증 정보에 설치 파일이 없습니다.');
  const total = Number(update.asset.size) || 0;
  const response = await trustedFetch(update.asset.url, { fetcher, signal, extraHosts });
  const part = destination + '.part';
  const digest = createHash('sha256');
  const out = createWriteStream(part);
  let received = 0;
  const started = Date.now();
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (total && received > total) throw new Error('설치 파일 크기가 릴리스 정보와 다릅니다.');
      digest.update(value);
      if (!out.write(value)) await new Promise(resolve => out.once('drain', resolve));
      const seconds = Math.max(0.001, (Date.now() - started) / 1000);
      onProgress?.({ received, total, percent: total ? Math.floor(received / total * 100) : null, bytesPerSecond: received / seconds });
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
    if (total && received !== total) throw new Error('다운로드가 완료되지 않았습니다.');
    if (digest.digest('hex') !== hash) throw new Error('설치 파일 검증(SHA-256)에 실패했습니다. 다시 시도하세요.');
    await rm(destination, { force: true });
    await rename(part, destination);
    return { path: destination, sha256: hash, size: received };
  } catch (error) {
    out.destroy();
    await rm(part, { force: true }).catch(() => {});
    throw error;
  }
}
