/**
 * Keep synced records under the server's 8 MB limit without dropping data.
 *
 * Large strings inside a record -- attached photos as data URLs or base64,
 * extracted documents -- are uploaded once to /api/auth/sync/blob by SHA-256
 * and replaced in the *uploaded copy* with `webui-blob:v1:<hash>`. The local
 * copy keeps its bytes. A device receiving the record fetches every marker
 * back before storing it, so the rest of the app sees the original value.
 */
import { authHeaders } from './session.jsx';

export const BLOB_PREFIX = 'webui-blob:v1:';
const MIN_BYTES = 64 * 1024;          // smaller strings are not worth a request
export const SLIM_ABOVE = 6 * 1024 * 1024; // leave headroom under the 8 MB record limit

const encoder = new TextEncoder();
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

const url = (hash) => `/api/auth/sync/blob?hash=${hash}`;

const upload = async (text, known) => {
  const bytes = encoder.encode(text);
  const hash = await sha256(bytes);
  if (known.has(hash)) return hash;
  const head = await fetch(url(hash), { method: 'HEAD', credentials: 'same-origin', headers: authHeaders('HEAD') });
  if (!head.ok) {
    const put = await fetch(url(hash), {
      method: 'PUT', credentials: 'same-origin',
      headers: { ...authHeaders('PUT'), 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
    if (!put.ok) throw new Error(`첨부 데이터 업로드 실패 (HTTP ${put.status})`);
  }
  known.add(hash);
  return hash;
};

/** A copy of `value` with every large string replaced by a blob marker. */
export const slimPayload = async (value, known = new Set()) => {
  if (typeof value === 'string') {
    return value.length >= MIN_BYTES ? BLOB_PREFIX + await upload(value, known) : value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await slimPayload(item, known));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = await slimPayload(item, known);
    return out;
  }
  return value;
};

const hasMarker = (value) => typeof value === 'string'
  ? value.startsWith(BLOB_PREFIX)
  : Array.isArray(value) ? value.some(hasMarker)
    : value && typeof value === 'object' ? Object.values(value).some(hasMarker) : false;

/** The record's original value, every marker fetched back. A missing blob stays a marker. */
export const restorePayload = async (value, cache = new Map()) => {
  if (!hasMarker(value)) return value;
  if (typeof value === 'string') {
    const hash = value.slice(BLOB_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(hash)) return value;
    if (!cache.has(hash)) {
      cache.set(hash, fetch(url(hash), { credentials: 'same-origin', headers: authHeaders('GET') })
        .then(r => (r.ok ? r.text() : value)).catch(() => value));
    }
    return cache.get(hash);
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => restorePayload(item, cache)));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = await restorePayload(item, cache);
  return out;
};
