import { randomBytes, createHash } from 'node:crypto';
import { authPage, STATUS_HELPER } from './nativeAuthPage.js';

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
  return authPage({
    title: 'Google 계정으로 로그인',
    lead: '아래 버튼으로 계정을 고르면 앱이 자동으로 로그인됩니다.',
    body: '<div id="button"></div>',
    status: 'Google 버튼을 불러오는 중…',
    state: 'working',
    script: `${STATUS_HELPER}
const [id, appHint] = location.hash.slice(1).split('&');
history.replaceState(null, '', location.pathname);
window.ready = () => {
  if (!/^[a-f0-9]{64}$/.test(id)) { say('로그인 요청을 찾을 수 없습니다. 앱에서 로그인을 다시 시작하세요.', 'error'); return; }
  // Google itself decides whether this origin is allowed (the one registered in the console).
  say('버튼에 오류가 보이면 Google 콘솔의 승인된 JavaScript 원본에 ' + location.origin + ' 이 등록되어 있는지 확인하세요.', '');
  google.accounts.id.initialize({ client_id: ${config}, nonce: id, auto_select: false,
    callback: async ({credential}) => {
      say('앱에 연결하는 중…', 'working');
      try {
        const response = await fetch('/api/auth/native/finish', {method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,credential})});
        if (!response.ok) throw new Error('로그인 연결에 실패했습니다. 앱에서 다시 시작하세요.');
        document.getElementById('button').replaceChildren();
        say('로그인되었습니다. 이 창을 닫고 앱으로 돌아가세요.', 'ok');
      } catch (error) { say(error.message, 'error'); }
    }
  });
  google.accounts.id.renderButton(document.getElementById('button'), {type:'standard',size:'large',shape:'pill',text:'continue_with',locale:'ko',width:300});
};`,
    after: '<script src="https://accounts.google.com/gsi/client" onload="ready()" async defer></script>',
  });
}
