// Kakao's own sign-in pages, which must run inside the app window (exact hosts, HTTPS, default port).
const KAKAO_AUTH_HOSTS = new Set(['kauth.kakao.com', 'accounts.kakao.com', 'logins.kakao.com']);
export function kakaoAuthURL(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.port && !u.username && KAKAO_AUTH_HOSTS.has(u.hostname); }
  catch { return false; }
}

// A cancelled initial navigation is not success. Wait for a real trusted load.
export function loadTrustedPage(win, url, origin, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const wc = win.webContents;
    const cleanup = () => {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', finished);
      wc.removeListener('did-fail-load', failed);
      wc.removeListener('destroyed', destroyed);
    };
    const done = error => { cleanup(); error ? reject(error) : resolve(); };
    const finished = () => {
      try { if (new URL(wc.getURL()).origin !== origin) return done(new Error('신뢰하지 않는 주소로 이동했습니다.')); }
      catch { return done(new Error('페이지 주소를 확인할 수 없습니다.')); }
      done();
    };
    const failed = (_event, code, _description, _url, mainFrame) => {
      if (mainFrame === false || code === -3) return;
      done(new Error('서버 페이지 로딩 실패 (코드 ' + code + '). 서버 연결 상태를 확인하세요.'));
    };
    const destroyed = () => done(new Error('연결 창이 닫혔습니다.'));
    const timer = setTimeout(() => done(new Error('페이지가 로딩을 완료하지 못했습니다. 리디렉션·서버 상태·외부 인증 여부를 확인하세요.')), timeoutMs);
    wc.on('did-finish-load', finished);
    wc.on('did-fail-load', failed);
    wc.once('destroyed', destroyed);
    try {
      Promise.resolve(win.loadURL(url)).catch(error => {
        // Electron rejects the original load when a new navigation supersedes it.
        // Only did-finish-load above may turn that cancellation into success.
        if (error.code !== 'ERR_ABORTED' && error.errno !== -3) done(error);
      });
    } catch (error) { done(error); }
  });
}
