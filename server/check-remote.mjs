// Works through the chain that has to hold for the app to be reachable from
// outside the house, and stops at the first thing that is actually wrong.
//
// Each step fails for a different reason and needs a different fix, so a bare
// "it doesn't work" is not useful. Run it with:
//
//   node server/check-remote.mjs
//
// Nothing here changes any setting; it only looks.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localAddresses, routedAddress } from './net.js';
import { readEnvValue } from './envFile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.existsSync(path.join(ROOT, '.env'))
  ? fs.readFileSync(path.join(ROOT, '.env'), 'utf-8') : '';

const PORT = Number(readEnvValue(env, 'PORT') || 5173);
const HOST = readEnvValue(env, 'HOST') || '0.0.0.0';
const DOMAIN = readEnvValue(env, 'DUCKDNS_DOMAIN');

const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg, fix) => { console.log(`  FAIL  ${msg}`); if (fix) console.log(`        ${fix}`); };
const note = (msg) => console.log(`        ${msg}`);

const canConnect = (host, port, ms = 5000) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(ms);
  socket.on('connect', () => done(true));
  socket.on('timeout', () => done(false));
  socket.on('error', () => done(false));
});

const publicIp = async () => {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(8000) });
    return (await res.text()).trim();
  } catch (e) {
    return '';
  }
};

const firewallPort = () => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-Command',
    "(Get-NetFirewallRule -DisplayName 'Ollama WebUI' -ErrorAction SilentlyContinue | " +
    'Get-NetFirewallPortFilter).LocalPort'],
  { timeout: 15000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
});

console.log('');
console.log(`Checking remote access for port ${PORT}`);
console.log('');

// 1 ── is it even running, and bound where other machines can see it
console.log('1. The server');
if (HOST === '127.0.0.1' || HOST === 'localhost') {
  bad(`HOST is ${HOST}, so it only listens to this machine.`,
    'Set HOST=0.0.0.0 in .env and restart.');
} else {
  ok(`HOST=${HOST}`);
}
if (await canConnect('127.0.0.1', PORT, 2000)) ok(`something is listening on ${PORT}`);
else bad(`nothing is listening on ${PORT}.`, 'Start it with start_ollama_webui.bat.');

// 2 ── the LAN address, and whether Windows will let anything in
console.log('');
console.log('2. This network');
const preferred = await routedAddress();
const usable = localAddresses(os.networkInterfaces(), preferred).filter(e => !e.virtual);
if (usable.length === 0) {
  bad('no usable network adapter found.');
} else {
  for (const entry of usable) ok(`http://${entry.address}:${PORT}   (${entry.name})`);
}

const rulePort = await firewallPort();
if (!rulePort) {
  bad('no firewall rule named "Ollama WebUI".',
    'Run: pwsh -File server/open-firewall.ps1   (as administrator)');
} else if (!String(rulePort).split(/\s*,\s*/).includes(String(PORT))) {
  bad(`the firewall rule allows port ${rulePort}, not ${PORT}.`,
    'Run: pwsh -File server/open-firewall.ps1   (as administrator)');
} else {
  ok(`the firewall allows ${PORT}`);
}

// 3 ── the part that is on the router, and the part that is on the ISP
console.log('');
console.log('3. From outside');
const wan = await publicIp();
if (!wan) {
  bad('could not look up the public address (no internet?).');
} else {
  ok(`public address ${wan}`);

  const lan = preferred || usable[0]?.address || '';
  const cgnat = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (cgnat.test(wan)) {
    bad('that public address is itself private — your ISP is using CGNAT.',
      'No port forward can work. Ask the ISP for a public IP, or use a VPN like Tailscale.');
  } else if (lan) {
    note(`forward external ${PORT} -> ${lan}:${PORT} (TCP) on the router at`);
    note(`your default gateway, and give this PC a reserved DHCP lease.`);
  }

  const reachable = await canConnect(wan, PORT, 6000);
  if (reachable) {
    ok(`${wan}:${PORT} accepts connections`);
    note('Note: many routers refuse to loop back to your own public address,');
    note('so a failure here can still work from mobile data. Test on a phone');
    note('with wifi turned off.');
  } else {
    bad(`${wan}:${PORT} did not accept a connection.`,
      'Either the port forward is missing, or the router does not loop back.');
    note('Test from a phone with wifi off before concluding it is broken.');
  }
}

// 4 ── the name, if one is configured
if (DOMAIN) {
  console.log('');
  console.log('4. Domain');
  try {
    const dns = await import('node:dns/promises');
    const [resolved] = await dns.resolve4(`${DOMAIN}.duckdns.org`);
    if (resolved === wan) ok(`${DOMAIN}.duckdns.org -> ${resolved}`);
    else bad(`${DOMAIN}.duckdns.org points at ${resolved}, but you are ${wan}.`,
      'Run: pwsh -File server/duckdns-update.ps1');
  } catch (e) {
    bad(`${DOMAIN}.duckdns.org does not resolve.`, 'Run: pwsh -File server/duckdns-update.ps1');
  }
}

console.log('');
