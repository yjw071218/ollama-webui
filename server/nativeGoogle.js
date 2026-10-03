import { randomBytes, createHash } from 'node:crypto';

// Per-process, short-lived handoffs. The browser never receives the polling secret.
export function createGoogleHandoffs({ now = Date.now, ttl = 300000, limit = 1000 } = {}) {
  const pending = new Map();
  const hash = value => createHash('sha256').update(String(value)).digest('hex');
  const get = id => {
    const item = pending.get(id);
    if (!item || item.expires <= now()) { pending.delete(id); throw new Error('Login request expired. Start again in the app.'); }
    return item;
  };
  return {
    assertPending(id) { const item = get(id); if (item.credential || item.busy) throw new Error('Login already submitted.'); },
    start() {
      for (const [id, item] of pending) if (item.expires <= now()) pending.delete(id);
      if (pending.size >= limit) throw new Error('Too many pending login requests.');
      const id = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex');
      pending.set(id, { secret: hash(secret), expires: now() + ttl });
      return { id, secret };
    },
    async finish(id, credential, verify) {
      const item = get(id);
      if (item.credential || item.busy) throw new Error('Login already submitted.');
      item.busy = true;
      try {
        await verify(credential, id);
        if (get(id) !== item) throw new Error('Login request expired.');
        item.credential = credential;
      } finally { item.busy = false; }
    },
    poll(id, secret) {
      const item = get(id);
      if (hash(secret) !== item.secret) throw new Error('Invalid login proof.');
      if (!item.credential) return { pending: true };
      pending.delete(id);
      return { credential: item.credential };
    },
  };
}

export function nativeGooglePage(clientId) {
  const config = JSON.stringify(clientId).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>앱 Google 로그인</title><h1>앱 Google 로그인</h1>
<p>직접 앱에서 시작한 로그인일 때만 계속하세요. 로그인 후 앱으로 돌아가면 연결됩니다.</p>
<div id="button"></div><p id="status"></p>
<script>
const [id, appHint] = location.hash.slice(1).split('&');
history.replaceState(null, '', location.pathname);
const status = document.getElementById('status');
window.ready = () => {
  if (!/^[a-f0-9]{64}$/.test(id)) { status.textContent = '앱에서 로그인을 다시 시작하세요.'; return; }
  // Google itself decides whether this origin is allowed (the one registered in the console).
  status.textContent = 'Google 버튼이 오류를 표시하면 Google 콘솔의 승인된 JavaScript 원본에 ' + location.origin + ' 이 등록되어 있는지 확인하세요.';
  google.accounts.id.initialize({ client_id: ${config}, nonce: id, auto_select: false,
    callback: async ({credential}) => {
      try {
        const response = await fetch('/api/auth/native/finish', {method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,credential})});
        if (!response.ok) throw new Error('로그인 연결에 실패했습니다. 앱에서 다시 시작하세요.');
        document.getElementById('button').replaceChildren();
        status.textContent = '인증되었습니다. 앱으로 돌아가세요.';
      } catch (error) { status.textContent = error.message; }
    }
  });
  google.accounts.id.renderButton(document.getElementById('button'), {type:'standard',size:'large'});
};
</script><script src="https://accounts.google.com/gsi/client" onload="ready()" async defer></script></html>`;
}
