# Running this as a real server

`npm run dev` is a development server. It serves unminified source over a
hot-reload socket and refuses most non-localhost origins on purpose. To reach
the app from another device — a phone, a laptop elsewhere — use the production
server in this folder instead.

```bash
npm run serve      # build, then start
# or
npm run build && npm start
```

It serves `dist/`, proxies Ollama and GPT-SoVITS, and exposes the same API the
dev server does, from one shared module (`server/api.js`) so the two cannot
drift apart.

---

## Read this before exposing it

Putting this on the open internet is not like publishing a static site. The
server proxies **your Ollama** and, if you let it, **reads and writes files on
your PC**. Three defaults exist because of that:

| | |
| --- | --- |
| **It refuses to start** bound to anything but loopback without `ACCESS_TOKEN` | The Ollama proxy would otherwise be an open LLM endpoint for anyone who found it |
| **`/localfs` is off** unless `ALLOW_LOCAL_FS=true` | Those routes read and write anywhere this process can reach. From localhost that is the point; from the internet it is remote file access on your machine |
| **Plain HTTP warns loudly** | The token and everything typed crosses the network unencrypted until TLS is in front |

Turn `ALLOW_LOCAL_FS` on only when every client is you.

---

## 1. Configure

In `.env` at the repository root:

```ini
HOST=0.0.0.0            # 127.0.0.1 keeps it on this machine
PORT=8080
ACCESS_TOKEN=           # required unless HOST is loopback — generate a long random one
ALLOW_LOCAL_FS=false
OLLAMA_URL=http://127.0.0.1:11434
```

Generate a token:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Starting without one prints a generated suggestion and exits.

Signing in once exchanges the token for a `HttpOnly` cookie, so it is not in
every later URL. A client can also send `X-Access-Token`.

## 2. Open the firewall

Windows blocks inbound connections to Node by default — this is why a server
that works on localhost is invisible to a phone on the same wifi.

```powershell
# elevated PowerShell
pwsh -File server/open-firewall.ps1
```

It prints every address the machine is reachable at. Test from your phone on
the same wifi before going any further; if that does not work, nothing beyond
it will.

## 3. Forward the port on the router

Everything so far only covers your own network. For access from outside, the
router has to send traffic in.

1. Open the router's admin page — usually the default gateway shown by
   `ipconfig` (commonly `192.168.0.1`, `192.168.1.1` or `192.168.45.1`).
2. Find **Port Forwarding** / **포트포워딩** / NAT.
3. Add: external port `8080` → this machine's LAN IP, internal port `8080`, TCP.
4. Give this machine a **static/reserved DHCP lease**, or the forward will point
   at the wrong device after a reboot.

**Check for CGNAT first.** Compare the router's WAN address with what
`curl https://api.ipify.org` says. If they differ, your ISP is sharing one
public address between customers and no port forward can work — ask them for a
public IP (many Korean ISPs offer one), or use a VPN such as Tailscale, which
needs no forwarding at all.

## 4. A domain

A home IP changes whenever the ISP feels like it, so a bare address is not
something to hand out. `duckdns.org` gives a free subdomain and an update
endpoint.

1. Sign in at <https://www.duckdns.org> (GitHub or Google), claim a subdomain,
   copy the token from the top of the page.
2. Add it to `.env`:

   ```ini
   DUCKDNS_DOMAIN=yourname
   DUCKDNS_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

3. Check it, then install the updater:

   ```powershell
   pwsh -File server/duckdns-update.ps1            # one-off
   pwsh -File server/duckdns-update.ps1 -Install   # every 5 min and at boot
   ```

`yourname.duckdns.org:8080` then reaches the app wherever the line has moved to.

*Already own a domain?* Point an A record at your public IP, or a CNAME at the
DuckDNS name so the updater still does the work.

## 5. HTTPS

Over plain HTTP the access token crosses the network in the clear. Once a domain
resolves to you, get a real certificate — [win-acme](https://www.win-acme.com/)
is the least painful on Windows:

```powershell
wacs.exe --target manual --host yourname.duckdns.org --store pemfiles --pemfilespath C:\certs
```

Then point `.env` at the result and restart:

```ini
TLS_KEY_FILE=C:\certs\yourname.duckdns.org-key.pem
TLS_CERT_FILE=C:\certs\yourname.duckdns.org-chain.pem
```

Renewal needs port 80 reachable, so forward that too. The server reads the
certificate at startup, so restart it after each renewal.

---

## Keeping it running

Nothing here daemonises. To have it survive a reboot, register the start command
as a scheduled task the same way the DuckDNS updater does:

```powershell
$action = New-ScheduledTaskAction -Execute 'node.exe' `
  -Argument 'server/index.js' -WorkingDirectory 'C:\path\to\ollama-webui'
Register-ScheduledTask -TaskName 'OllamaWebUI' -Action $action `
  -Trigger (New-ScheduledTaskTrigger -AtStartup) -RunLevel Highest
```

Ollama must be running too (`ollama serve`, or its own service).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Refusing to start` | `HOST` is not loopback and `ACCESS_TOKEN` is empty. This is the guard working |
| `Build not found` | `npm run build` has not been run |
| Works locally, not from a phone | Firewall — step 2 |
| Works on wifi, not from mobile data | Port forward, or CGNAT — step 3 |
| Sign-in loops | The cookie is dropped. Reach the server by exactly the host you signed in on |
| Model list empty | Ollama is not running, or `OLLAMA_URL` is wrong |
| `Local file access is disabled` | Working as intended; see the warning above before changing it |
