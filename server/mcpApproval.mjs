#!/usr/bin/env node
/**
 * Claude Code's `--permission-prompt-tool` for project mode.
 *
 *     node server/mcpApproval.mjs --dir <folder>
 *
 * When Claude Code wants to do something its allow-list does not cover -- a
 * shell command, a write outside the project -- it calls this server's one
 * tool, `ask`, with the tool name and input. The question is written to
 * `<folder>/<n>.req.json`; server/cliProject.js (`watchApprovalDir`) shows it
 * in the browser and writes the answer to `<folder>/<n>.res.json`, which is
 * returned to Claude Code as `{ behavior: "allow" | "deny", ... }`.
 *
 * Files rather than HTTP, so it works whatever port, TLS or access token the
 * web server is behind, and needs no secret of its own: the folder is created
 * per run in the server's scratch directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const dir = argv[argv.indexOf('--dir') + 1];
const TIMEOUT_MS = 11 * 60 * 1000;   // just past the server's own ten minutes
let counter = 0;

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

const TOOL = {
  name: 'ask',
  description: 'Ask the user in the web UI whether a tool call may run.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name'],
  },
};

const ask = (args) => new Promise((resolve) => {
  const n = `${Date.now()}-${counter++}`;
  const req = path.join(dir, `${n}.req.json`);
  const res = path.join(dir, `${n}.res.json`);
  const deny = (message) => resolve({ behavior: 'deny', message });
  try { fs.writeFileSync(req, JSON.stringify(args || {})); } catch (e) { deny(`Could not ask: ${e.message}`); return; }
  const started = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(res)) {
      clearInterval(timer);
      try { resolve(JSON.parse(fs.readFileSync(res, 'utf8'))); } catch { deny('Unreadable answer'); }
      return;
    }
    if (Date.now() - started > TIMEOUT_MS) { clearInterval(timer); deny('Nobody answered in the web UI.'); }
  }, 300);
});

const handle = async (m) => {
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'webui-approval', version: '1.0.0' } } });
  }
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: [TOOL] } });
  if (m.method === 'tools/call') {
    if (m.params?.name !== 'ask') return send({ id: m.id, error: { code: -32602, message: 'Unknown tool' } });
    const decision = await ask(m.params.arguments);
    return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.id !== undefined) return send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  return undefined;   // a notification
};

if (!dir || !fs.existsSync(dir)) {
  process.stderr.write('mcpApproval: --dir <existing folder> is required\n');
  process.exit(2);
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  handle(m).catch((e) => { if (m.id !== undefined) send({ id: m.id, error: { code: -32603, message: String(e.message || e) } }); });
});
