#!/usr/bin/env node
/**
 * The workbench as an MCP server on stdio: server/workbench.js's tools, for
 * the chat's models and the CLIs alike.
 *
 *     node server/mcpWorkbench.mjs [--no-commands] <folder> [<folder> ...]
 *
 * The folders are the only places it reads, writes or runs in. With
 * `--no-commands`, run_command is not offered at all.
 *
 * Newline-delimited JSON-RPC, written by hand as the test stub is: the three
 * methods an MCP server needs are shorter than a dependency.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  LIMITS, resolveIn, readLines, grep, findFiles, writeFile, editFile, runCommand, commandReport,
} from './workbench.js';
import { commandSpool } from './liveCommands.js';
import { effectiveAccess } from './workbenchState.js';
import { execFileSync } from 'node:child_process';
import { checkServerCommand, blockedMessage } from './serverGuard.js';

/* Processes started with `background: true`, stopped when this server ends. */
const background = new Set();

const argv = process.argv.slice(2);
const noCommands = argv.includes('--no-commands');
/* What mcp.json allows. The web UI can narrow it per call (see `call`). */
const startRoots = argv.filter(a => !a.startsWith('--')).map(a => path.resolve(a)).filter((dir) => {
  try { return fs.statSync(dir).isDirectory(); } catch { process.stderr.write(`workbench: skipping ${dir}, not a folder\n`); return false; }
});
if (!startRoots.length) {
  process.stderr.write('workbench: give at least one folder it may work in\n');
  process.exit(1);
}

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'read_file',
    description: `Read a text file with line numbers. Reads ${LIMITS.readLines} lines from \`offset\` (1-based) by default; the header gives the total and where to continue, so any part of a large file can be read. Always read a file before editing it.`,
    inputSchema: {
      type: 'object',
      properties: { path: str('Absolute path'), offset: { type: 'integer', description: 'First line, 1-based' }, limit: { type: 'integer', description: 'How many lines' } },
      required: ['path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression (JavaScript syntax) under a folder or in one file. Returns matching lines with line numbers, optionally with context lines. Skips node_modules, .git and binary files. Use this to find where something is defined or used.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: str('Regular expression'),
        path: str('Folder or file to search'),
        glob: str('Only files matching this glob, e.g. "*.jsx" or "src/**/*.js"'),
        ignore_case: { type: 'boolean' },
        context: { type: 'integer', description: 'Lines of context around each match (0-10)' },
        files_only: { type: 'boolean', description: 'List matching files instead of lines' },
        max_results: { type: 'integer' },
      },
      required: ['pattern', 'path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'find_files',
    description: 'Find files by name with a glob such as "**/*.test.mjs" or "*config*". Skips node_modules and .git.',
    inputSchema: { type: 'object', properties: { pattern: str('Glob'), path: str('Folder to search') }, required: ['pattern', 'path'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact piece of text in a file. old_string must match the file exactly (indentation included) and occur once, unless replace_all is set. Returns a unified diff of the change. Prefer this over write_file for changing existing files.',
    inputSchema: {
      type: 'object',
      properties: { path: str('Absolute path'), old_string: str('Exact text to replace'), new_string: str('Replacement'), replace_all: { type: 'boolean' } },
      required: ['path', 'old_string', 'new_string'],
    },
    annotations: { destructiveHint: true },
  },
  {
    name: 'write_file',
    description: 'Create a file, or overwrite one with new content. Creates folders as needed. Returns a unified diff against what was there.',
    inputSchema: { type: 'object', properties: { path: str('Absolute path'), content: str('The whole new content') }, required: ['path', 'content'] },
    annotations: { destructiveHint: true },
  },
  {
    name: 'run_command',
    description: `Run a shell command (cmd.exe on Windows unless shell is "powershell" or "bash") and return its exit code and output. For builds, tests, git and scripts. Times out after ${LIMITS.commandMs / 1000}s unless timeout_ms says otherwise. Not interactive: nothing can be typed into it. For something that keeps running (a dev server such as \`npm run dev\`, a watcher), set background: true -- it returns after a few seconds (or once it prints its localhost address) with the output so far and keeps running.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: str('The command line'),
        cwd: str('Working folder'),
        timeout_ms: { type: 'integer' },
        shell: { type: 'string', enum: ['cmd', 'powershell', 'bash'] },
        background: { type: 'boolean', description: 'Keep it running and return early (dev servers, watchers)' },
        wait_ms: { type: 'integer', description: 'With background: how long to wait for first output (default 8000)' },
      },
      required: ['command', 'cwd'],
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  },
];

/* The tools on offer now: no writing when read-only, no commands when off. */
const toolsNow = () => {
  const access = effectiveAccess(startRoots, { noCommands });
  return TOOLS.filter(tool => (tool.name !== 'run_command' || access.commands)
    && (!access.readOnly || !['edit_file', 'write_file'].includes(tool.name)));
};

const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

/* A dev server's address in its output: where "open it" should go. */
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'"`)]*/i;
const WRITES = new Set(['edit_file', 'write_file']);

const call = async (name, args = {}) => {
  /* The web UI may narrow what this server was started with, never widen it
     (server/workbenchState.js). Read per call, so a change applies at once. */
  const access = effectiveAccess(startRoots, { noCommands });
  const roots = access.roots;
  if (!roots.length) throw new Error('Every folder is switched off for the workbench in the web UI (MCP settings).');
  if (access.readOnly && WRITES.has(name)) throw new Error('The workbench is read-only right now (set in the web UI\'s MCP settings).');
  switch (name) {
    case 'read_file':
      return text(readLines(resolveIn(roots, args.path), { offset: args.offset, limit: args.limit }));
    case 'grep': {
      const where = resolveIn(roots, args.path);
      return text(grep(where, args.pattern, {
        glob: args.glob, ignoreCase: !!args.ignore_case, context: args.context,
        filesOnly: !!args.files_only, maxResults: args.max_results || undefined,
      }));
    }
    case 'find_files':
      return text(findFiles(resolveIn(roots, args.path), args.pattern));
    case 'edit_file':
      return text(editFile(resolveIn(roots, args.path), args.old_string, args.new_string, { replaceAll: !!args.replace_all }));
    case 'write_file':
      return text(writeFile(resolveIn(roots, args.path), args.content));
    case 'run_command': {
      if (!access.commands) throw new Error('run_command is switched off for this server (in mcp.json or the web UI\'s MCP settings).');
      const cwd = resolveIn(roots, args.cwd || roots[0]);
      const command = String(args.command || '');
      // Never the server this AI is running inside (server/serverGuard.js).
      const blocked = checkServerCommand(command);
      if (blocked) return text(blockedMessage(blocked), true);
      // Watched live from the web UI while it runs (server/liveCommands.js).
      const monitor = commandSpool({ command, cwd, shell: args.shell || '', background: !!args.background });
      if (!args.background) {
        const result = await runCommand(command, { cwd, timeoutMs: args.timeout_ms, shell: args.shell, monitor });
        return text(commandReport(command, cwd, result), result.code !== 0);
      }
      /* A server that never exits: started, watched for a few seconds (or
         until it prints its address), and left running for the monitor. */
      let seen = '';
      const watching = {
        setPid: (pid) => { background.add(pid); monitor.setPid(pid); },
        finish: (result) => { monitor.finish(result); },
        output: (chunk) => { seen += chunk; monitor.output(chunk); },
      };
      const ended = runCommand(command, { cwd, timeoutMs: LIMITS.commandMaxMs, shell: args.shell, monitor: watching });
      const waitMs = Math.min(Math.max(Number(args.wait_ms) || 8000, 1000), 60000);
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => { clearInterval(poll); resolve(null); }, waitMs);
        const poll = setInterval(() => { if (URL_IN_OUTPUT.test(seen)) { clearInterval(poll); clearTimeout(timer); setTimeout(() => resolve(null), 500); } }, 200);
        ended.then((result) => { clearInterval(poll); clearTimeout(timer); resolve(result); });
      });
      if (outcome) return text(commandReport(command, cwd, outcome), outcome.code !== 0);
      const url = URL_IN_OUTPUT.exec(seen)?.[0];
      return text([
        `[background] ${command} (in ${cwd}) is still running${url ? ` at ${url}` : ''}. It is watched in the web UI and stops when this session ends, or after ${LIMITS.commandMaxMs / 60000} minutes.`,
        seen.trim().slice(-4000) || '(no output yet)',
      ].join('\n'));
    }
    default:
      throw new Error(`No tool called ${name}`);
  }
};

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = async (message) => {
  const { id, method, params } = message;
  if (id === undefined) return;                         // notifications need no answer
  try {
    if (method === 'initialize') {
      return write({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ollama-webui-workbench', version: '1.0.0' },
          instructions: `Code tools for these folders: ${effectiveAccess(startRoots, { noCommands }).roots.join(', ')}. Read with read_file (by line range) and grep before editing; edit with edit_file; check work with run_command.`,
        },
      });
    }
    if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: toolsNow() } });
    if (method === 'tools/call') {
      try {
        return write({ jsonrpc: '2.0', id, result: await call(params?.name, params?.arguments || {}) });
      } catch (e) {
        // A tool that failed is a result the model can act on, not a protocol error.
        return write({ jsonrpc: '2.0', id, result: text(`Error: ${e.message}`, true) });
      }
    }
    return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported` } });
  } catch (e) {
    return write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
/* Background commands go when the session does: on Windows a child's
   children outlive it otherwise, and a dev server would hold its port. */
const stopBackground = () => {
  for (const pid of background) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else process.kill(pid, 'SIGTERM');
    } catch { /* already gone */ }
  }
  background.clear();
};
process.stdin.on('end', () => { stopBackground(); process.exit(0); });
process.on('SIGTERM', () => { stopBackground(); process.exit(0); });
process.on('SIGINT', () => { stopBackground(); process.exit(0); });
