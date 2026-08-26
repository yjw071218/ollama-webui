// Deciding whether a request came from the same network as the server.
//
// This is what lets a phone on the house wifi open the address and just use it,
// while anything arriving from outside still has to present a token. The
// judgement is made on the socket's own peer address and nothing else:
// X-Forwarded-For is a request header, so trusting it would let any caller
// claim to be on the LAN.

// IPv4-mapped IPv6 (::ffff:192.168.0.5) is what Node reports on a dual-stack
// socket, and a link-local address can carry a zone suffix (fe80::1%eth0).
export const normaliseAddress = (address) => {
  let out = String(address || '').trim().toLowerCase();
  if (!out) return '';
  if (out.startsWith('::ffff:')) out = out.slice(7);
  const zone = out.indexOf('%');
  if (zone !== -1) out = out.slice(0, zone);
  return out;
};

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export const isPrivateAddress = (address) => {
  const addr = normaliseAddress(address);
  if (!addr) return false;

  const v4 = addr.match(V4);
  if (v4) {
    const [a, b] = v4.slice(1, 3).map(Number);
    if (v4.slice(1).some(n => Number(n) > 255)) return false;
    if (a === 127) return true;                        // loopback
    if (a === 10) return true;                         // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
    if (a === 192 && b === 168) return true;           // 192.168/16
    if (a === 169 && b === 254) return true;           // link-local
    return false;
  }

  if (addr === '::1' || addr === '::') return true;
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  return false;
};

// Every address this machine can be reached at, for printing at startup.
export const localAddresses = (interfaces) => {
  const out = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      const family = entry.family === 4 || entry.family === 'IPv4';
      if (!family || entry.internal) continue;
      if (normaliseAddress(entry.address).startsWith('169.254')) continue;
      out.push(entry.address);
    }
  }
  return out;
};
