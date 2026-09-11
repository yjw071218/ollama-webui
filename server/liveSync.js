// Telling the account's other devices that something changed, the moment it does.
//
// Without this, a device finds out by asking. The poll is every fifteen
// seconds and it is suspended whenever the page is not visible, which on a
// desktop is a detail and on a phone is most of the time: the screen goes off,
// the browser is switched away from, the timer is frozen. So the phone learns
// about a change on the laptop when you next pick it up *and* wait out the
// interval, which is why two computers side by side felt instant and the phone
// did not. (The two computers were not even syncing through the account —
// windows of one browser share the same local database.)
//
// What travels is a revision number, not the change. A record could be eight
// megabytes and there may be several; the client already knows how to fetch
// exactly what it is missing, and all it was ever short of was the knowledge
// that it was missing something. So this stays a doorbell, and the door is the
// existing /api/auth/sync.
//
// Server-sent events rather than a socket: this is one-way, it is a plain GET,
// it reconnects by itself when a phone changes network, and it needs nothing
// on top of the HTTP server that is already here.

/** Open streams, as `userId -> Set<res>`. Empty user entries are removed. */
const listeners = new Map();

// Long enough not to be chatty, short enough to beat the idle timeout of any
// proxy or phone network that would otherwise drop a silent connection.
const HEARTBEAT_MS = 25000;

// One account can have several devices and several tabs on each. The cap is
// what stops a client stuck in a reconnect loop from holding a thousand
// sockets open; the oldest goes, because it is the one most likely already
// dead in a way the server has not noticed yet.
const MAX_PER_USER = 24;

const write = (res, payload) => {
  try { res.write(payload); return true; } catch (e) { return false; }
};

/**
 * Attach a response to an account's stream, and detach it when it ends.
 *
 * The returned function is only for the caller that wants to hang up early;
 * a client that disappears cleans itself up through `close`.
 */
export const addListener = (userId, req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Anything that buffers a response defeats the entire point of one that is
  // never going to end. nginx reads this one; `no-transform` above covers the
  // rest of them.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // A comment line. It is ignored by EventSource and it is what proves the
  // connection is open before anything has happened on it, so the client can
  // stop polling straight away rather than after the first change.
  write(res, `: connected\n\nretry: 3000\n\n`);

  let set = listeners.get(userId);
  if (!set) { set = new Set(); listeners.set(userId, set); }

  while (set.size >= MAX_PER_USER) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    try { oldest.end(); } catch (e) { /* already gone */ }
  }
  set.add(res);

  const beat = setInterval(() => {
    if (!write(res, ': ping\n\n')) close();
  }, HEARTBEAT_MS);
  // Node should not stay alive for a heartbeat.
  beat.unref?.();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    const current = listeners.get(userId);
    if (current) {
      current.delete(res);
      if (current.size === 0) listeners.delete(userId);
    }
    try { res.end(); } catch (e) { /* already gone */ }
  };

  req.on('close', close);
  req.on('error', close);
  res.on('close', close);
  res.on('error', close);

  return close;
};

/**
 * Tell an account's devices that its revision moved.
 *
 * `origin` is the session that made the change, echoed back so the device that
 * wrote it can recognise its own doorbell and not go fetch what it already
 * has. Everyone else sees a revision newer than theirs and syncs.
 */
export const publishRev = (userId, rev, origin = '') => {
  const set = listeners.get(userId);
  if (!set || set.size === 0) return 0;

  const frame = `event: rev\ndata: ${JSON.stringify({ rev, origin })}\n\n`;
  let delivered = 0;
  for (const res of [...set]) {
    if (write(res, frame)) delivered++;
    else { set.delete(res); try { res.end(); } catch (e) { /* gone */ } }
  }
  if (set.size === 0) listeners.delete(userId);
  return delivered;
};

/** How many streams an account has open. Exposed for tests and diagnostics. */
export const listenerCount = (userId) => listeners.get(userId)?.size || 0;

/** Hang up on everyone. Used when an account is deleted, and by tests. */
export const dropListeners = (userId) => {
  const set = userId == null ? null : listeners.get(userId);
  const all = set ? [set] : [...listeners.values()];
  for (const s of all) for (const res of [...s]) { try { res.end(); } catch (e) { /* gone */ } }
  if (userId == null) listeners.clear(); else listeners.delete(userId);
};
