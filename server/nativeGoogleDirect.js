// Google OIDC implicit ID-token flow: no client secret or embedded user-agent.
// Enable only after registering the exact callback URI in Google Cloud.
export function googleNativeRedirect(env = {}) {
  const value = String(env.GOOGLE_NATIVE_REDIRECT_URI || '').trim();
  if (!value) return '';
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash
    || url.pathname !== '/api/auth/native/google/callback')
    throw new Error('GOOGLE_NATIVE_REDIRECT_URI must be HTTPS and end with /api/auth/native/google/callback (HTTP is allowed only on localhost).');
  return url.href;
}
const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
export function nativeGoogleDirectPage(clientId, redirectUri) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Google 계정 연결</title><p id="status">Google 계정 선택 화면으로 이동 중…</p>
<script>
try {
  const [id] = location.hash.slice(1).split('&');
  history.replaceState(null, '', location.pathname);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('앱에서 로그인을 다시 시작하세요.');
  const redirectUri = ${json(redirectUri)};
  if (new URL(redirectUri).origin !== location.origin) throw new Error('앱 서버 주소와 Google 콜백의 원본이 다릅니다. 등록한 HTTPS 서버 주소로 연결하세요.');
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('native-google:' + state, JSON.stringify({id, expires: Date.now() + 300000}));
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({client_id: ${json(clientId)}, redirect_uri: redirectUri,
    response_type: 'id_token', response_mode: 'fragment', scope: 'openid email profile',
    nonce: id, state, prompt: 'select_account'});
  location.replace(target.href);
} catch (error) { document.getElementById('status').textContent = error.message; }
</script></html>`;
}
export function nativeGoogleCallbackPage() {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Google 계정 연결</title><p id="status">인증 확인 중…</p>
<script>
(async () => {
  const params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);
  const status = document.getElementById('status');
  try {
    const state = params.get('state');
    if (!/^[a-f0-9]{64}$/.test(state || '')) throw new Error('로그인 요청을 확인할 수 없습니다. 앱에서 다시 시작하세요.');
    const key = 'native-google:' + state;
    const pending = JSON.parse(sessionStorage.getItem(key) || 'null');
    sessionStorage.removeItem(key);
    if (!pending || pending.expires <= Date.now() || !/^[a-f0-9]{64}$/.test(pending.id))
      throw new Error('로그인이 만료되었거나 다른 브라우저에서 시작되었습니다. 앱에서 다시 시도하세요.');
    if (params.get('error')) throw new Error('로그인이 취소되었거나 거부되었습니다. 앱에서 다시 시도하세요.');
    const credential = params.get('id_token');
    if (!credential) throw new Error('Google 인증 결과가 없습니다.');
    const response = await fetch('/api/auth/native/finish', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: pending.id, credential}),
      signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('앱 인증 연결에 실패했습니다. 앱에서 다시 시도하세요.');
    status.textContent = '로그인되었습니다. 이 탭을 닫고 앱으로 돌아가세요.';
    window.close();
  } catch (error) { status.textContent = error.message; }
})();
</script></html>`;
}
