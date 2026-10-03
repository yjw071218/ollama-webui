// Read-only audit. Report locations/categories, never matched IPs or secret values.
// PRIVATE_IP is supplied locally, never stored in source.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
const git = args => execFileSync('git', args, {encoding:'utf8', maxBuffer:64*1024*1024});
// Include newly added source files too: untracked files can enter the next release.
const files = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
const needle = process.env.PRIVATE_IP;
const findings = [];
let scanned = 0, skipped = 0;
for (const file of files) {
  try {
    if (statSync(file).size > 16*1024*1024) { skipped++; continue; }
    const bytes = readFileSync(file);
    if (bytes.includes(0)) { skipped++; continue; }
    const text = bytes.toString('utf8'); scanned++;
    const categories = [];
    if (needle && text.includes(needle)) categories.push('supplied-private-ip');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) categories.push('private-key-candidate');
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/.test(text)) categories.push('credential-candidate');
    // Exclude loopback, private LAN, documentation networks and well-known DNS.
    const ips = [...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(m => m[0]).filter(ip => {
      const p = ip.split('.').map(Number);
      return p.every(n => n <= 255) && ![0,10,127].includes(p[0])
        && !(p[0]===192 && [168,0].includes(p[1]))
        && !(p[0]===172 && p[1]>=16 && p[1]<=31)
        && !(p[0]===169 && p[1]===254)
        && !ip.startsWith('198.51.100.') && !ip.startsWith('203.0.113.')
        && !['8.8.8.8','8.8.4.4','1.1.1.1','1.0.0.1','255.255.255.255'].includes(ip);
    });
    if (ips.length) categories.push('public-ip-or-version-candidate');
    if (categories.length) findings.push({file, categories});
  } catch { skipped++; }
}
let history = null;
if (needle) {
  const matches = git(['log','--all','--format=commit:%H','--name-only','-G',needle.replaceAll('.', '\\.')]);
  history = { matchingCommits: (matches.match(/^commit:/gm)||[]).length,
    files:[...new Set(matches.split(/\r?\n/).filter(v => v && !v.startsWith('commit:')))] };
}
console.log(JSON.stringify({scope:'tracked and untracked non-ignored text + supplied-IP changes across local Git refs; binary artifacts, ignored data and remote releases require separate inspection', scanned, skipped, findings, history}, null, 2));
