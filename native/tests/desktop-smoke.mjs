import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(root + '/artifacts', {recursive:true});
const profile = await mkdtemp(root + '/artifacts/smoke-');
const server = http.createServer((req, res) => {
  // The app asks whether this is an Ollama WebUI server before it opens it (proxy.mjs probeServer).
  if (req.url === '/api/whoami') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ servingPort: server.address().port, tokenRequired: false })); return; }
  res.setHeader('content-type', 'text/html'); res.end('<!doctype html><h1>Native smoke test</h1>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const exe = process.env.NATIVE_EXE || root + '/desktop/node_modules/electron/dist/electron.exe';
const args = process.env.NATIVE_EXE ? [] : [root + '/desktop'];
args.push('--native-smoke', '--smoke-server=' + (process.env.NATIVE_SERVER || 'http://127.0.0.1:' + server.address().port), '--smoke-profile=' + profile);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(exe, args, {windowsHide:true, stdio:['ignore','pipe','pipe'], env});
let output = '';
child.stdout.on('data', bytes => { output += bytes; process.stdout.write(bytes); });
child.stderr.on('data', bytes => process.stderr.write(bytes));
const timeout = setTimeout(() => { child.kill(); }, 45000);
const [code] = await once(child, 'exit'); clearTimeout(timeout);
server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
// The Electron profile is 10-40 MB; one was left behind on every run.
await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
if (code !== 0 || !output.includes('"secure":true') || !output.includes('"node":"undefined"')) process.exitCode = 1;
