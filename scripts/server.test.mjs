// Covers the two pure pieces the launcher depends on: deciding whether a
// request came from the same network, and editing .env in place.
import { rolldown } from 'rolldown';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = async (entry, out) => {
  const bundle = await rolldown({ input: path.resolve(HERE, entry), platform: 'neutral' });
  const file = path.resolve(HERE, out);
  await bundle.write({ file, format: 'esm' });
  await bundle.close();
  return import(pathToFileURL(file).href);
};

const N = await load('../server/net.js', '../node_modules/.net-test.mjs');
const E = await load('../server/envFile.js', '../node_modules/.envfile-test.mjs');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ------------------------------------------------------------- addresses
// This decides who skips the access token, so a wrong answer either locks the
// owner out or lets the internet in.
for (const [addr, want] of [
  ['127.0.0.1', true], ['::1', true], ['::', true],
  ['192.168.45.95', true], ['192.168.0.1', true],
  ['10.0.0.5', true], ['10.255.255.255', true],
  ['172.16.0.1', true], ['172.31.255.254', true],
  ['172.15.0.1', false], ['172.32.0.1', false],   // just outside 172.16/12
  ['169.254.1.1', true],
  ['::ffff:192.168.1.9', true], ['::ffff:8.8.8.8', false],
  ['fe80::1%eth0', true], ['fd00::1', true], ['fc00::abcd', true],
  ['8.8.8.8', false], ['1.1.1.1', false], ['2001:4860:4860::8888', false],
  ['', false], [null, false], [undefined, false],
  ['999.1.1.1', false], ['not-an-address', false],
  ['192.168.1', false],
]) {
  eq(`${JSON.stringify(addr)} private`, N.isPrivateAddress(addr), want);
}

eq('an ipv4-mapped address is unwrapped', N.normaliseAddress('::FFFF:10.0.0.1'), '10.0.0.1');
eq('a zone suffix is dropped', N.normaliseAddress('fe80::1%eth0'), 'fe80::1');
eq('a missing address normalises to empty', N.normaliseAddress(undefined), '');

