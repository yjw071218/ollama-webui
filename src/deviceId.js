/**
 * This browser's (or app's) device id, kept in localStorage and mirrored into
 * the `webui_device` cookie so every request -- navigations included -- tells
 * the server which device it comes from. See server/devices.js.
 */
const KEY = 'webui-device-id';

const make = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const deviceId = (() => {
  let id = '';
  try { id = localStorage.getItem(KEY) || ''; } catch (e) { /* private mode */ }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = make();
    try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ }
  }
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `webui_device=${id}; Path=/; Max-Age=${60 * 60 * 24 * 400}; SameSite=Lax${secure}`;
  } catch (e) { /* no cookies */ }
  return id;
})();
