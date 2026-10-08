import { tr } from './i18n.mjs';
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
      try { if (new URL(wc.getURL()).origin !== origin) return done(new Error(tr('신뢰하지 않는 주소로 이동했습니다.', 'The page went to an address that is not trusted.'))); }
      catch { return done(new Error(tr('페이지 주소를 확인할 수 없습니다.', 'The page address could not be read.'))); }
      done();
    };
    const failed = (_event, code, _description, _url, mainFrame) => {
      if (mainFrame === false || code === -3) return;
      done(new Error(tr('서버 페이지 로딩 실패 (코드 ' + code + '). 서버 연결 상태를 확인하세요.', 'The server page did not load (code ' + code + '). Check that the server is reachable.')));
    };
    const destroyed = () => done(new Error(tr('연결 창이 닫혔습니다.', 'The window was closed.')));
    const timer = setTimeout(() => done(new Error(tr('페이지가 로딩을 완료하지 못했습니다. 리디렉션·서버 상태·외부 인증 여부를 확인하세요.', 'The page did not finish loading. Check redirects, the server, and any outside sign-in.'))), timeoutMs);
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
