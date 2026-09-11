// The one address everybody should be using.
//
// A browser keys IndexedDB, localStorage and cookies to an *origin* — scheme,
// host and port together. Two addresses that reach the same server are still
// two origins if the host differs, and the browser treats them as two unrelated
// websites: two sets of chats, two sets of settings, two logins. Nothing in the
// server can change that, and nothing should be able to; it is the rule that
// stops one website reading another's data.
//
// The server's own database is not affected and never was. `server/data/webui.db`
// is one file, opened by one process, and every origin this server answers on
// reads and writes the same rows. What splits is the copy each browser keeps,
// and the cookie that says who you are signed in as.
//
// So the fix is not to merge two origins. It is to have one. The launcher used
// to open the desktop browser on `http://localhost:5173` while telling the phone
// to use `http://<address>.nip.io:5173`, which made the split by hand: the same
// person on the same server, signed in twice, with two local caches that only
// the account sync ever brought together.
//
// `PUBLIC_ORIGIN` in .env names the address everything should use. It is a
// preference, not a restriction — every other address still works, because a
// server that refuses the address you can actually reach is worse than one that
// costs you a second login.

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/**
 * Normalise what someone put in .env into a real origin.
 *
 * Everything about the value is optional except the host, because everything
 * else can be worked out from the server it is being read on. All of these mean
 * the same thing on a plain-HTTP server on port 5173:
 *
 *   203.0.113.7.nip.io
 *   203.0.113.7.nip.io:5173
 *   http://203.0.113.7.nip.io:5173
 *   http://203.0.113.7.nip.io:5173/      (a path is not part of an origin)
 *
 * Returns '' for anything unusable — empty, whitespace, or not a host at all.
 * An empty answer means "no canonical address is configured", which is a
 * perfectly good state and the one every existing install is in.
 */
export const normaliseOrigin = (value, { scheme = 'http', port = 5173 } = {}) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  // A bare host has no `//`, and `new URL` would read the first colon as a
  // scheme separator — turning `example.com:5173` into scheme `example.com`.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${scheme}://${raw}`;

  let url;
  try { url = new URL(withScheme); } catch (e) { return ''; }
  if (!url.hostname) return '';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';

  // Whether a port was *written*, which `url.port` cannot answer: it is empty
  // both for `http://x` and for `http://x:80`, because a default port is not
  // part of the serialised origin. The difference matters here — one means
  // "use the server's port" and the other means "80, explicitly" — so it is
  // read off the authority instead. Userinfo is dropped first (it can contain
  // a colon) and an IPv6 literal's colons live inside brackets, so only a
  // trailing `:digits` counts.
  const afterScheme = withScheme.slice(withScheme.indexOf('://') + 3);
  const authority = afterScheme.split(/[/?#]/)[0];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const written = /:\d+$/.test(hostPort);

  const chosen = written
    ? (url.port || DEFAULT_PORTS[url.protocol])
    : String(port);

  // A default port is left off, because a browser leaves it off: `http://x`
  // and `http://x:80` are one origin and `window.location.origin` reports the
  // short form. Emitting the long one would make the app's comparison fail
  // against the very address it was told to use.
  const omit = DEFAULT_PORTS[url.protocol] === chosen;

  // `hostname` already carries an IPv6 literal's brackets, so it is used as it
  // stands -- adding a pair would produce `[[::1]]`.
  return `${url.protocol}//${url.hostname}${omit ? '' : `:${chosen}`}`;
};

/**
 * Whether a browser sitting on `origin` is on the canonical one.
 *
 * Compared as strings deliberately: an origin *is* the string, and two that
 * differ by so much as the port are two storage buckets. With no canonical
 * origin configured every address is equally right, so nothing is out of place.
 */
export const isCanonical = (canonical, origin) => !canonical || canonical === origin;
