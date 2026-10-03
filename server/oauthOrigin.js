// OAuth callback configuration belongs to the server, not a WebView's loopback origin.
export function kakaoCallbackUri(req, env = {}) {
  const explicit = String(env.KAKAO_REDIRECT_URI || '').trim();
  const publicOrigin = String(env.PUBLIC_ORIGIN || '').trim();
  const fallback = (req.socket?.encrypted ? 'https://' : 'http://') + req.headers.host;
  const url = new URL(explicit || (publicOrigin || fallback));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('OAuth callback must be an HTTP(S) URL without credentials, query or fragment.');
  if (explicit && url.pathname !== '/kakao/callback') throw new Error('KAKAO_REDIRECT_URI must end with /kakao/callback.');
  url.pathname = '/kakao/callback';
  return url.href;
}
export function oauthStateCookie(value, secure = false, clear = false) {
  return 'webui_kakao_state=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (clear ? '0' : '600') + (secure ? '; Secure' : '');
}
export function matchingStateCookie(req, state) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(state)) return false;
  return String(req.headers.cookie || '').split(';').some(value => value.trim() === 'webui_kakao_state=' + state);
}
