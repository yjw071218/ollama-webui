// Summarise a .cpuprofile: self and total time per function (with location).
//   node scripts/bench/profile-top.mjs <file.cpuprofile> [n]
import fs from 'node:fs';
const [file, n = 30] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map(x => [x.id, x]));
const parent = new Map();
for (const x of p.nodes) for (const c of x.children || []) parent.set(c, x.id);
const dt = new Map();
for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
const label = (x) => { const f = x.callFrame; return `${f.functionName || '(anon)'} ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`; };
const self = new Map(), total = new Map();
for (const [nid, us] of dt) {
  const x = byId.get(nid); const l = label(x);
  self.set(l, (self.get(l) || 0) + us);
  const seen = new Set();
  for (let cur = nid; cur != null; cur = parent.get(cur)) { const cl = label(byId.get(cur)); if (seen.has(cl)) continue; seen.add(cl); total.set(cl, (total.get(cl) || 0) + us); }
}
const fmt = (m) => [...m].filter(([l]) => !/^\((root|program|idle)\)/.test(l)).sort((a, b) => b[1] - a[1]).slice(0, Number(n)).map(([l, us]) => `${(us / 1000).toFixed(0).padStart(7)} ms  ${l}`).join('\n');
console.log('--- self ---\n' + fmt(self) + '\n--- total ---\n' + fmt(total));
