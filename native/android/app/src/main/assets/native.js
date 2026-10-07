(() => {
  if (window !== window.top || window.ollamaNative || !window.NativeHost) return;
  let next = 1;
  const pending = new Map();
  NativeHost.onmessage = event => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new DOMException(message.error, message.name || 'NotAllowedError'));
    else task.resolve(message.value);
  };
  const call = (method, args = {}) => new Promise((resolve, reject) => {
    const id = String(next++);
    const timer = setTimeout(() => { pending.delete(id); reject(new DOMException('요청 시간이 초과되었습니다.', 'AbortError')); }, 120000);
    pending.set(id, { resolve, reject, timer });
    NativeHost.postMessage(JSON.stringify({ id, method, ...args }));
  });
  const base64 = async blob => {
    if (blob.size > 20 * 1024 * 1024) throw new Error('앱 공유/저장은 파일당 20 MB까지 지원합니다.');
    return await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = reject;
      reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob);
    });
  };
  Object.defineProperty(window, 'ollamaNative', { value: Object.freeze({
    platform: 'android',
    changeServer: () => call('changeServer'),
    checkUpdates: () => call('checkUpdates'),
    captureScreen: async () => {
      const value = await call('capture');
      if (!value) return null;
      const bytes = Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
      return new File([bytes], 'screen-' + Date.now() + '.jpg', { type: 'image/jpeg' });
    },
  }) });
  // WebView has no OS share sheet; keep the familiar Web Share API.
  Object.defineProperty(navigator, 'canShare', { value: data => !data?.files || (data.files.length === 1 && data.files[0].size <= 20 * 1024 * 1024) });
  Object.defineProperty(navigator, 'share', { value: async data => {
    if (!navigator.canShare(data)) throw new TypeError('파일 한 개, 20 MB까지 공유할 수 있습니다.');
    const file = data.files?.[0];
    return call('share', { title: String(data.title || ''), text: String(data.text || ''), url: String(data.url || ''),
      file: file ? { name: file.name, type: file.type, data: await base64(file) } : null });
  } });
  Object.defineProperty(navigator, 'clipboard', { value: Object.freeze({
    writeText: text => call('clipboardWrite', { text: String(text) }),
    readText: () => call('clipboardRead'),
  }) });
  class NativeNotification {
    static permission = 'default';
    static async requestPermission(callback) {
      this.permission = await call('notificationPermission');
      callback?.(this.permission); return this.permission;
    }
    constructor(title, options = {}) {
      if (NativeNotification.permission !== 'granted') throw new DOMException('알림 권한이 필요합니다.', 'NotAllowedError');
      // The chat goes along, so tapping the notification opens it.
      const chat = options.data && options.data.chat != null ? String(options.data.chat) : '';
      call('notify', { title: String(title), body: String(options.body || ''), tag: String(options.tag || 'ollama'), chat }).catch(() => {});
    }
    close() {}
  }
  Object.defineProperty(window, 'Notification', { value: NativeNotification });
  // Status and navigation bars take the page's own background, so the app has
  // no frame of a different colour around the site. Re-sent on theme changes.
  let lastChrome = '';
  const sendChrome = () => {
    const css = getComputedStyle(document.body || document.documentElement).backgroundColor;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(css || '');
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return;
    const color = '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('');
    if (color === lastChrome) return;
    lastChrome = color;
    call('chrome', { color }).catch(() => {});
  };
  /* A class or style change on <html>/<body> comes in bursts (scroll locks,
     drawers, theme switches); the computed style is read once per frame, not
     once per change, since each read forces a style recalculation. */
  let queued = false;
  const queueChrome = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sendChrome(); });
  };
  const watchChrome = () => {
    sendChrome();
    const observer = new MutationObserver(queueChrome);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', queueChrome);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchChrome, { once: true });
  else watchChrome();
  window.addEventListener('load', sendChrome, { once: true });
  const saveLink = async (href, name) => {
    try {
      const blob = await fetch(href).then(r => r.blob());
      await call('save', { name: name || 'download', type: blob.type, data: await base64(blob) });
    } catch (error) { if (error?.message !== '저장을 취소했습니다.') alert(error.message); }
  };
  const savable = a => a && a.hasAttribute('download') && /^(blob:|data:)/.test(a.href);
  document.addEventListener('click', event => {
    const a = event.target.closest?.('a[download]');
    if (!savable(a)) return;
    event.preventDefault();
    saveLink(a.href, a.download);
  }, true);
  // Exports and backups click a link that was never put on the page
  // (App.jsx downloadBlob). Its click reaches no document listener, so the
  // click itself is answered here.
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.isConnected && savable(this)) { saveLink(this.href, this.download); return; }
    return click.call(this);
  };
})();