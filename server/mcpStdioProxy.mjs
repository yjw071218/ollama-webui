#!/usr/bin/env node
/**
 * One MCP server, as a CLI is handed it: started through this, which passes
 * every message along unchanged except one detail of the handshake.
 *
 *     node mcpStdioProxy.mjs --cwd <dir> -- <command> [args...]
 *
 * ## Why
 *
 * MCP has "roots": a client says which directories it is working in, and a
 * server may use them. The filesystem server does more than use them -- when
 * the client offers roots, they *replace* the directories its command line
 * names. Claude Code offers its own working directory as its root, and a CLI
 * run from this app works in an empty scratch directory (see
 * server/cliModels.js for why). So a filesystem server configured in
 * `mcp.json` for `D:\notes` came up allowed to read an empty temp folder, and
 * the model told the reader to copy their file there.
 *
 * `mcp.json` is the permission, so what it says wins: the client's `roots`
 * capability is taken out of `initialize`, and a server never asks. Nothing
 * else in that handshake is touched.
 *
 * If the child exits, keep the CLI pipe open and reconnect with a capped
 * backoff, replaying only initialize/initialized. In-flight calls fail with
 * an unknown outcome; replaying a write could apply it twice. Ending the
 * client's pipe stops both the child and the recovery loop.
 *
 * ## Also
 *
 * It starts the server from `--cwd` -- this app's directory -- so a relative
 * path in `mcp.json` means what it means for the local models too; and it
 * starts `npx`/`uvx` shims on Windows the way server/mcp.js does, which
 * neither CLI does by itself.
 */
import { spawn } from 'node:child_process';
import { shellPlan } from './mcp.js';

const argv = process.argv.slice(2);
let cwd = process.cwd();
const envFrom = [];
while (argv.length && argv[0] !== '--') {
  const flag = argv.shift();
  if (flag === '--cwd') cwd = argv.shift() || cwd;
  else if (flag === '--env-from') { const p = argv.shift(); if (p) envFrom.push(p); }
}
/* `--env-from PREFIX`: variables named PREFIXKEY become KEY for the server, so
   a token can come through the environment rather than a file on disk. */
const childEnv = { ...process.env };
for (const prefix of envFrom) {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix) && k.length > prefix.length) {
      childEnv[k.slice(prefix.length)] = v;
      delete childEnv[k];
    }
  }
}
argv.shift(); // the '--'
const [command, ...args] = argv;
if (!command) {
  process.stderr.write('mcpStdioProxy: no command to run\n');
  process.exit(2);
}

/** One line from the client, with the roots capability taken out of `initialize`. */
const rewrite = (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return line; }
  if (message?.method === 'initialize' && message.params?.capabilities?.roots) {
    const { roots, ...rest } = message.params.capabilities;
    void roots;
    return JSON.stringify({ ...message, params: { ...message.params, capabilities: rest } });
  }
  // Having not offered roots, the client has none to announce changes to.
  if (message?.method === 'notifications/roots/list_changed') return null;
  return line;
};

const plan = shellPlan({ command, args });
let child, stopped = false, ready = true, initialized = null, restartTimer, handshakeTimer;
let attempts = 0, serial = 0, internalId = null, buffer = '';
const pending = new Set();
const output = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const fail = (id, message) => output({ jsonrpc: '2.0', id, error: { code: -32000, message } });
const send = message => {
  if (child?.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
};
const stopChild = () => {
  if (!child) return;
  try { child.stdin.end(); } catch { /* already closed */ }
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch { /* gone */ } });
  } else { try { child.kill(); } catch { /* gone */ } }
};
const start = () => {
  if (stopped) return;
  const current = spawn(plan.command, plan.args, {
    cwd, env: childEnv, stdio: ['pipe', 'pipe', 'inherit'], shell: plan.shell, windowsHide: true,
  });
  child = current;
  let incoming = '', lost = false;
  const disconnect = reason => {
    if (lost || stopped || child !== current) return;
    lost = true;
    ready = false;
    clearTimeout(handshakeTimer);
    // The result of a mutating call is unknown: never replay it automatically.
    for (const id of pending) fail(id, `MCP connection lost; execution result is unknown. ${reason}`);
    pending.clear();
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
    process.stderr.write(`mcpStdioProxy: reconnecting in ${delay}ms: ${reason}\n`);
    restartTimer = setTimeout(start, delay);
  };
  current.stdin.on('error', e => { disconnect(e.message); stopChild(); });
  current.on('error', e => disconnect(e.message));
  current.on('exit', (code, signal) => disconnect(`server exited (${signal || code})`));
  current.stdout.setEncoding('utf8');
  current.stdout.on('data', chunk => {
    if (lost || stopped) return;
    incoming += chunk;
    if (incoming.length > 32 * 1024 * 1024) { disconnect('server frame too large'); stopChild(); return; }
    let cut;
    while ((cut = incoming.indexOf('\n')) !== -1) {
      const line = incoming.slice(0, cut); incoming = incoming.slice(cut + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message.method && internalId !== null && message.id === internalId) {
        internalId = null;
        clearTimeout(handshakeTimer);
        if (message.error) { disconnect('reinitialization failed'); stopChild(); return; }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        ready = true;
        attempts = 0;
        process.stderr.write('mcpStdioProxy: connection restored\n');
        output({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        continue;
      }
      if (!message.method) {
        pending.delete(message.id);
        if (initialized && message.id === initialized.id && !message.error) { ready = true; attempts = 0; }
      }
      output(message);
    }
  });
  if (initialized) {
    internalId = `__webui_reconnect_${++serial}`;
    send({ ...initialized, id: internalId });
    handshakeTimer = setTimeout(() => { disconnect('reinitialization timed out'); stopChild(); }, 20000);
  } else ready = true;
};
start();
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 32 * 1024 * 1024) { shutdown(); return; }
  let cut;
  while ((cut = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, cut).replace(/\r$/, ''); buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    const rewritten = rewrite(line);
    if (rewritten === null) continue;
    let message;
    try { message = JSON.parse(rewritten); } catch { continue; }
    if (!ready) {
      if (message.method && message.id !== undefined) fail(message.id, 'MCP reconnecting; request was not executed. Try again after recovery.');
      continue;
    }
    if (message.method === 'initialize') initialized = message;
    if (message.method && message.id !== undefined) pending.add(message.id);
    send(message);
  }
});
function shutdown() {
  if (stopped) return;
  stopped = true;
  clearTimeout(restartTimer);
  clearTimeout(handshakeTimer);
  stopChild();
  process.stdin.destroy();
  // Allow the child to close its pipes, then release a wedged process as well.
  setTimeout(() => process.exit(0), 1500).unref();
}
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
