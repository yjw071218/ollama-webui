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

// Adapters whose networks exist only inside this machine. WSL, Docker, Hyper-V
// and the desktop hypervisors each add one, and every one of them has a real
// private address that a phone can never route to. Offering those as "open this
// on your phone" is worse than useless — it looks like the server is broken.
const VIRTUAL_INTERFACE = /vethernet|hyper-?v|wsl|virtualbox|vmware|docker|vboxnet|tap-windows|openvpn|tailscale|zerotier|loopback|bluetooth/i;

export const isVirtualInterface = (name) => VIRTUAL_INTERFACE.test(String(name || ''));

/**
 * Addresses this machine can be reached at, best first.
 *
 * `preferred` is the address the routing table actually uses to leave the
 * machine — the only fully reliable answer — and wins outright when given.
 * Everything else is ranked on how likely it is to be a real LAN: a physical
 * adapter beats a virtual one, and a home subnet beats the 172.16/12 range
 * where container networks tend to live.
 */
export const localAddresses = (interfaces, preferred = '') => {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const isV4 = entry.family === 4 || entry.family === 'IPv4';
      if (!isV4 || entry.internal) continue;
      const address = normaliseAddress(entry.address);
      // 169.254 means DHCP never answered; the adapter is up but unusable.
      if (!address || address.startsWith('169.254')) continue;
      found.push({ address: entry.address, name, virtual: isVirtualInterface(name) });
    }
  }

  const score = (entry) => {
    if (preferred && entry.address === preferred) return 0;
    if (entry.virtual) return 3;
    if (entry.address.startsWith('192.168.')) return 1;
    if (entry.address.startsWith('10.')) return 1;
    return 2;   // 172.16/12 and anything else
  };

  return found.sort((a, b) => score(a) - score(b));
};

/** Just the addresses, best first — the shape the old callers expected. */
export const localAddressList = (interfaces, preferred = '') =>
  localAddresses(interfaces, preferred).map(entry => entry.address);

/**
 * The address the operating system would use to leave this machine.
 *
 * Connecting a UDP socket sends nothing — it only asks the routing table which
 * local interface a packet to that destination would go out of. That is the
 * same decision the router made, so it identifies the real LAN adapter even on
 * a machine covered in virtual ones, and it needs no network access to work.
 */
export const routedAddress = async () => {
  try {
    const dgram = await import('node:dgram');
    return await new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const done = (value) => {
        try { socket.close(); } catch (e) { /* already closed */ }
        resolve(value);
      };
      socket.on('error', () => done(''));
      // Any routable address works; nothing is actually sent to it.
      socket.connect(53, '8.8.8.8', () => {
        try { done(socket.address().address || ''); } catch (e) { done(''); }
      });
      setTimeout(() => done(''), 500);
    });
  } catch (e) {
    return '';
  }
};
