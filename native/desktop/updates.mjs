// Public release metadata only. Never send server addresses, cookies or credentials.
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
export function selectUpdate(releases, current, platform = 'windows') {
  if (!Array.isArray(releases)) return null;
  const extension = platform === 'android' ? '.apk' : '-Setup.exe';
  return releases.filter(r => !r.draft && !r.prerelease && /^native-v/.test(r.tag_name)
    && newer(r.tag_name, current)
    && r.assets?.some(a => a.state === 'uploaded' && a.name?.startsWith('OllamaWebUI-Client-') && a.name.endsWith(extension)))
    .sort((a, b) => newer(a.tag_name, b.tag_name) ? -1 : newer(b.tag_name, a.tag_name) ? 1 : 0)
    .map(r => ({ version: r.tag_name.slice(8), url: base + 'tag/' + encodeURIComponent(r.tag_name) }))[0] || null;
}
export async function checkUpdate(current, fetcher = fetch) {
  // Native releases are not marked "latest": do not use /releases/latest.
  const response = await fetcher('https://api.github.com/repos/' + repository + '/releases?per_page=100', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OllamaWebUI-Client' },
    signal: AbortSignal.timeout(8000), redirect: 'error',
  });
  if (!response.ok) throw new Error('업데이트 확인 HTTP ' + response.status);
  return selectUpdate(await response.json(), current);
}