// The shape a Windows PC with WSL installed actually reports. Handing out the
// Hyper-V address as "open this on your phone" is what sent someone to an
// address nothing outside the PC can route to.
const interfaces = {
  '이더넷': [
    { address: '192.168.45.95', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.28.32.1', family: 'IPv4', internal: false }],
  'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  'Wi-Fi 5': [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
};

const found = N.localAddressList(interfaces);
check('the real adapter is listed', found.includes('192.168.45.95'));
check('loopback is not', !found.includes('127.0.0.1'));
check('ipv6 is not', !found.some(a => a.includes(':')));
check('an unconfigured link-local is not', !found.some(a => a.startsWith('169.254')));
eq('no interfaces is not a crash', N.localAddressList(null).length, 0);

const ranked = N.localAddresses(interfaces);
eq('the physical adapter comes first', ranked[0].address, '192.168.45.95');
check('the WSL adapter is flagged virtual', ranked.find(e => e.address === '172.28.32.1').virtual);
check('the physical one is not', !ranked.find(e => e.address === '192.168.45.95').virtual);

// The routing table's answer wins outright, whatever the ranking guessed.
const preferred = N.localAddresses(interfaces, '172.28.32.1');
eq('a routed address is put first', preferred[0].address, '172.28.32.1');

for (const [name, want] of [
  ['vEthernet (WSL (Hyper-V firewall))', true],
  ['vEthernet (Default Switch)', true],
  ['VirtualBox Host-Only Network', true],
  ['VMware Network Adapter VMnet1', true],
  ['Docker Desktop', true],
  ['TAP-Windows Adapter V9', true],
  ['Tailscale', true],
  ['Bluetooth Network Connection', true],
  ['Wi-Fi', false],
  ['이더넷', false],
  ['Ethernet', false],
  ['eth0', false],
  ['en0', false],
  ['', false],
]) {
  eq(`${JSON.stringify(name)} virtual`, N.isVirtualInterface(name), want);
}

// ---------------------------------------------------------------- .env
// The bug this replaced: /^\s*KEY\s*=\s*(.*)$/m walks over a blank line and
// captures the next line, so an empty key reads as set.
const EXAMPLE = [
  '# Settings',
  'HOST=127.0.0.1',
  'PORT=8080',
  '',
  '# Required as soon as HOST is not loopback.',
  'ACCESS_TOKEN=',
  '',
  '# The /localfs routes read and write anywhere this process can reach.',
  'ALLOW_LOCAL_FS=false',
].join('\n');

eq('an empty value reads as empty, not as the next line', E.readEnvValue(EXAMPLE, 'ACCESS_TOKEN'), '');
eq('a set value reads back', E.readEnvValue(EXAMPLE, 'HOST'), '127.0.0.1');
eq('a later key still reads', E.readEnvValue(EXAMPLE, 'ALLOW_LOCAL_FS'), 'false');
eq('an absent key is empty', E.readEnvValue(EXAMPLE, 'NOPE'), '');
eq('the same with CRLF', E.readEnvValue(EXAMPLE.replace(/\n/g, '\r\n'), 'ACCESS_TOKEN'), '');
eq('CRLF does not leave a stray return', E.readEnvValue('HOST=0.0.0.0\r\nPORT=1\r\n', 'HOST'), '0.0.0.0');
eq('surrounding spaces are ignored', E.readEnvValue('  HOST = 1.2.3.4  ', 'HOST'), '1.2.3.4');
eq('quotes are stripped', E.readEnvValue('TOKEN="abc"', 'TOKEN'), 'abc');
eq('a trailing comment is not the value', E.readEnvValue('PORT=8080  # default', 'PORT'), '8080');
eq('a hash inside a token survives', E.readEnvValue('TOKEN=ab#cd', 'TOKEN'), 'ab#cd');
eq('a commented-out key is not set', E.readEnvValue('# HOST=1.2.3.4', 'HOST'), '');

eq('writing replaces in place', E.readEnvValue(E.writeEnvValue(EXAMPLE, 'PORT', '9000'), 'PORT'), '9000');
check('replacing keeps the other keys',
  E.readEnvValue(E.writeEnvValue(EXAMPLE, 'PORT', '9000'), 'HOST') === '127.0.0.1');
check('replacing keeps the comments', E.writeEnvValue(EXAMPLE, 'PORT', '9000').includes('# Settings'));
eq('a new key is appended', E.readEnvValue(E.writeEnvValue(EXAMPLE, 'NEW_KEY', 'x'), 'NEW_KEY'), 'x');
eq('appending to an empty file works', E.readEnvValue(E.writeEnvValue('', 'HOST', '0.0.0.0'), 'HOST'), '0.0.0.0');
eq('a key is written once, not twice',
  (E.writeEnvValue(EXAMPLE, 'PORT', '9000').match(/^PORT=/gm) || []).length, 1);

// prepareEnv: what the launcher runs.
const token = () => 'GENERATED-TOKEN';
const first = E.prepareEnv(EXAMPLE, { forNetwork: true, makeToken: token });
eq('a loopback HOST is opened up for the network', E.readEnvValue(first.text, 'HOST'), '0.0.0.0');
eq('a token is generated', E.readEnvValue(first.text, 'ACCESS_TOKEN'), 'GENERATED-TOKEN');
eq('an existing port is left alone', E.readEnvValue(first.text, 'PORT'), '8080');
eq('two things were decided', first.notes.length, 2);

const again = E.prepareEnv(first.text, { forNetwork: true, makeToken: token });
eq('running it twice changes nothing', again.text, first.text);
eq('and reports nothing', again.notes.length, 0);

const local = E.prepareEnv(EXAMPLE, { forNetwork: false, makeToken: token });
eq('without --network a loopback HOST is respected', E.readEnvValue(local.text, 'HOST'), '127.0.0.1');

const custom = E.prepareEnv('HOST=192.168.1.50\nPORT=9999\nACCESS_TOKEN=mine\n',
  { forNetwork: true, makeToken: token });
eq('an existing non-loopback host is kept', E.readEnvValue(custom.text, 'HOST'), '192.168.1.50');
eq('an existing token is never replaced', E.readEnvValue(custom.text, 'ACCESS_TOKEN'), 'mine');
eq('an existing port is kept', E.readEnvValue(custom.text, 'PORT'), '9999');
eq('nothing was changed', custom.notes.length, 0);

const empty = E.prepareEnv('', { forNetwork: true, makeToken: token });
eq('an empty file gets a host', E.readEnvValue(empty.text, 'HOST'), '0.0.0.0');
// 5173 rather than an arbitrary port: browser storage is scoped per origin, so
// serving on a different port hides every chat and setting the dev server saved.
eq('an empty file gets the dev server port', E.readEnvValue(empty.text, 'PORT'), '5173');
eq('an empty file gets a token', E.readEnvValue(empty.text, 'ACCESS_TOKEN'), 'GENERATED-TOKEN');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
