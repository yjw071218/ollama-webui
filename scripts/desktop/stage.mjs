// Stages the files an installed copy needs, the same way on Windows, Linux
// and macOS, then (with --check) starts the staged server from a scratch copy
// and fails unless it answers. v0.1.1 shipped without src/, which server/
// imports, and crashed on first launch; the check is what keeps that from
// reaching a release again.
//
//   node scripts/desktop/stage.mjs <stageDir> [--check]
//
// The app goes to <stageDir>/app. The Node runtime is added by the workflow.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const stage = path.resolve(args.find(a => !a.startsWith('--')) || path.join(ROOT, 'installer', 'stage'));
const app = path.join(stage, 'app');

// server/ imports ../src and ../integrations at runtime, so both ship.
// docs/ ships for SOCIAL_LOGIN.ko.md, which the first run points to.
const ITEMS = ['dist', 'server', 'src', 'integrations', 'assets', 'workflows', 'public', 'docs',
  'package.json', '.env.example', 'LICENSE', 'README.md'];
const REQUIRED = ['dist/index.html', 'server/index.js', 'src', 'package.json'];

// Never ship local data, secrets, logs, or big optional checkouts.
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs']);
const skipFile = (name) => name === '.env' || name === '.env.local' || /\.(log|bak)$/i.test(name);
const skipPath = (rel) => {
  const r = rel.split(path.sep).join('/');
  return /^server\/data\/./.test(r) || r === 'integrations/risuai/upstream' || r.startsWith('integrations/risuai/upstream/');
};

const copy = (from, to, rel) => {
  if (skipPath(rel)) return;
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(from))) return;
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name), path.join(rel, name));
  } else if (!skipFile(path.basename(from))) {
    fs.copyFileSync(from, to);
  }
};

for (const req of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, req))) {
    console.error(`stage: ${req} is missing${req.startsWith('dist') ? ' (run npm run build first)' : ''}.`);
    process.exit(1);
  }
}

fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
for (const item of ITEMS) {
  const from = path.join(ROOT, item);
  if (fs.existsSync(from)) copy(from, path.join(app, item), item);
}
fs.mkdirSync(path.join(app, 'server', 'data'), { recursive: true });
console.log(`stage: app staged in ${app}`);

if (!check) process.exit(0);

// ---------------------------------------------------------------- smoke check

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A scratch copy, so the check never leaves data in what gets packaged.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'owui-check-'));
copy(app, path.join(scratch, 'app'), '');
const port = await freePort();
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const node = process.env.CHECK_NODE || process.execPath;
const child = spawn(node, ['server/index.js'], {
  cwd: path.join(scratch, 'app'),
  // A user with nothing set up: no .env, no Ollama, an empty home folder.
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HOME: home, USERPROFILE: home, OLLAMA_URL: 'http://127.0.0.1:9' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });
let exited = null;
child.on('exit', code => { exited = code ?? 'signal'; });

const fail = (why) => {
  console.error(`stage: smoke check FAILED -- ${why}\n----- server output -----\n${log}`);
  try { child.kill(); } catch { /* gone */ }
  process.exit(1);
};

let ok = false;
for (let i = 0; i < 120 && exited === null; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    const body = await res.text();
    if (res.ok && /<html/i.test(body)) { ok = true; break; }
  } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 500));
}
if (exited !== null) fail(`server exited (${exited}) on startup`);
if (!ok) fail('server did not answer http://127.0.0.1:' + port + '/ within 60s');
// Still alive a moment later: a crash right after listening counts too.
await new Promise(r => setTimeout(r, 2000));
if (exited !== null) fail(`server exited (${exited}) right after starting`);
child.kill();
await new Promise(r => setTimeout(r, 500));
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`stage: smoke check passed (${process.platform}, node ${process.version} via ${path.basename(node)})`);
process.exit(0);
