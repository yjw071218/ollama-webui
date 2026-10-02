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
 * else is touched.
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
const child = spawn(plan.command, plan.args, {
  cwd,
  env: childEnv,
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: plan.shell,
  windowsHide: true,
});

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, cut).replace(/\r$/, '');
    buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    const out = rewrite(line);
    if (out !== null && child.stdin.writable) child.stdin.write(`${out}\n`);
  }
});
process.stdin.on('end', () => { try { child.stdin.end(); } catch { /* gone */ } });
child.stdin.on('error', () => { /* it exited; `exit` below says so */ });
child.on('error', (e) => { process.stderr.write(`mcpStdioProxy: could not start '${command}': ${e.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill(); } catch { /* gone */ } });
