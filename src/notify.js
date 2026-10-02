/**
 * Telling somebody a long job finished, when they are not looking at it.
 *
 * ## Why
 *
 * A picture here is ninety seconds and a video is several minutes, and the
 * honest thing to do with that time is go and do something else. Which is
 * exactly what the app could not survive: switch tabs, lock the phone, and the
 * only way to find out whether the answer arrived was to come back and look.
 * `src/wakeLock.js` holds the screen on, which is a way of avoiding the
 * question rather than answering it.
 *
 * ## The sharp edges, all three of them
 *
 * **It is a secure-context API.** `Notification` does not exist on a page
 * served over plain HTTP to anything but localhost -- and this app is very
 * often opened over plain HTTP so a phone on the LAN can reach it. So the whole
 * feature has to degrade to nothing, silently, without the setting that turns
 * it on looking broken. `notifyState` is what the setting shows instead.
 *
 * **Permission is a one-shot.** A browser asks once; refused, it stays refused
 * until somebody changes it in site settings, and asking again does nothing at
 * all. So it is asked for when the reader turns the setting on -- an act that
 * means "yes, do this" -- and never on load.
 *
 * **A notification from a page dies with the page.** Android Chrome refuses
 * `new Notification()` outright and requires the service worker's, which
 * outlives the tab; a desktop browser allows both. So the worker is asked
 * first and the constructor is the fallback, rather than the other way around.
 */

export const notifySupported = () =>
  typeof window !== 'undefined' && typeof window.Notification === 'function';

/**
 * What can be said about notifications here: 'unsupported', 'default',
 * 'granted' or 'denied'.
 *
 * 'unsupported' is its own answer rather than a kind of 'denied', because the
 * two have different fixes: one is a browser setting, the other is serving this
 * app over HTTPS.
 */
export const notifyState = () => {
  if (!notifySupported()) return 'unsupported';
  try { return window.Notification.permission; } catch (e) { return 'unsupported'; }
};

/**
 * Ask, once, and say what the answer was.
 *
 * Returns the state afterwards, so a caller can put the switch back where it
 * was when the answer is no -- a toggle that stays on while nothing is ever
 * notified is worse than one that refuses to move.
 */
export const askToNotify = async () => {
  if (!notifySupported()) return 'unsupported';
  try {
    const already = window.Notification.permission;
    if (already !== 'default') return already;
    // Safari's older signature is callback-based and returns undefined.
    const answer = await new Promise((resolve) => {
      const returned = window.Notification.requestPermission(resolve);
      if (returned && typeof returned.then === 'function') returned.then(resolve, () => resolve('denied'));
    });
    return answer || window.Notification.permission;
  } catch (e) {
    return 'denied';
  }
};

/**
 * Put one up. Returns whether anything was actually shown.
 *
 * `tag` replaces rather than stacks: three pictures in a batch are one piece of
 * news, not three, and a phone that has to dismiss a notification per picture
 * is being punished for having gone away.
 */
export const notify = async (title, { body = '', tag = 'ollama-webui', icon = '/favicon.svg', data = null } = {}) => {
  if (notifyState() !== 'granted') return false;
  const options = { body, tag, icon, badge: icon, renotify: false, silent: false, ...(data ? { data } : {}) };
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return true;
    }
  } catch (e) { /* fall through to the page's own */ }
  try {
    // eslint-disable-next-line no-new
    new window.Notification(title, options);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * And the other half: a subscription, so it works with the app closed.
 *
 * A notification put up by the page needs the page. Close the tab, or lock the
 * phone long enough for the browser to discard it, and nothing is left running
 * to say anything -- which is exactly the wait this feature is for. Web Push
 * survives it: the browser's own push service holds a subscription and the
 * server wakes the worker. See server/push.js.
 *
 * `label` is what the notification should say. It travels with the
 * subscription because the worker has no translations of its own, and it is
 * the app that knows what language the reader chose. `labels` are the other
 * sentences it may need, by kind -- `cliReset` for a subscription CLI back
 * from its usage limit, with `{name}` for which one.
 *
 * Every step of this is allowed to be missing -- no worker, no PushManager (a
 * page served over plain http has none), no key from the server, a subscribe
 * that a browser refuses -- and none of them is an error worth reporting: the
 * in-page notifications carry on doing what they can.
 */
export const subscribeToPush = async (label = '', labels = null) => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (!registration?.pushManager) return false;
    const answer = await fetch('/api/push/key').then(r => r.json()).catch(() => null);
    const key = answer?.key;
    if (!key) return false;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      // Promised, and enforced: a browser that catches this app pushing
      // silently can revoke the permission outright.
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(key),
    });
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ subscription: subscription.toJSON(), label, ...(labels ? { labels } : {}) }),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
};

/** Stop pushing to this browser. The permission is left alone; it is not ours. */
export const unsubscribeFromPush = async () => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    const subscription = await registration?.pushManager?.getSubscription?.();
    if (!subscription) return false;
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => {});
    return await subscription.unsubscribe();
  } catch (e) {
    return false;
  }
};

/* `applicationServerKey` takes bytes, and the server sends the key as the
   base64url text that every other part of this protocol uses. */
export const base64UrlToBytes = (value) => {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};

/**
 * Is anybody looking?
 *
 * The rule for whether a finished job is worth interrupting for. A visible tab
 * has already shown the answer -- notifying about something on screen is noise,
 * and it is the single commonest way this kind of feature becomes something
 * people turn off.
 */
export const unattended = () =>
  typeof document === 'undefined' || document.visibilityState !== 'visible';
