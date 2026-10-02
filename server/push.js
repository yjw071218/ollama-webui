/**
 * "Your picture is ready", to a browser that is not open.
 *
 * ## What this is, and what the other half is
 *
 * `src/notify.js` is the half that works while the app is loaded in some tab
 * somewhere: it puts up a notification from the page. Close the tab, or lock
 * the phone long enough for the browser to discard the page, and there is
 * nothing left running to say anything. Web Push is the part that survives
 * that: the browser's own push service holds a subscription, this server sends
 * it a signed request, and the service wakes the service worker.
 *
 * ## No payload, on purpose
 *
 * A push *with* a body has to be encrypted to the subscription's own key
 * (aes128gcm, ECDH, HKDF) before it leaves here. That is a page of cryptography
 * whose failure mode is a notification that silently never arrives, and it
 * would be the only cryptography in this project written for one feature.
 *
 * A push with no payload needs none of it: a VAPID JWT, which is an ES256
 * signature `node:crypto` makes natively, and an empty POST. The worker is
 * woken with `event.data === null` and asks this server what just happened --
 * see the `push` handler in public/sw.js. The round trip costs a request that
 * only ever happens when something has actually finished.
 *
 * ## It needs HTTPS
 *
 * `PushManager` does not exist on a page served over plain http, which is how
 * this app is very often opened so a phone on the LAN can reach it. Nothing
 * here fails in that case; there simply are no subscriptions, and the in-page
 * notifications carry on doing what they can. See TLS_KEY_FILE in .env.example.
 */

import crypto from 'node:crypto';
import { database } from './db.js';

/* ------------------------------------------------------------- the identity

   One keypair for this server, made once and kept. The public half is what a
   browser is handed as `applicationServerKey`; change it and every existing
   subscription is dead, which is why it is stored rather than derived. */

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

let keys = null;

const readKeys = () => {
  const db = database();
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('push_vapid');
  if (row?.value) {
    try { return JSON.parse(row.value); } catch (e) { /* remade below */ }
  }
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const made = {
    // Uncompressed point, which is the only form `applicationServerKey` takes.
    publicKey: b64url(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('push_vapid', JSON.stringify(made));
  return made;
};

/** The public key a browser subscribes with; '' if one cannot be made. */
export const pushPublicKey = () => {
  try {
    if (!keys) keys = readKeys();
    return keys.publicKey;
  } catch (e) {
    return '';
  }
};

/** For the tests, and for a server whose keys have been wiped. */
export const forgetPushKeys = () => { keys = null; };

/* ------------------------------------------------------------ the VAPID JWT

   Signed for the *origin of the push service*, not for this app: that is what
   the spec asks for, and getting it wrong is a 401 from a service that says
   nothing else about why. Twelve hours, which is inside the 24 the spec allows
   and long enough that the clock being a few minutes out does not matter. */
export const vapidToken = (endpoint, subject, now = Date.now()) => {
  if (!keys) keys = readKeys();
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  }));
  const key = crypto.createPrivateKey({
    key: Buffer.from(keys.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  /* `ieee-p1363`, not DER. `crypto.sign` gives a DER-wrapped ECDSA signature by
     default and JWS wants the raw r||s pair; a DER one is rejected as a bad
     signature, which is a 401 with no clue in it. */
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${body}`), {
    key, dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${body}.${b64url(signature)}`;
};

/* ---------------------------------------------------------- who to send to */

export const rememberSubscription = (owner, subscription, label = '', now = Date.now()) => {
  const endpoint = String(subscription?.endpoint || '');
  // An endpoint is a URL a push service gave the browser. Anything else is
  // either a mistake or somebody asking this server to make requests for them.
  if (!/^https:\/\//.test(endpoint)) return false;
  database().prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, label, created_at, failed_at)
    VALUES (?,?,?,?,NULL)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, label = excluded.label, failed_at = NULL
  `).run(endpoint, String(owner || ''), String(label || '').slice(0, 1000), now);
  return true;
};

export const forgetSubscription = (endpoint) => {
  if (!endpoint) return false;
  return database().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint)).changes > 0;
};

export const subscriptionsFor = (owner) =>
  database().prepare('SELECT endpoint, label FROM push_subscriptions WHERE user_id = ?')
    .all(String(owner || ''));

/* What finished, for the worker to ask about when it is woken.
 *
 * In memory and one per account, because it answers exactly one question --
 * "what was that?" -- asked seconds after the push and never again. A missed
 * one is a notification that says something slightly general; it is not
 * something to keep a table for. */
const LAST_FINISHED = new Map();

export const noteFinished = (owner, kind, now = Date.now(), detail = {}) => {
  LAST_FINISHED.set(String(owner || ''), { ...detail, kind, at: now });
};

export const lastFinished = (owner) => LAST_FINISHED.get(String(owner || '')) || null;

/** For the tests. */
export const forgetFinished = () => LAST_FINISHED.clear();

/* A subscription's label is the sentence to show, or -- since the worker also
   has to say things other than "your answer is ready" and has no translations
   of its own -- a JSON object of sentences by kind, `ready` being the one for
   a finished answer. */
const labelsOf = (label) => {
  const text = String(label || '');
  if (!text.startsWith('{')) return text ? { ready: text } : {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) { return {}; }
};

/** The sentence this account's browsers asked to be told in; '' when none did. */
export const subscriptionLabel = (owner) => subscriptionsFor(owner).map(row => labelsOf(row.label).ready).find(Boolean) || '';

/** Every sentence this account's browsers handed over, by kind. */
export const subscriptionLabels = (owner) => Object.assign({}, ...subscriptionsFor(owner).map(row => labelsOf(row.label)).reverse());

/** What a subscription stores: the one sentence, or the sentences by kind. */
export const labelFor = (label, labels = null) => {
  const extra = labels && typeof labels === 'object'
    ? Object.fromEntries(Object.entries(labels).filter(([k, v]) => /^[a-zA-Z]{1,20}$/.test(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 160)]))
    : {};
  if (!Object.keys(extra).length) return String(label || '');
  return JSON.stringify({ ready: String(label || '').slice(0, 160), ...extra }).slice(0, 1000);
};

/* -------------------------------------------------------------- the sending

   Fire and forget, deliberately. Whatever finished has finished; a push that
   fails must not fail it, hold it up, or be retried into a queue this app does
   not have. The one failure worth acting on is 404/410, which means the
   subscription is dead for good and would otherwise be tried for ever. */
export const sendPush = async (owner, {
  subject = 'mailto:webui@localhost',
  fetchImpl = fetch,
  urgency = 'normal',
} = {}) => {
  const rows = subscriptionsFor(owner);
  if (rows.length === 0 || !pushPublicKey()) return 0;
  let sent = 0;
  await Promise.all(rows.map(async ({ endpoint }) => {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          TTL: '600',
          Urgency: urgency,
          // No body, so no `Content-Encoding` and no `Content-Length` beyond 0.
          Authorization: `vapid t=${vapidToken(endpoint, subject)}, k=${pushPublicKey()}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 404 || res.status === 410) forgetSubscription(endpoint);
      else if (res.ok) sent += 1;
    } catch (e) {
      // An unreachable push service is not this server's problem to solve.
    }
  }));
  return sent;
};
