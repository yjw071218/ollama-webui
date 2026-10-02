import './webui-theme.css';
import { watchHostTheme } from './webui-theme.js';
watchHostTheme();
// Runs before any RisuAI module reads browser storage. Each WebUI account has
// a separate namespace, including localforage's auxiliary IndexedDB stores.
const scope = new URLSearchParams(location.search).get('scope') || 'guest';
const prefix = `webui-risu:${encodeURIComponent(scope)}:`;
const storage = window.localStorage;
const keys = () => Object.keys(storage).filter(key => key.startsWith(prefix));
const scopedStorage = {
  getItem: key => storage.getItem(prefix + key),
  setItem: (key, value) => storage.setItem(prefix + key, value),
  removeItem: key => storage.removeItem(prefix + key),
  clear: () => keys().forEach(key => storage.removeItem(key)),
  key: index => keys()[index]?.slice(prefix.length) ?? null,
  get length() { return keys().length; },
};
Object.defineProperty(window, 'localStorage', { value: scopedStorage });
const open = indexedDB.open.bind(indexedDB);
const remove = indexedDB.deleteDatabase.bind(indexedDB);
indexedDB.open = (name, ...args) => open(prefix + name, ...args);
indexedDB.deleteDatabase = name => remove(prefix + name);
if (window.BroadcastChannel) {
  const NativeChannel = window.BroadcastChannel;
  window.BroadcastChannel = class extends NativeChannel { constructor(name) { super(prefix + name); } };
}
const originalFetch = window.fetch.bind(window);
window.fetch = (resource, options = {}) => {
  const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
  if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/risuai/ollama/api/'))) {
    const headers = new Headers(options.headers || (resource instanceof Request ? resource.headers : undefined));
    const session = window.__WEBUI_SESSION__;
    if (session?.id) headers.set('X-Session-Id', session.id);
    if (session?.csrf) headers.set('X-CSRF-Token', session.csrf);
    return originalFetch(resource, { ...options, headers, credentials: 'same-origin' });
  }
  return originalFetch(resource, options);
};
// OPFS is deliberately disabled by the build adapter: its root is origin-wide.
await import('./main.ts');
