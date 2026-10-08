import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readRequestBody } from './requestBody.js';
import { signedInFile } from './cliAuth.js';
import { ownerOfRequest } from './session.js';
import { backendOf, callServer, imageMime, toTags } from './llamacpp.js';
import {
  beginChatJob, attachChatController, appendChatFrame, finishChatJob,
} from './chatJobs.js';
import { readConfig as readMcpConfig } from './mcp.js';
import { fileChangesIn, commandIn } from './workbench.js';
import { ShellChanges, pathsIn } from './shellChanges.js';
import { listCommands, stopCommand, noteCommand, readLog } from './liveCommands.js';
import { readPolicy, writePolicy, effectiveAccess, hasBackup, restoreBackup, sweepBackups, listBackups } from './workbenchState.js';
import { resumeEnabled, historyKey, splitForResume, tailRequest, sessions } from './cliSessions.js';
import { recordUsage, readUsage, summariseUsage } from './cliUsage.js';
import { agyQuotaForModel, agyQuotaGroup } from '../src/agyQuota.js';
import {
  candidatesFor, blockedUntil, isLimitError, isUnavailableError, streamLocal, LIMIT_ERROR,
} from './cliFallback.js';
import { noteFinished, sendPush } from './push.js';
import {
  projectFromHeaders, snapshotTree, diffTrees, noteRun, changesMarkdown, requestApproval,
  watchApprovalDir, codexApprovalOf, codexApprovalReply, budgetState, noteLimitHistory, withForecasts,
  agyEstimate, learnAgyCapacity, maxTurnsOf, listApprovals, decideApproval, projectSettings, listRuns,
  revertRun, getRun, resolveProject, startRace, getRace, listRaces, finishRace, listExtensions, setExtensionEnabled,
  listTerminalSessions, readTerminalSession,
} from './cliProject.js';

/**
 * Claude, GPT and Gemini, answered by the coding CLIs already signed in on this
 * machine instead of by an API key.
 *
 * ## What this is
 *
 * Claude Code, Codex and Antigravity (`agy`) each have a non-interactive mode
 * that takes one prompt and streams the answer as JSON lines. They are
 * signed in with the reader's own subscription, so running them costs no API
 * key -- it spends the same quota the terminal does. This file makes each one
 * look like one more Ollama model:
 *
 *     claude-code:opus         claude -p --input-format stream-json ...
 *     codex:gpt-5.5            codex app-server   (JSON-RPC on stdio)
 *     agy:gemini-3.1-pro-high  agy --input-format stream-json --print=
 *
 * The names are `<cli>:<model>` so they sort together in the picker and cannot
 * collide with anything Ollama pulls.
 *
 * ## What it is not
 *
 * It does not lift the CLIs' OAuth tokens and call the providers' APIs with
 * them. That would be the actual bypass, and it is the kind of thing that gets
 * an account closed. The CLIs are run as themselves, one process per answer,
 * with their agent tools switched off (Claude) or sandboxed read-only (Codex),
 * so a chat message cannot become a shell command on this machine.
 *
 * `gemini` (Gemini CLI) is not here on purpose: Google has turned off its free
 * individual tier ("This client is no longer supported ... migrate to the
 * Antigravity suite"), and `agy` serves the same Gemini models.
 *
 * ## How it joins the rest of the app
 *
 * The browser keeps speaking Ollama's dialect (see server/llamacpp.js for why
 * that dialect is load-bearing). `cliInterceptor` runs ahead of the Ollama
 * proxy and the llama.cpp routes alike: it reads the body, and if `model` names
 * a CLI it answers; otherwise it leaves the bytes on `req.rawBody` and steps
 * aside, and whoever handles the request next reads them from there -- see
 * server/requestBody.js and `proxy` in server/index.js.
 *
 * A CLI takes one prompt, not a message list, so a conversation is sent as a
 * transcript. Each answer is a fresh process. The app owns the history; a CLI
 * session is used only when it provably holds exactly that history up to the
 * last answer, and then only the new message is sent -- see
 * server/cliSessions.js. A model over its limit can be answered for by the
 * next one in CLI_FALLBACK (server/cliFallback.js), and every answer is kept
 * in the account in server/cliUsage.js.
 *
 * ## Tools, when the reader switches them on
 *
 * With the tools toggle on (the browser says so with `X-Cli-Tools: on`), a
 * CLI that can take MCP servers is handed the ones in `mcp.json` -- the same
 * servers, and the same allow-lists, the local models get -- and runs them in
 * its own agent loop, which it is far better at than a transcript of tags.
 * Claude Code also gets its web search and page fetch. Nothing else: no
 * shell, no file edits, no built-in tools that touch this machine. The file is
 * still the permission; the toggle is the reader saying "this turn".
 *
 *     CLI_MCP=false    never hand the CLIs the MCP servers
 *     CLI_WEB=false    never give Claude Code web search / fetch
 *
 * Antigravity cannot be handed servers on its command line. It keeps using
 * the app's own tool tags, as a local model does, unless CLI_AGY_MCP=on puts
 * the servers in its chat agent's file (see agyAgentFile).
 */

/* ------------------------------------------------------------ the CLIs */

const HOME = os.homedir();

/** Split a comma-separated list from `.env`, dropping blanks. */
const listOf = (value) => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

/* Each CLI's non-interactive argv, its stdin, and how to read its stdout.
   Pure data plus pure functions, so the whole translation is testable without
   a signed-in CLI -- which, like a GPU, is the same as not being testable. */
export const PROVIDERS = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    family: 'claude',
    bin: 'claude',
    pathEnv: 'CLAUDE_CLI_PATH',
    modelsEnv: 'CLI_CLAUDE_MODELS',
    // Aliases rather than dated ids: Claude Code resolves them to whatever is
    // newest, so the list does not go stale with every release.
    defaultModels: ['opus', 'sonnet', 'haiku'],
    vision: true,
    thinking: true,
    // Takes MCP servers for one run (`--mcp-config`), in all three transports.
    nativeMcp: ['stdio', 'http', 'sse'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    authFiles: [['.claude', '.credentials.json']],
    authEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    family: 'gpt',
    bin: 'codex',
    pathEnv: 'CODEX_CLI_PATH',
    modelsEnv: 'CLI_CODEX_MODELS',
    // Only until Codex has written models_cache.json (its first run): the
    // list a signed-in Codex offered as of 2026-10, so a new PC is not one model.
    defaultModels: ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    vision: true,
    thinking: true,
    // `-c mcp_servers.<name>...` for one run. Codex has no legacy SSE client.
    nativeMcp: ['stdio', 'http'],
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    authFiles: [['.codex', 'auth.json']],
    authEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  },
  agy: {
    id: 'agy',
    label: 'Antigravity',
    family: 'gemini',
    bin: 'agy',
    pathEnv: 'AGY_CLI_PATH',
    modelsEnv: 'CLI_AGY_MODELS',
    // Only while `agy models` cannot answer (not signed in, not on PATH yet):
    // what it listed as of 2026-10.
    defaultModels: [
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'gemini-3.7-flash-high', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-low',
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ],
    // `agy`'s stream input takes text blocks only ("content block type
    // "image" is not supported"), but its own `view_file` tool opens images.
    // So a picture is saved as a file in the directory it runs in, and it is
    // asked to look -- see buildInvocation. It sees the picture itself rather
    // than a vision model's description of it, as Claude and Codex do.
    vision: true,
    thinking: false,
    // Handed over in its chat agent's own file, with CLI_AGY_MCP=on: see
    // nativeMcpOf and agyAgentFile.
    nativeMcp: ['stdio', 'http'],
    nativeMcpOptIn: 'CLI_AGY_MCP',
    efforts: [],
    authFiles: [['.gemini', 'oauth_creds.json'], ['.gemini', 'google_accounts.json']],
    authEnv: [],
  },
};

/** `claude-code:opus` -> `{ provider, model }`, or null for any other name. */
export const parseCliModel = (name) => {
  const text = String(name || '');
  const colon = text.indexOf(':');
  if (colon < 1) return null;
  const provider = PROVIDERS[text.slice(0, colon)];
  const model = text.slice(colon + 1).trim();
  return provider && model ? { provider, model } : null;
};

export const enabledOf = (env = {}) => String(env.CLI_MODELS ?? 'true').trim().toLowerCase() !== 'false';

/* Where a CLI is. A native `.exe` is spawned as it is. An npm shim is a `.cmd`
   file, which Node will only run through `cmd.exe` -- and `cmd.exe` re-parses
   every argument, so a prompt with a `&` or a `"` in it would become a
   command. The shim is three lines that call `node <script>`, so the script is
   read out of it and run with this Node directly. */
const readShim = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/"%(?:~?dp0%?|dp0%)\\?([^"]+?\.(?:c|m)?js)"/i);
    if (!match) return null;
    const script = path.join(path.dirname(file), match[1]);
    return fs.existsSync(script) ? { command: process.execPath, prefix: [script] } : null;
  } catch { return null; }
};

export const resolveBinary = (provider, env = {}) => {
  const override = String(env[provider.pathEnv] || '').trim();
  const candidates = [];
  if (override) candidates.push(override);
  const dirs = String(env.PATH || env.Path || process.env.PATH || process.env.Path || '')
    .split(path.delimiter).filter(Boolean);
  // Where each installer puts it, for a server started without the user's PATH.
  dirs.push(
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, 'AppData', 'Roaming', 'npm'),
    path.join(HOME, 'AppData', 'Local', 'agy', 'bin'),
    // Where the official install.ps1 puts agy.exe (server/first-run.mjs uses it).
    path.join(HOME, 'AppData', 'Local', 'Antigravity'),
  );
  const names = process.platform === 'win32'
    ? [`${provider.bin}.exe`, `${provider.bin}.cmd`]
    : [provider.bin];
  for (const dir of dirs) for (const name of names) candidates.push(path.join(dir, name));

  for (const file of candidates) {
    try { if (!fs.statSync(file).isFile()) continue; } catch { continue; }
    if (/\.cmd$/i.test(file)) {
      const shim = readShim(file);
      if (shim) return shim;
      continue;
    }
    return { command: file, prefix: [] };
  }
  return null;
};

/* ---------------------------------------------------- messages -> prompt */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return content == null ? '' : String(content);
};

const stripDataUrl = (image) => String(image || '').replace(/^data:[^;]+;base64,/, '');

const ROLE_LABEL = { user: 'User', assistant: 'Assistant', tool: 'Tool result', system: 'System instruction', developer: 'Developer instruction' };

/** What `format` asks for, as an instruction, since none of the CLIs take a grammar. */
export const formatInstruction = (format) => {
  if (!format) return '';
  if (format === 'json') return 'Respond with a single valid JSON value and nothing else: no prose, no code fences.';
  return 'Respond with a single JSON value matching this JSON Schema, and nothing else: no prose, no code fences.\n'
    + JSON.stringify(format);
};

/**
 * One chat request as one prompt.
 *
 * The system message is kept apart, because Claude Code takes it as the real
 * system prompt. Everything else becomes a transcript ending on the question
 * to answer; a conversation of one user message is sent as just that message,
 * so the common case reads exactly as the reader typed it.
 *
 * Images come back separately and only from the last user turn: every CLI
 * here that sees images takes them once, alongside the prompt, and an older
 * picture has already been answered about in the transcript.
 */
/* With tools, "write the next message: only its text" read as a text-completion
   task -- and the transcript shows earlier answers without the tool calls
   behind them, so they look like a model that only talks. Codex found its
   tools and still ended on "I will check ..." with no call. The agentic
   framing says what the transcript leaves out and asks for the work itself. */
const AGENTIC_FRAME = [
  'The conversation so far is below. Earlier [Assistant] turns show only the final text of each reply; the tool calls and results behind them are not shown, so do not imitate them as replies that only describe work.',
  'Reply to the latest [User] message as the assistant. If it asks for work -- or agrees to work you proposed or promised -- do that work now with your tools in this turn, and continue until it is done or genuinely blocked, before writing your reply. A reply that only says what you will do is not acceptable.',
  'Write the reply without the "[Assistant]" label.',
].join(' ');

export const toPrompt = (messages = [], { format, agentic = false } = {}) => {
  const system = [];
  const turns = [];
  for (const message of messages) {
    if (!message) continue;
    const text = textOf(message.content);
    if (message.role === 'system' || message.role === 'developer') {
      if (!text.trim()) continue;
      system.push(text);
      // Risu presets deliberately place instructions after history or between
      // turns. Keep their placement as well as passing their full text through
      // the CLI's instruction channel. Do not turn developer text into a user.
      if (turns.length) turns.push({ role: message.role, text, images: [] });
      continue;
    }
    turns.push({ role: message.role in ROLE_LABEL ? message.role : 'user', text, images: message.images || [] });
  }

  let lastUser = -1;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'user') { lastUser = i; break; }
  const images = lastUser >= 0 ? turns[lastUser].images.map(stripDataUrl).filter(Boolean) : [];

  let prompt;
  if (turns.length === 1 && turns[0].role === 'user') {
    prompt = turns[0].text;
  } else {
    const history = turns
      .map(turn => `[${ROLE_LABEL[turn.role]}]\n${turn.text}`)
      .join('\n\n');
    const last = turns.findLast(turn => !['system', 'developer'].includes(turn.role));
    const continuing = last?.role === 'assistant';
    prompt = [
      agentic && !continuing
        ? AGENTIC_FRAME
        : 'The conversation so far is below. Write the next [Assistant] message: only its text, without the "[Assistant]" label.',
      '',
      '<conversation>',
      history,
      '</conversation>',
      // A trailing assistant turn is a continuation: the reader pressed
      // "continue" on an answer that was cut short.
      last?.role === 'assistant' ? '\nContinue the last [Assistant] message exactly where it stops, without repeating any of it.' : '',
    ].join('\n').trim();
  }

  const instruction = formatInstruction(format);
  if (instruction) prompt = `${prompt}\n\n${instruction}`;
  return { system: system.join('\n\n'), prompt, images };
};

/** A JSON answer with the code fence a model wraps it in anyway, unwrapped. */
export const unfence = (text) => {
  const match = String(text || '').trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  return match ? match[1] : String(text || '');
};

/* ---------------------------------------------------------- invocations */

/* `think` as an effort level, or null for "its default".

   The app's "off" is `think: false`, and none of these models can be told not
   to reason at all -- but asked nothing, Claude Code spent thirty seconds and
   three thousand tokens deciding a one-line reply. The lowest effort is the
   nearest thing to off. `true` and a missing field both mean "you decide" --
   unless `CLI_EFFORT` in `.env` decides for it. A level only some CLIs have
   (Claude's `max`, Codex's `minimal`) is passed only to those. */
export const effortOf = (think, provider = null, env = {}) => {
  const levels = provider?.efforts?.length ? provider.efforts : ['low', 'medium', 'high'];
  if (think === false) return 'low';
  if (typeof think === 'string' && levels.includes(think)) return think;
  const fallback = String(env.CLI_EFFORT || '').trim().toLowerCase();
  if ((think === true || think === undefined) && levels.includes(fallback)) return fallback;
  return null;
};

/* How much of the reasoning to ask for. `CLI_THINKING_DISPLAY=off` for a
   Claude Code too old to know the flag; `CLI_REASONING_SUMMARY=none` to keep
   Codex quiet. */
export const thinkingDisplayOf = (env = {}) => {
  const value = String(env.CLI_THINKING_DISPLAY ?? '').trim().toLowerCase();
  if (['off', 'false', 'none', '0'].includes(value)) return '';
  return ['summarized', 'omitted', 'highlights'].includes(value) ? value : 'summarized';
};
export const reasoningSummaryOf = (env = {}) => {
  const value = String(env.CLI_REASONING_SUMMARY ?? '').trim().toLowerCase();
  if (['off', 'false', 'none', '0'].includes(value)) return '';
  return ['auto', 'concise', 'detailed'].includes(value) ? value : 'detailed';
};

/* ------------------------------------------------------------ tools */

const flag = (value, fallback) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  return !['false', '0', 'off', 'no'].includes(text);
};

/* Full access: the CLIs may read and write anywhere on this PC, and are never
   stopped to ask. Asked for in so many words -- "every folder, always
   writable" -- after a chat agent kept answering that its session was
   read-only and it could not continue the work. On by default for that
   reason; CLI_FULL_ACCESS=false in .env puts back the sandbox (chat
   read-only, project writes inside the folder with everything else asked
   about in the browser). It applies to everyone who can use the CLIs on this
   server, which is the thing to weigh before leaving it on. */
export const fullAccessOf = (env = {}) => flag(env.CLI_FULL_ACCESS, true);

/* Every drive on this machine, for Claude Code's --add-dir: its file tools
   stay inside the folders they are given even when nothing is asked. */
export const allRoots = (platform = process.platform, exists = fs.existsSync) => (platform === 'win32'
  ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(root => { try { return exists(root); } catch { return false; } })
  : ['/']);

const FULL_ACCESS_NOTE = "\n\nYou have full read and write access to the user's PC: every folder, with no sandbox and no approval prompts. When asked to create, edit or continue work on files, do it directly with your tools and absolute paths -- never say the session is read-only or ask the user to change permissions. Still do not run destructive commands (deleting data, formatting, force-pushing) unless the user explicitly asks for that.";

/* The transports a CLI takes MCP servers in for one run, here and now. agy
   takes them only in an agent file (see agyAgentFile), which is newer than
   the rest of this. It is now on by default, like Claude Code and Codex: with
   tool tags instead, agy wrote whole files as tags into the answer, and that
   raw code is what the chat showed. CLI_AGY_MCP=off goes back to the tags. */
export const nativeMcpOf = (provider, env = {}) => {
  if (provider.nativeMcpOptIn) {
    if (!flag(env[provider.nativeMcpOptIn], true)) return [];
    if (provider.id === 'agy' && !flag(env.CLI_AGY_AGENT, true)) return [];
  }
  return provider.nativeMcp || [];
};

/* Names that go on a command line as part of a key or a tool name. A server
   called something else is still offered to the local models, through tags. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The tools one run may use: the MCP servers this CLI can take, and whether
 * it gets the web. `wanted` is the reader's toggle for this turn; without it
 * a CLI runs with none, as it always has.
 */
export const toolsFor = (provider, env = {}, { wanted = false, cwd = process.cwd(), home } = {}) => {
  if (!wanted) return null;
  const servers = {};
  const transports = nativeMcpOf(provider, env);
  if (flag(env.CLI_MCP, true) && transports.length) {
    const config = readMcpConfig(env, { cwd, ...(home ? { home } : {}) });
    for (const [name, server] of Object.entries(config.servers || {})) {
      if (server.disabled || !SAFE_NAME.test(name)) continue;
      if (!transports.includes(server.transport)) continue;
      // The delegate hands questions *to* the CLIs; given to one, a CLI could
      // ask itself, and that is a loop with a subscription on the end of it.
      if (isDelegate(server)) continue;
      if (server.transport === 'stdio' ? !server.command : !server.url) continue;
      servers[name] = server;
    }
  }
  const web = provider.id === 'claude-code' && flag(env.CLI_WEB, true);
  return { servers, web };
};

/* A stdio server, started through server/mcpStdioProxy.mjs rather than as
   itself. The CLI would otherwise offer the server its own "roots" -- the
   empty scratch directory it runs in -- and the filesystem server swaps the
   directories `mcp.json` gave it for those, leaving the model allowed to read
   nothing. The proxy also starts the server from this app's directory and
   copes with Windows' `npx.cmd`, as server/mcp.js does. */
export const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcpStdioProxy.mjs');
export const launcher = (server, cwd = process.cwd()) => ({
  command: process.execPath,
  args: [PROXY, '--cwd', server.cwd || cwd, '--', server.command, ...server.args],
});

/** server/mcpDelegate.mjs, which runs the CLIs itself. */
export const isDelegate = (server = {}) =>
  [server.command, ...(server.args || [])].some(part => /mcpDelegate\.mjs$/i.test(String(part || '')));

/** The servers as Claude Code's `--mcp-config` file, and the tool names it may use. */
export const claudeMcpConfig = (servers = {}) => {
  const mcpServers = {};
  const allowed = [];
  const denied = [];
  for (const [name, s] of Object.entries(servers)) {
    if (s.transport === 'stdio') {
      const run = launcher(s);
      mcpServers[name] = { type: 'stdio', command: run.command, args: run.args, env: s.env || {} };
    } else {
      mcpServers[name] = { type: s.transport, url: s.url, headers: s.headers || {} };
    }
    /* `mcp__<server>` allows all of a server's tools. An allow-list is kept
       tool by tool, and a deny-list goes to `--disallowedTools`, which wins
       over any allowance. Nothing else is allowed, and in `-p` mode a tool
       not allowed is refused rather than asked about. */
    const deny = new Set(s.deny || []);
    if (s.allow) allowed.push(...s.allow.filter(t => !deny.has(t) && SAFE_NAME.test(t)).map(t => `mcp__${name}__${t}`));
    else allowed.push(`mcp__${name}`);
    denied.push(...[...deny].filter(t => SAFE_NAME.test(t)).map(t => `mcp__${name}__${t}`));
  }
  return { config: { mcpServers }, allowed, denied };
};

/* A value as TOML, which is how Codex reads `-c key=value`. A JSON string is
   a valid TOML basic string, and a JSON array of strings a valid TOML array. */
const toml = (value) => {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value ?? ''));
};

/** The servers as Codex `-c` overrides, one server table each. */
export const codexMcpOverrides = (servers = {}, { approve = false } = {}) => {
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    const table = {};
    if (s.transport === 'stdio') {
      const run = launcher(s);
      table.command = run.command;
      table.args = run.args;
      if (Object.keys(s.env || {}).length) table.env = s.env;
    } else {
      table.url = s.url;
      if (Object.keys(s.headers || {}).length) table.http_headers = s.headers;
    }
    if (s.allow) table.enabled_tools = s.allow;
    if (s.deny?.length) table.disabled_tools = s.deny;
    if (s.timeout) table.tool_timeout_sec = Math.round(s.timeout / 1000);
    /* Chat mode runs with approvalPolicy "never", and Codex then refuses any
       MCP tool it would have asked about ("requires approval, but approval
       policy is never") -- so write_file never ran. The user chose these
       servers for the chat, so their tools are approved up front. */
    if (approve) table.default_tools_approval_mode = 'approve';
    // Its own table, whole: fields one at a time would merge into a server of
    // the same name in the reader's own config.toml.
    out.push('-c', `mcp_servers.${name}=${toml(table)}`);
  }
  return out;
};

/* ------------------------------------------------------ agy's own agent

   Run as itself, agy is a coding agent: every answer carries its whole agent
   prompt and the definitions of every tool it has -- about 8,000 tokens for
   "hello", and more again for each internal step. Custom agents may opt out
   of all of that (`excludeDefaultComponents`), leaving about a thousand. So
   the chat runs as one: no default prompt sections, none of the reader's own
   rules or GEMINI.md (`inheritCustomizations: false` -- those are for their
   coding sessions), no shell, and no tools but `view_file` when there is a
   picture to look at.

   They live with the reader's other agy agents, in ~/.gemini/config/agents,
   because an agent in a workspace is only read in a trusted one, and the
   scratch directory these runs start in is not. Hidden, so they do not
   appear in the reader's own /agents list. Written when missing or changed.
   `CLI_AGY_AGENT=off` runs agy as itself, as before. */

export const AGY_AGENTS = {
  chat: 'ollama-webui-chat', vision: 'ollama-webui-vision',
  chatMcp: 'ollama-webui-chat-mcp', visionMcp: 'ollama-webui-vision-mcp',
  plan: 'ollama-webui-plan', planMcp: 'ollama-webui-plan-mcp',
};
/* With full access (fullAccessOf): the same agent with agy's file and command
   tools. A chat agent with `tools: []` was told in the message that it could
   write to the PC and found nothing to write with, so it answered "I have no
   permission to modify your files" and pasted the file into the chat instead.
   Named apart so that a server switching between the two never runs one with
   the other's file. Names checked against agy: an unknown one ("command_status")
   stops it before it starts. */
const AGY_FULL_SUFFIX = '-full';
export const AGY_FULL_TOOLS = [
  'view_file', 'list_dir', 'grep_search', 'find_by_name',
  'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'run_command',
];

/* The servers in agy's own spelling (`serverUrl`, `enabledTools`), as a YAML
   flow mapping -- which JSON is, so no value needs YAML's quoting rules. A
   stdio server starts through server/mcpStdioProxy.mjs, as it does for the
   other CLIs. */
export const agyEnvPrefix = (name) => `OWUI_MCP_${String(name).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}__`;

/** The servers' env, prefixed, for agy's process: what the agent file no longer holds. */
export const agyServerEnv = (servers = {}) => {
  const out = {};
  for (const [name, s] of Object.entries(servers || {})) {
    if (s.transport !== 'stdio') continue;
    for (const [k, v] of Object.entries(s.env || {})) out[`${agyEnvPrefix(name)}${k}`] = String(v);
  }
  return out;
};

export const agyMcpServers = (servers = {}) => {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    const entry = {};
    if (s.transport === 'stdio') {
      const run = launcher(s);
      entry.command = run.command;
      /* The server's env (tokens) is not written into the agent file: the
         proxy reads it from agy's own environment under a prefix, which
         runCliOnce sets for this run only (see agyServerEnv). */
      entry.args = Object.keys(s.env || {}).length
        ? [run.args[0], '--env-from', agyEnvPrefix(name), ...run.args.slice(1)]
        : run.args;
    } else {
      entry.serverUrl = s.url;
      if (Object.keys(s.headers || {}).length) entry.headers = s.headers;
    }
    if (s.allow) entry.enabledTools = s.allow;
    if (s.deny?.length) entry.disabledTools = s.deny;
    if (s.timeout) entry.timeoutSeconds = Math.round(s.timeout / 1000);
    out[name] = entry;
  }
  return out;
};

/* Read-only tools for agy's plan-only project runs. Names are agy's own; set
   CLI_AGY_PLAN_TOOLS to change them should a build call them otherwise. */
export const AGY_PLAN_TOOLS_DEFAULT = ['view_file', 'list_dir', 'grep_search', 'find_by_name'];
const agyPlanTools = (env = {}) => {
  const raw = String(env.CLI_AGY_PLAN_TOOLS || '').trim();
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : AGY_PLAN_TOOLS_DEFAULT;
};

/* A project run that may not edit: no shell and read-only tools, so "plan
   only" does not rest on the prompt alone. */
export const agyPlanAgentFile = ({ name, tools, servers = null }) => {
  const mcp = servers && Object.keys(servers).length ? agyMcpServers(servers) : null;
  return [
    '---',
    `name: ${name}`,
    'description: Read-only project planning for Ollama WebUI. Never edits files or runs commands.',
    'mainAgent: true',
    'subagent: false',
    'hidden: true',
    'commandExecutionPolicy: off',
    'tools:',
    ...tools.map(t => `  - ${t}`),
    ...(mcp ? ['inheritMcp: false', `mcpServers: ${JSON.stringify(mcp)}`] : ['inheritMcp: false']),
    '---',
    '',
    '# System Prompt',
    '',
    'You are planning a change in a project. You can read files but cannot modify them or run commands.',
    'Propose the change step by step, naming the files and the edits.',
    '',
  ].join('\n');
};

export const ensureAgyPlanAgent = (env = {}, { servers = null } = {}) => {
  const withMcp = !!(servers && Object.keys(servers).length);
  const name = withMcp ? AGY_AGENTS.planMcp : AGY_AGENTS.plan;
  const file = path.join(agyAgentsDir(env), name, 'agent.md');
  const text = agyPlanAgentFile({ name, tools: agyPlanTools(env), servers: withMcp ? servers : null });
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
  if (current !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  }
  return name;
};

export const agyAgentFile = ({ name, vision, servers = null, full = false }) => {
  const mcp = servers && Object.keys(servers).length ? agyMcpServers(servers) : null;
  return [
    '---',
    `name: ${name}`,
    full
      ? "description: Chat answers for Ollama WebUI, with read and write access to the user's files."
      : `description: Plain chat answers for Ollama WebUI${vision ? ', able to look at attached images' : ''}. Not for coding work.`,
    'mainAgent: true',
    'subagent: false',
    'hidden: true',
    'excludeDefaultComponents: true',
    'inheritCustomizations: false',
    // Left out with full access: agy's default runs the command, as a project run does.
    ...(full ? [] : ['commandExecutionPolicy: off']),
    ...(full ? ['tools:', ...AGY_FULL_TOOLS.map(t => `  - ${t}`)] : vision ? ['tools:', '  - view_file'] : ['tools: []']),
    // Only these servers, never the reader's own agy ones: those are for their
    // coding sessions, as their rules are.
    ...(mcp ? ['inheritMcp: false', `mcpServers: ${JSON.stringify(mcp)}`] : []),
    '---',
    '',
    '# System Prompt',
    '',
    full
      ? "You are the model answering in a chat app, on the user's own PC."
      : 'You are the model answering in a chat app. You are not working in a code repository and have no task beyond the conversation.',
    'If the user message begins with <instructions>, treat what is inside as your system prompt and follow it: it sets who you are, how you speak and what language you answer in.',
    'Answer directly, in Markdown where it helps.',
    full
      ? `You have read and write access to the user's files and can run commands, with these tools: ${AGY_FULL_TOOLS.join(', ')}. When the user asks you to create, edit or fix a file, do it with them -- write_to_file for a new file or a full rewrite, replace_file_content / multi_replace_file_content for an edit -- using absolute paths, and then say briefly what you changed. Read a file with view_file before you edit it. Never paste a whole file into the answer instead of writing it, and never say you cannot modify files. Do not run destructive commands (deleting data, formatting) unless explicitly asked.${vision ? ' When the message names image files, open each with view_file.' : ''}`
      : vision
      ? 'When the message names image files, open each with view_file and answer about what it actually shows. That is the only built-in tool you have.'
      : 'You have no built-in tools.',
    ...(mcp ? [`You do have tools from MCP servers (${Object.keys(mcp).join(', ')}). Call them yourself whenever they would help answer.`] : []),
    /* The app's own tools -- MCP servers, web search, pictures -- are text tags
       it runs itself, as it does for a local model. Saying "no tools" and
       nothing else made the model refuse the tags its instructions offered. */
    'The app may still give you tools: if your instructions describe tool tags (such as <TOOL_MCP server="…" tool="…">…</TOOL_MCP>), those are how you use tools here. Write the tag exactly as described and stop; the app runs it and sends you the result in the next message. Use them whenever they help, and never say you cannot read files or use tools when such tags are offered.',
    '',
  ].join('\n');
};

const agyAgentsDir = (env) => env.AGY_AGENTS_DIR || path.join(HOME, '.gemini', 'config', 'agents');

/* ---------------------------------------- agy's message size, and past it

   Measured on agy's own transcripts: a message is cut at 192,000 bytes,
   with "<truncated N bytes>" where the rest was, however it is split into
   content blocks. Its agent system prompt took 370 KB whole. */
const AGY_MESSAGE_BYTES = 150000;  // what goes in the message, with room to spare
const AGY_TAIL_BYTES = 100000;     // how much of the end stays in the message
const LONG_AGENT_PREFIX = 'ollama-webui-long-';

/** A long message as the head (for the agent) and what is still sent; null when it fits. */
export const splitAgyInput = (text, env = {}) => {
  const limit = Number(env.CLI_AGY_MESSAGE_BYTES) > 0 ? Number(env.CLI_AGY_MESSAGE_BYTES) : AGY_MESSAGE_BYTES;
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length <= limit) return null;
  const tailBytes = Math.min(AGY_TAIL_BYTES, Math.floor(limit * 0.66));
  // At a line, so no word (or UTF-8 character) is cut in two.
  let at = bytes.length - tailBytes;
  const newline = bytes.indexOf(0x0a, at);
  at = newline > 0 && newline < bytes.length - 1 ? newline + 1 : at;
  while (at < bytes.length && (bytes[at] & 0xc0) === 0x80) at++;
  const head = bytes.subarray(0, at).toString('utf8');
  const rest = bytes.subarray(at).toString('utf8');
  return {
    head,
    message: `<message_part_2>\n${rest}\n</message_part_2>`,
  };
};

/** This run's agent: the usual one, with the head of the message in its system prompt. */
export const agyLongAgentFile = ({ name, vision, servers = null, head, full = false }) => [
  agyAgentFile({ name, vision, servers, full }).trimEnd(),
  '',
  "# The user's message, first part",
  '',
  "The user's message is too long to arrive in one piece. Its first part is below, between <message_part_1> tags. The message you receive, between <message_part_2> tags, is the rest of it and continues exactly where part 1 stops. Read the two parts as one single message from the user and answer it as a whole; the instructions at the start of part 1 apply in full.",
  '',
  '<message_part_1>',
  head,
  '</message_part_1>',
  '',
].join('\n');

export const writeAgyLongAgent = (env = {}, { base, vision, servers, head, full = false }) => {
  const root = agyAgentsDir(env);
  // Left over by a server that stopped mid-answer.
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!entry.startsWith(LONG_AGENT_PREFIX)) continue;
      const dir = path.join(root, entry);
      if (Date.now() - fs.statSync(dir).mtimeMs > 6 * 3600 * 1000) fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch { /* nothing to tidy */ }
  const name = `${LONG_AGENT_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
  const dir = path.join(root, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.md'), agyLongAgentFile({ name, vision, servers, head, full }), { encoding: 'utf8', mode: 0o600 });
    return { name, dir, base };
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    return null;
  }
};

/** The agent to run this answer as, written if missing or changed; '' to run agy as itself. */
/* Set when this agy could not find the agent (an older build, or one that
   reads agents from elsewhere): it runs as itself from then on. */
let agyAgentUnavailable = false;

export const ensureAgyAgent = (env = {}, { vision = false, servers = null, full = false } = {}) => {
  if (!flag(env.CLI_AGY_AGENT, true) || agyAgentUnavailable) return '';
  const withMcp = !!(servers && Object.keys(servers).length);
  const name = (withMcp
    ? (vision ? AGY_AGENTS.visionMcp : AGY_AGENTS.chatMcp)
    : (vision ? AGY_AGENTS.vision : AGY_AGENTS.chat)) + (full ? AGY_FULL_SUFFIX : '');
  const file = path.join(agyAgentsDir(env), name, 'agent.md');
  const text = agyAgentFile({ name, vision, servers: withMcp ? servers : null, full });
  try {
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
    if (current !== text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
    }
    return name;
  } catch {
    return '';                                  // cannot write it: run agy as itself
  }
};

/**
 * argv and stdin for one answer. `files` is a scratch directory the caller
 * owns and removes afterwards.
 */
export const buildInvocation = (provider, model, { system, prompt, images = [] }, {
  think, files, tools = null, env = {}, resume = '', persist = false, project = null,
} = {}) => {
  const effort = effortOf(think, provider, env);
  /* The model's reasoning, asked for unless the chat switched thinking off.
     Neither CLI shows it headless by default: Claude Code has the API omit
     it, and Codex asks for no summary. */
  const wantThinking = think !== false;
  const servers = tools?.servers || {};
  const hasServers = Object.keys(servers).length > 0;

  // Keep this in the invocation, not only the browser prompt: resumed and
  // API-driven chats need the same distinction between intent and execution.
  if (hasServers && !project) system = [
    system || 'You are a helpful assistant.',
    '[Tool execution]',
    'When the user asks you to perform work, use the available tools to do it in this turn, within the user-authorized scope. A promise or plan is not execution.',
    'A brief progress message must be followed by the actual tool call, not a final answer saying you will start.',
    'Use the project path and task already supplied in the conversation or its summary. Inspect that location with an available tool before asking the user to resend source files or a path.',
    'After a tool result, continue the requested work until complete or genuinely blocked. If blocked, report the attempted operation and actual error, and ask only for the missing information.',
    'Do not infer that every MCP server can write: use only capabilities actually offered, and respect permissions, plan-only requests, cancellations and required approvals.',
    'Report only changes, tests and uploads supported by tool results. Do not retry external side effects merely because a prior answer was incomplete.',
  ].join('\n\n');

  if (project) return buildProjectInvocation(provider, model, { system, prompt, images }, {
    effort, wantThinking, files, servers, hasServers, env, resume, persist, project, tools,
  });

  if (provider.id === 'claude-code') {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // No built-in tools, and no MCP servers but the ones handed over below:
      // this is a chat, and a chat message that can run commands on the host
      // is a remote shell with extra steps -- unless full access was chosen
      // (see fullAccessOf), when it has every tool, every drive and no prompts.
      ...(fullAccessOf(env)
        ? ['--permission-mode', 'bypassPermissions', ...allRoots().flatMap(root => ['--add-dir', root])]
        : ['--tools', tools?.web ? 'WebSearch,WebFetch' : '']),
      '--strict-mcp-config',
      '--disable-slash-commands',
      // Kept only when it may be resumed (server/cliSessions.js); in the
      // scratch directory's own project, never the reader's.
      ...(persist || resume ? [] : ['--no-session-persistence']),
      ...(resume ? ['--resume', resume] : []),
      '--model', model,
    ];
    const allowed = tools?.web ? ['WebSearch', 'WebFetch'] : [];
    if (hasServers) {
      const mcp = claudeMcpConfig(servers);
      const configFile = path.join(files, 'mcp.json');
      fs.writeFileSync(configFile, JSON.stringify(mcp.config), 'utf8');
      args.push('--mcp-config', configFile);
      allowed.push(...mcp.allowed);
      if (mcp.denied.length) args.push('--disallowedTools', mcp.denied.join(','));
    }
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    // Replacing Claude Code's own system prompt, which is about being a coding
    // agent in a repository. A file rather than an argument, because a
    // character card is longer than Windows allows a command line to be.
    const systemFile = path.join(files, 'system.txt');
    fs.writeFileSync(systemFile, (system || 'You are a helpful assistant.') + (fullAccessOf(env) ? FULL_ACCESS_NOTE : ''), 'utf8');
    args.push('--system-prompt-file', systemFile);
    if (effort) args.push('--effort', effort);
    const display = thinkingDisplayOf(env);
    if (wantThinking && display) args.push('--thinking-display', display);

    const content = [{ type: 'text', text: prompt }];
    for (const data of images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: imageMime(data), data } });
    }
    const stdin = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
    return { args, stdin };
  }

  if (provider.id === 'codex') {
    /* Not `codex exec`: its `--json` hands each message over whole when it is
       finished, so an answer appeared all at once after a long blank. The app
       server speaks JSON-RPC on stdio and sends `item/agentMessage/delta` per
       token -- and takes a system prompt that replaces Codex's own, which is
       about being a coding agent, rather than being prepended to it. */
    const input = [{ type: 'text', text: prompt, text_elements: [] }];
    images.forEach((data, i) => {
      const ext = imageMime(data).split('/')[1] || 'png';
      const file = path.join(files, `image-${i}.${ext}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      input.push({ type: 'localImage', path: file });
    });
    return {
      // `-c` belongs to `codex` itself and carries into its subcommands.
      args: [
        ...(hasServers ? codexMcpOverrides(servers, { approve: true }) : []),
        ...(wantThinking && reasoningSummaryOf(env) ? ['-c', `model_reasoning_summary=${JSON.stringify(reasoningSummaryOf(env))}`] : []),
        'app-server',
      ],
      session: new CodexSession({
        thread: {
          model,
          cwd: workDir(),
          // Codex has no "no tools" switch. Read-only is the nearest thing:
          // it can look, it cannot change anything, and it is never asked.
          // Full access (see fullAccessOf) lifts the sandbox altogether.
          sandbox: fullAccessOf(env) ? 'danger-full-access' : 'read-only',
          approvalPolicy: 'never',
          ephemeral: !(persist || resume),
          baseInstructions: fullAccessOf(env) ? (system || 'You are a helpful assistant.') + FULL_ACCESS_NOTE : [
            system || 'You are a helpful assistant.',
            /* The read-only sandbox is only Codex's own shell. Told nothing,
               Codex read "sandbox: read-only" in its context and refused to
               make files, even with a workbench MCP server that can. */
            hasServers
              ? "\n\nNote: the read-only sandbox applies only to your built-in shell and patch tools. Your MCP tools run outside it and CAN read and write files on the user's PC (within the folders they allow). When the user asks you to create or edit files, do it with those MCP tools (e.g. write_file / edit_file with absolute paths) -- never say the PC connection is read-only, and do not ask the user to change permissions unless an MCP tool actually returned a permission error."
              : '',
          ].join(''),
        },
        turn: { input, ...(effort ? { effort } : {}) },
        resume,
      }),
    };
  }

  if (provider.id === 'agy') {
    /* Pictures as files, in the directory this run starts in -- its
       workspace, where reading needs no permission -- named by absolute
       path, with leave to open those and nothing else. */
    const full = fullAccessOf(env);
    const agent = ensureAgyAgent(env, { vision: images.length > 0, servers: hasServers ? servers : null, full });
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--disable-slash-commands',
      '--model', model,
      ...(agent ? ['--agent', agent] : []),
      ...(resume ? ['--conversation', resume] : []),
      // `-p` takes the next argument as the prompt; empty, it reads stdin.
      '--print=',
    ];
    const pictures = images.map((data, i) => {
      const ext = imageMime(data).split('/')[1] || 'png';
      const file = path.join(files, `image-${i + 1}.${ext}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    });
    /* With the tools toggle on, the app's tool tags are in the instructions
       and are the way to use them; agy's own tools stay off either way. */
    const appTools = !!tools;
    const ownTools = fullAccessOf(env)
      ? `You have full read and write access to the user's PC. When asked to create, edit or continue work on files, use your file and command tools directly with absolute paths (by default a new folder on their Desktop, ${path.join(HOME, 'Desktop')}, for new work). Do not run destructive commands unless explicitly asked.`
      : hasServers
      /* This agy build ignores the agent's `tools: []` and `mcpServers` (it
         loads MCP only from the global mcp_config.json or plugins), so the
         MCP write_file is not there. Told to use it, the model wrote with
         run_command, which the chat cannot show; its own file tools are
         read back from the transcript as file cards (agyEditCards). */
      ? `Do not use run_command or the browser. To create or edit files, use your write_to_file / replace_file_content / multi_replace_file_content tools with absolute paths in a folder the user will find -- by default a new folder on their Desktop (${path.join(HOME, 'Desktop')}); never in your current directory, which is a hidden temp folder the user never sees. Use any tool tags your instructions describe as well.`
      : appTools
        ? "Do not use agy's own tools, files or browser. When a tool would help, use the tool tags your instructions describe: write the tag and stop, and the app runs it and returns the result."
        : 'Do not use any tools, files or the browser.';
    const rules = pictures.length
      ? [
        `The user attached ${pictures.length === 1 ? 'an image' : `${pictures.length} images`}, saved at:`,
        ...pictures.map(file => `  ${file}`),
        'Open each one with your view_file tool and look at it before answering, and answer about what it actually shows.',
        `Apart from viewing these images: ${ownTools} Do not mention the file paths to the user; to them these are simply the images they sent.\n`,
      ].join('\n')
      : `Answer directly in text. ${ownTools}\n`;
    let text = [
      // A resumed conversation has had them: the history it was found by
      // includes every instruction in it.
      system && !resume ? `<instructions>\n${system}\n</instructions>\n` : '',
      rules,
      prompt,
    ].join('\n').trim();
    /* agy keeps only the first 192,000 bytes of a message and drops the rest
       without a word -- the END of it, which is the newest message and the
       instructions placed after the history. A roleplay with a long preset
       and first message passed that by its second turn, and the model, never
       shown what was just said, wrote its first answer again. An agent's
       system prompt has no such limit, so the head of a long message goes
       there, in an agent made for this one run, and the message carries the
       rest. See splitAgyInput. */
    const split = agent ? splitAgyInput(text, env) : null;
    let extra = {};
    if (split) {
      const long = writeAgyLongAgent(env, { base: agent, vision: images.length > 0, servers: hasServers ? servers : null, head: split.head, full });
      if (long) {
        args[args.indexOf(agent)] = long.name;
        text = split.message;
        // Its first part lives only in this run's agent: a later turn could
        // not resume this conversation and still see it.
        extra = { cleanupDirs: [long.dir], unresumable: true };
      }
    }
    const stdin = `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text }] } })}\n`;
    return { args, stdin, extraEnv: hasServers ? agyServerEnv(servers) : {}, ...(pictures.length ? { cwd: files } : {}), ...extra };
  }

  throw new Error(`Unknown CLI ${provider.id}`);
};

export const APPROVAL_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcpApproval.mjs');

/**
 * Project mode (server/cliProject.js): the CLI as the coding agent it is, in
 * the reader's folder, with its own instructions and the folder's CLAUDE.md /
 * AGENTS.md / GEMINI.md, and everything beyond reading and editing there
 * asked about in the browser. `plan` reads and proposes; nothing is changed.
 */
const buildProjectInvocation = (provider, model, { system, prompt, images = [] }, {
  effort, wantThinking, files, servers, hasServers, env, resume, persist, project, tools,
}) => {
  const plan = project.mode === 'plan';
  const persona = system ? `\n<chat-instructions>\n${system}\n</chat-instructions>\n` : '';

  if (provider.id === 'claude-code') {
    const approvals = path.join(files, 'approvals');
    fs.mkdirSync(approvals, { recursive: true });
    const mcp = claudeMcpConfig(hasServers ? servers : {});
    mcp.config.mcpServers.webui_approval = { type: 'stdio', command: process.execPath, args: [APPROVAL_SERVER, '--dir', approvals], env: {} };
    const configFile = path.join(files, 'mcp.json');
    fs.writeFileSync(configFile, JSON.stringify(mcp.config), 'utf8');
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(plan
        ? ['--permission-mode', 'plan']
        : fullAccessOf(env)
          // Full access: nothing is asked, and every drive is in reach.
          ? ['--permission-mode', 'bypassPermissions', ...allRoots().flatMap(root => ['--add-dir', root])]
          : ['--permission-mode', 'acceptEdits']),
      '--permission-prompt-tool', 'mcp__webui_approval__ask',
      '--mcp-config', configFile,
      '--strict-mcp-config',
      ...(persist || resume ? [] : ['--no-session-persistence']),
      ...(resume ? ['--resume', resume] : []),
      '--model', model,
      ...(project.maxTurns ? ['--max-turns', String(project.maxTurns)] : []),
    ];
    const allowed = [...mcp.allowed, ...(tools?.web ? ['WebSearch', 'WebFetch'] : [])];
    if (allowed.length) args.push('--allowedTools', allowed.join(','));
    if (mcp.denied.length) args.push('--disallowedTools', mcp.denied.join(','));
    // Added to Claude Code's own prompt rather than replacing it: here it is
    // the coding agent, and CLAUDE.md is read as it is in the terminal.
    if (system) {
      const systemFile = path.join(files, 'system.txt');
      fs.writeFileSync(systemFile, system, 'utf8');
      args.push('--append-system-prompt-file', systemFile);
    }
    if (effort) args.push('--effort', effort);
    const display = thinkingDisplayOf(env);
    if (wantThinking && display) args.push('--thinking-display', display);
    const content = [{ type: 'text', text: prompt }];
    for (const data of images) content.push({ type: 'image', source: { type: 'base64', media_type: imageMime(data), data } });
    return { args, stdin: `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`, cwd: project.dir, approvalDir: approvals };
  }

  if (provider.id === 'codex') {
    const text = plan
      ? `Plan only: read what you need and propose the change step by step. Do not modify any file.\n\n${prompt}`
      : prompt;
    const input = [{ type: 'text', text, text_elements: [] }];
    images.forEach((data, i) => {
      const file = path.join(files, `image-${i}.${imageMime(data).split('/')[1] || 'png'}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      input.push({ type: 'localImage', path: file });
    });
    return {
      args: [
        ...(hasServers ? codexMcpOverrides(servers) : []),
        ...(wantThinking && reasoningSummaryOf(env) ? ['-c', `model_reasoning_summary=${JSON.stringify(reasoningSummaryOf(env))}`] : []),
        'app-server',
      ],
      cwd: project.dir,
      session: new CodexSession({
        thread: {
          model,
          cwd: project.dir,
          // Writes inside the folder; anything else is asked about -- or,
          // with full access, anywhere and without asking.
          sandbox: plan ? 'read-only' : (fullAccessOf(env) ? 'danger-full-access' : 'workspace-write'),
          approvalPolicy: !plan && fullAccessOf(env) ? 'never' : 'on-request',
          ephemeral: !(persist || resume),
          // Codex's own instructions and AGENTS.md stay; the chat's are added.
          ...(system ? { developerInstructions: system } : {}),
        },
        turn: { input, ...(effort ? { effort } : {}) },
        resume,
      }),
    };
  }

  if (provider.id === 'agy') {
    /* agy has no way to ask before it acts, so it edits only when the reader
       has said in .env that it may; otherwise it plans. */
    const mayEdit = !plan && (fullAccessOf(env) || flag(env.CLI_AGY_PROJECT_EDIT, false));
    /* Not allowed to edit: always the read-only plan agent, so the rule is
       enforced by agy and not only asked for in the prompt. If the agent cannot
       be written, refuse rather than run agy with its full default tools. */
    let agent = '';
    if (!mayEdit) {
      try { agent = ensureAgyPlanAgent(env, { servers: hasServers ? servers : null }); }
      catch (e) { throw new Error(`Could not prepare agy's read-only plan agent: ${e.message}`); }
    } else if (hasServers) {
      // The chat agent has no file tools of its own; an editing run needs them.
      agent = ensureAgyAgent(env, { vision: images.length > 0, servers, full: true });
    }
    const pictures = images.map((data, i) => {
      const file = path.join(files, `image-${i + 1}.${imageMime(data).split('/')[1] || 'png'}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    });
    const rules = [
      `You are working in the project at ${project.dir}. Follow its GEMINI.md / AGENTS.md if present.`,
      mayEdit
        ? (fullAccessOf(env)
          ? 'You have full read and write access to this PC. Work in this folder by default; other folders are allowed when the task needs them. Do not run destructive commands unless explicitly asked.'
          : 'You may read and edit files inside this folder. Do not touch anything outside it, and do not run destructive commands.')
        : 'Plan only: read what you need and propose the change step by step. Do not modify any file and do not run commands.',
      pictures.length ? `The user attached images, saved at:\n${pictures.map(f => `  ${f}`).join('\n')}\nOpen them with view_file before answering.` : '',
    ].filter(Boolean).join('\n');
    const body = [persona && !resume ? persona : '', rules, '', prompt].join('\n').trim();
    return {
      args: [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--disable-slash-commands',
        '--model', model,
        ...(agent ? ['--agent', agent] : []),
        ...(resume ? ['--conversation', resume] : []),
        '--print=',
      ],
      stdin: `${JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text: body }] } })}\n`,
      cwd: project.dir,
      extraEnv: hasServers ? agyServerEnv(servers) : {},
    };
  }

  throw new Error(`Unknown CLI ${provider.id}`);
};

/* --------------------------------------------------------------- limits

   How much of each subscription is left, and when it comes back.

   Nobody here asks a server for this: that would mean lifting the CLI's
   sign-in and calling the provider with it, which this file does not do. The
   CLIs say it themselves -- Claude Code sends a `rate_limit_event` with every
   answer, Codex an `account/rateLimits/updated` notification, and Codex also
   writes the last figures into its session logs -- so what is shown is the
   last thing a CLI said, with when it said it. Kept on disk, so a restart does
   not forget it until the next answer.

   One shape for all of them:
     { status, updatedAt, source, windows: [{ id, usedPercent, resetsAt, windowMins }],
       overage, credits, plan } */

const WINDOW_MINS = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_overage_included: 10080 };

/* Seconds or milliseconds since the epoch, or an ISO date, as milliseconds. */
const toMs = (value) => {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
};

/* A share of a window as a percentage. Claude sends a fraction, Codex a
   percentage; anything at or under one is read as a fraction. */
const toPercent = (value, fraction = null) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const isFraction = fraction ?? n <= 1;
  return Math.max(0, Math.min(100, Math.round((isFraction ? n * 100 : n) * 10) / 10));
};

/** Claude Code's `rate_limit_info`. */
export const claudeLimitsOf = (info = {}) => {
  const windows = [];
  for (const [id, w] of Object.entries(info.unifiedWindows || {})) {
    if (!w) continue;
    windows.push({ id, usedPercent: toPercent(w.utilization), resetsAt: toMs(w.resetsAt), windowMins: WINDOW_MINS[id] || null });
  }
  /* Without the per-window detail, the one window the event is about. */
  if (!windows.length && info.rateLimitType && info.rateLimitType !== 'overage') {
    windows.push({
      id: info.rateLimitType,
      usedPercent: info.utilization !== undefined ? toPercent(info.utilization) : null,
      resetsAt: toMs(info.resetsAt),
      windowMins: WINDOW_MINS[info.rateLimitType] || null,
    });
  }
  return {
    status: info.status || 'allowed',
    windows,
    ...(info.rateLimitType ? { binding: info.rateLimitType } : {}),
    ...(info.resetsAt ? { resetsAt: toMs(info.resetsAt) } : {}),
    overage: info.isUsingOverage ? { using: true, status: info.overageStatus || '' } : null,
  };
};

/** Codex's rate limits, from the app server (camelCase) or a session log (snake_case). */
export const codexLimitsOf = (limits = {}) => {
  const windowOf = (id, w) => (w ? {
    id,
    usedPercent: toPercent(w.usedPercent ?? w.used_percent, false),
    resetsAt: toMs(w.resetsAt ?? w.resets_at),
    windowMins: Number(w.windowDurationMins ?? w.window_minutes) || null,
  } : null);
  const windows = [windowOf('primary', limits.primary), windowOf('secondary', limits.secondary)].filter(Boolean)
    // Named by length rather than "primary", which says nothing to a reader.
    .map(w => ({ ...w, id: w.windowMins === 300 ? 'five_hour' : w.windowMins === 10080 ? 'seven_day' : w.id }));
  const credits = limits.credits
    ? { has: !!(limits.credits.hasCredits ?? limits.credits.has_credits), unlimited: !!limits.credits.unlimited, balance: limits.credits.balance ?? null }
    : null;
  const full = windows.some(w => w.usedPercent >= 100);
  return {
    status: full ? 'rejected' : windows.some(w => w.usedPercent >= 80) ? 'allowed_warning' : 'allowed',
    windows,
    credits,
    ...(limits.planType || limits.plan_type ? { plan: limits.planType || limits.plan_type } : {}),
  };
};

const limitsFile = () => path.join(
  process.env.WEBUI_DATA_DIR ? path.resolve(process.env.WEBUI_DATA_DIR) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'),
  'cli-limits.json',
);
let limitsStore = null;
const loadLimits = () => {
  if (limitsStore) return limitsStore;
  try { limitsStore = JSON.parse(fs.readFileSync(limitsFile(), 'utf8')) || {}; } catch { limitsStore = {}; }
  return limitsStore;
};

/** Remember what a CLI just said about its limits. */
export const noteLimits = (id, limits, source = 'run') => {
  if (!limits) return;
  const store = loadLimits();
  const previous = store[id] || {};
  // An event about one window keeps the others it did not mention.
  const windows = [...(limits.windows || [])];
  for (const old of previous.windows || []) if (!windows.some(w => w.id === old.id)) windows.push(old);
  store[id] = { ...previous, ...limits, windows, updatedAt: Date.now(), source };
  // Only what the CLI said just now, for the forecast (server/cliProject.js).
  if (source === 'run' || source === 'live') noteLimitHistory(id, limits);
  try {
    fs.mkdirSync(path.dirname(limitsFile()), { recursive: true });
    fs.writeFileSync(limitsFile(), JSON.stringify(store, null, 2));
  } catch { /* shown from memory until the next write works */ }
};

/* A run refused for being over the limit says so, even if no event came. */
export const noteLimitError = (id, message, model = '') => {
  if (!LIMIT_ERROR.test(String(message || ''))) return;
  const store = loadLimits();
  /* agy never says how much a window holds; the runs before it said "limit"
     are the best guess, kept for the estimate in allLimits. */
  if (id === 'agy') {
    const group = agyQuotaGroup(model);
    if (!group) return; // A provider-wide refusal cannot identify a quota pool.
    noteLimits(id, { poolErrors: { ...(store[id]?.poolErrors || {}),
      [group]: { updatedAt: Date.now(), message: String(message).slice(0, 300) } } }, 'error');
    return;
  }
  const learned = id === 'agy' ? learnAgyCapacity(readUsage({ since: Date.now() - 5 * 3600 * 1000 })) : null;
  noteLimits(id, {
    ...(store[id] || { windows: [] }), status: 'rejected', lastError: String(message).slice(0, 300),
    ...(learned ? { learnedCapacity: learned } : {}),
  }, 'error');
};

/* The newest figures Codex wrote into its own session logs, for before this
   app has run Codex at all. Only the ends of the newest few files are read. */
export const codexLimitsFromLogs = ({ home = HOME, env = {} } = {}) => {
  const root = path.join(env.CODEX_HOME || process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { /* gone */ }
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { full, mtime } of files.slice(0, 5)) {
    let text;
    try {
      const fd = fs.openSync(full, 'r');
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 512 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      fs.closeSync(fd);
      text = buffer.toString('utf8');
    } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const line = JSON.parse(lines[i]);
        const limits = line.payload?.rate_limits || line.rate_limits;
        if (limits?.primary || limits?.secondary) {
          const at = toMs(line.timestamp) || mtime;
          return { ...codexLimitsOf(limits), updatedAt: at, source: 'codex-log' };
        }
      } catch { /* a line cut by the read window */ }
    }
  }
  return null;
};

/** agy's `quota`, as its status line hands it over: buckets of remaining fractions. */
export const agyLimitsOf = (quota = {}) => {
  const windows = Object.entries(quota || {})
    .filter(([, b]) => b && Number.isFinite(Number(b.remaining_fraction)))
    .map(([id, b]) => ({
      id,
      usedPercent: toPercent(1 - Number(b.remaining_fraction), true),
      resetsAt: toMs(b.reset_time) || (Number(b.reset_in_seconds) > 0 ? Date.now() + Number(b.reset_in_seconds) * 1000 : null),
      windowMins: /5h|five/i.test(id) ? 300 : /week/i.test(id) ? 10080 : /day|daily/i.test(id) ? 1440 : null,
    }));
  return {
    status: windows.some(w => w.usedPercent >= 100) ? 'rejected' : windows.some(w => w.usedPercent >= 80) ? 'allowed_warning' : 'allowed',
    windows,
  };
};

/* What server/agyStatusline.mjs last wrote, when agy last drew its status
   line in a terminal. The only place agy says what is left. */
const agyLimitsFromStatusline = () => {
  try {
    const dir = process.env.WEBUI_DATA_DIR ? path.resolve(process.env.WEBUI_DATA_DIR) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'agy-quota.json'), 'utf8'));
    if (!record?.quota) return null;
    return { ...agyLimitsOf(record.quota), ...(record.plan ? { plan: record.plan } : {}), updatedAt: record.at || null, source: 'agy-statusline' };
  } catch { return null; }
};

/* ---------------------------------------------------------- live limits

   What a CLI said with its last answer goes stale the moment the same
   subscription is used anywhere else -- a terminal, the web, another PC -- so
   the header showed the old figure until the next chat here. These ask the
   provider directly, at most once per CLI_LIMITS_LIVE_SECONDS (60 by
   default), when /cli/limits is read. CLI_LIMITS_LIVE=false turns it off.

   Claude: the same usage endpoint Claude Code's own /usage reads, with the
   sign-in Claude Code keeps on this PC, sent only to Anthropic. The token is
   never refreshed here; an expired one waits for the CLI to renew it.
   Codex: its own app server, asked `account/rateLimits/read` -- no turn is
   started and no quota spent. */

const liveState = new Map(); // id -> { at, failedAt, running }

const claudeTokenOf = (env) => {
  const fromEnv = env.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const dir = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
    const oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (Number(oauth.expiresAt) && Number(oauth.expiresAt) < Date.now() + 30_000) return null;
    return oauth.accessToken;
  } catch { return null; }
};

const claudeLiveLimits = async (env) => {
  const token = claudeTokenOf(env);
  if (!token) return null;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`claude usage ${res.status}`);
  const body = await res.json();
  const windows = [];
  for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    const w = body?.[id];
    if (!w || !Number.isFinite(Number(w.utilization))) continue;
    windows.push({ id, usedPercent: toPercent(w.utilization, false), resetsAt: toMs(w.resets_at), windowMins: WINDOW_MINS[id] || null });
  }
  if (!windows.length) return null;
  const full = windows.some(w => w.usedPercent >= 100);
  return { status: full ? 'rejected' : windows.some(w => w.usedPercent >= 80) ? 'allowed_warning' : 'allowed', windows, lastError: undefined };
};

const codexLiveLimits = (env) => new Promise((resolve, reject) => {
  const binary = resolveBinary(PROVIDERS.codex, env);
  if (!binary) { resolve(null); return; }
  let child;
  try {
    child = spawn(binary.command, [...binary.prefix, 'app-server'], {
      cwd: workDir(),
      env: { ...process.env, ...authEnvOf(PROVIDERS.codex, env), NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (e) { reject(e); return; }
  let buffer = '';
  let done = false;
  const finish = (err, value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { child.stdin.end(); } catch { /* closed */ }
    try { child.kill(); } catch { /* gone */ }
    if (err) reject(err); else resolve(value);
  };
  const timer = setTimeout(() => finish(new Error('codex rate limits timed out')), 15_000);
  const write = (m) => { try { child.stdin.write(`${JSON.stringify(m)}\n`); } catch { /* closed */ } };
  child.on('error', e => finish(e));
  child.on('exit', () => finish(new Error('codex app-server exited')));
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) {
        write({ method: 'initialized' });
        write({ id: 2, method: 'account/rateLimits/read' });
      } else if (m.id === 2) {
        if (m.error) { finish(new Error(m.error.message || 'codex rate limits failed')); return; }
        const r = m.result?.rateLimits || m.result;
        finish(null, r?.primary || r?.secondary ? codexLimitsOf(r) : null);
      }
    }
  });
  write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ollama-webui', title: 'Ollama WebUI', version: '1.0.0' } } });
});

const LIVE_PROBES = { 'claude-code': claudeLiveLimits, codex: codexLiveLimits };

/** Ask each signed-in CLI's provider for its limits, if not asked lately. */
export const refreshLiveLimits = async (env = {}, { force = false } = {}) => {
  if (!flag(env.CLI_LIMITS_LIVE, true)) return;
  const every = Math.max(15, Number(env.CLI_LIMITS_LIVE_SECONDS) || 60) * 1000;
  const now = Date.now();
  await Promise.all(Object.entries(LIVE_PROBES).map(async ([id, probe]) => {
    const state = liveState.get(id) || {};
    if (state.running) return state.running;
    if (!force && state.at && now - state.at < every) return null;
    // A failure (no sign-in, offline) is not retried for five minutes.
    if (state.failedAt && now - state.failedAt < 5 * 60_000) return null;
    const running = (async () => {
      try {
        const limits = await probe(env);
        if (limits) noteLimits(id, limits, 'live');
        liveState.set(id, { at: Date.now() });
      } catch {
        liveState.set(id, { at: Date.now(), failedAt: Date.now() });
      }
    })();
    liveState.set(id, { ...state, running });
    return running;
  }));
};

/** Every CLI's limits, as last heard. */
export const allLimits = (env = {}) => {
  const store = { ...loadLimits() };
  const fromLogs = codexLimitsFromLogs({ env });
  if (fromLogs && !(store.codex?.updatedAt >= fromLogs.updatedAt)) store.codex = { ...store.codex, ...fromLogs };
  const fromAgy = agyLimitsFromStatusline();
  if (fromAgy && !(store.agy?.updatedAt >= fromAgy.updatedAt)) store.agy = { ...store.agy, ...fromAgy };
  /* Nothing from agy's status line in the last hour: counted from the ledger
     instead, when there is a capacity to count against. A refusal still wins. */
  if (!(fromAgy?.updatedAt > Date.now() - 3600 * 1000) && store.agy?.status !== 'rejected'
    && (Number(env.CLI_AGY_5H_RUNS) > 0 || store.agy?.learnedCapacity)) {
    const estimate = agyEstimate(readUsage({ since: Date.now() - 5 * 3600 * 1000 }), env, { learned: store.agy?.learnedCapacity || null });
    if (estimate) store.agy = { ...store.agy, ...estimate };
  }
  const now = Date.now();
  for (const [id, entry] of Object.entries(store)) store[id] = settleResets(entry, now);
  return store;
};

/**
 * A window whose reset has passed is empty again, whatever was last said.
 *
 * And a refusal ends with it: once a window has reset since the refusal was
 * heard and no window is still full, the CLI is usable again. Waiting for
 * *every* window to reset kept "limit reached" on screen for days after the
 * 5-hour window came back, because the weekly one (not full) had not reset.
 * A refusal heard only as an error, with no window to show for it, waits for
 * an actual reset rather than being dropped at once.
 */
export const settleResets = (entry = {}, now = Date.now()) => {
  const windows = (entry.windows || []).map(w => (
    Number.isFinite(w.resetsAt) && w.resetsAt <= now ? { ...w, usedPercent: 0, reset: true, forecast: undefined } : w));
  if (entry.status !== 'rejected') return { ...entry, windows };
  const heard = Number(entry.updatedAt) || 0;
  // A full window that has reset is what the refusal was about; any other
  // window counts only if it reset after the refusal was heard.
  const resetSince = windows.some((w, i) => w.reset
    && ((entry.windows[i]?.usedPercent >= 100) || w.resetsAt > heard))
    || (Number.isFinite(entry.resetsAt) && entry.resetsAt <= now && entry.resetsAt > heard);
  const stillFull = windows.some(w => !w.reset && w.usedPercent >= 100)
    || (Number.isFinite(entry.resetsAt) && entry.resetsAt > now);
  if (!resetSince || stillFull) return { ...entry, windows };
  const warning = windows.some(w => !w.reset && w.usedPercent >= 80);
  return { ...entry, windows, status: warning ? 'allowed_warning' : 'allowed' };
};

/* ------------------------------------------------------ reading the output

   Each reader takes one parsed JSON line and returns what it adds:
   `{ content, thinking }` deltas, and on the last line `usage`, `error` or
   `done`. They are classes because each CLI repeats itself -- Claude Code
   sends every delta and then the whole message again -- and knowing which
   copy to ignore needs a little state. */

/* How a tool the CLI ran is shown: a line in the thinking, since it is the
   model working rather than the answer, and a reader watching a long pause
   deserves to know it is a web search and not a hang. */
const toolNote = (label, detail = '') => `${stampNote()}\n[${label}${detail ? `: ${String(detail).slice(0, 200)}` : ''}]\n`;

/* When a step happened, on a line of its own before it, so the timeline can
   say how long each took (src/agentActivity.js). */
const stampNote = () => `\n[at: ${Date.now()}]`;

/* A tool call's arguments on one line, for the timeline to show on request. */
const inputNote = (input) => {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return '';
  let json = '';
  try { json = JSON.stringify(input); } catch { return ''; }
  return `[input: ${json.length > 1500 ? `${json.slice(0, 1500)}…` : json}]\n`;
};

/* The start of what a tool returned, when it is neither a diff nor a command. */
const resultNote = (text) => {
  const body = String(text || '').trim().split('\n').slice(0, 12).join('\n').slice(0, 1200);
  return body ? `[result]\n${body}\n[/output]\n` : '';
};

/* `mcp__files__read_text_file` -> `files / read_text_file`. */
const claudeToolLabel = (name) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''));
  return m ? `${m[1]} / ${m[2]}` : String(name || 'tool');
};

/* The one argument that says what a tool call is about -- the file, the
   command, the query -- for the note that shows it. */
export const toolTarget = (input = {}) => {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'notebook_path', 'url', 'query', 'pattern', 'prompt', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return '';
};

/* What a tool did, for the reader rather than the model.

   The model sees its tool results; the reader, watching a CLI work inside its
   own loop, saw only "[tool: workbench / edit_file]" go by and then an answer
   saying it had changed some files. Each file change the workbench reports
   (server/workbench.js) is put into the answer as its diff, where it stays
   with the message; a command goes into the thinking with its exit code and
   the end of its output. */
export const changesAsMarkdown = (text) => fileChangesIn(text).map(change => [
  '',
  `📝 **\`${change.file}\`** (+${change.added} −${change.removed})`,
  '```diff',
  change.diff,
  '```',
  '',
].join('\n')).join('\n');

const commandNote = (text) => {
  const command = commandIn(text);
  if (!command) return '';
  const output = String(text).split('\n').slice(1).join('\n').trim().split('\n').slice(-15).join('\n');
  return commandNoteOf(command.command, command.timedOut ? 'timed out' : `exit ${command.code}`, output);
};

/* `[command: … → exit N]`, its output, and `[/output]` so the thinking after
   it is not read as more output (src/agentActivity.js). */
function commandNoteOf(command, verdict, output) {
  const end = String(output || '').trim();
  return `${stampNote()}\n[command: ${String(command).replace(/\s+/g, ' ').slice(0, 200)} → ${verdict}]\n${end ? `${end}\n[/output]\n` : ''}`;
}

/* A tool result's text, from any of the shapes it comes in. */
const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n');
  if (content && typeof content === 'object') return resultText(content.content);
  return '';
};

/* What one tool result adds: its diffs to the answer, its command to the thinking. */
export const toolResultOutput = (text) => {
  const content = changesAsMarkdown(text);
  const thinking = commandNote(text);
  return content || thinking ? { ...(content ? { content } : {}), ...(thinking ? { thinking } : {}) } : null;
};

/* A change Claude Code's own Edit / MultiEdit / Write made, from the
   `tool_use_result` its stream-json puts beside the result, written the way
   the workbench writes one (`[file-change] …` and a diff) so the answer shows
   it the same way. A new file has no patch: all of it is added. */
export const nativeChangeText = (result) => {
  const file = typeof result?.filePath === 'string' ? result.filePath : '';
  if (!file) return '';
  let hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  if (!hunks.length && result.type === 'create' && typeof result.content === 'string') {
    const lines = result.content.replace(/\r?\n$/, '').split(/\r?\n/);
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => `+${l}`) }];
  }
  if (!hunks.length) return '';
  let added = 0, removed = 0;
  const body = [];
  for (const h of hunks) {
    const lines = Array.isArray(h?.lines) ? h.lines.map(String) : [];
    body.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...lines);
    added += lines.filter(l => l.startsWith('+')).length;
    removed += lines.filter(l => l.startsWith('-')).length;
  }
  const name = file.split(/[\\/]/).pop();
  return `[file-change] ${file} (+${added} -${removed})\n\`\`\`diff\n--- a/${name}\n+++ b/${name}\n${body.join('\n')}\n\`\`\``;
};

const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

export class ClaudeReader {
  constructor() { this.sawText = false; this.usage = {}; this.textInMessage = false; this.gap = false; this.sessionId = ''; }

  /* The run is over (finished, stopped or timed out): a command whose result
     never came is not left "running" in the corner for six hours. */
  close() {
    for (const id of this.commands || []) noteCommand({ id, status: 'failed', source: 'claude' });
    this.commands?.clear();
  }

  accept(line) {
    // Every line says which session it belongs to; kept for resuming it.
    if (typeof line.session_id === 'string' && line.session_id) this.sessionId = line.session_id;
    if (line.type === 'stream_event') {
      const event = line.event || {};
      if (event.type === 'content_block_delta') {
        const delta = event.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          /* With tools, one answer is several messages: text, a tool call, a
             result, more text. Each later message is set apart. */
          const gap = this.gap ? '\n\n' : '';
          this.gap = false;
          this.sawText = true;
          this.textInMessage = true;
          return { content: gap + delta.text };
        }
        if (delta.type === 'thinking_delta' && delta.thinking) { this.thoughts = 1; return { thinking: delta.thinking, reasoning: true }; }
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const open = this.tools?.get(event.index);
        if (open) open.json += event.delta.partial_json || '';
        return null;
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block || {};
        /* Each thinking block (one per step between tool calls) is its own
           paragraph; without this they ran into each other and into the
           tool notes. A redacted one is said, not silently dropped. */
        if (block.type === 'thinking' && this.thoughts) return { thinking: '\n\n', reasoning: true };
        if (block.type === 'redacted_thinking') return { thinking: '\n[thinking hidden by the model]\n', reasoning: true };
        if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          /* Said once its arguments are in (content_block_stop), so the note
             can name the file or command and not only the tool. */
          if (!this.tools) this.tools = new Map();
          this.tools.set(event.index, { name: block.name, id: block.id || '', json: '' });
          return null;
        }
      }
      if (event.type === 'content_block_stop' && this.tools?.has(event.index)) {
        const { name, id, json } = this.tools.get(event.index);
        this.tools.delete(event.index);
        let input = {};
        try { input = json ? JSON.parse(json) : {}; } catch { /* half an argument list: the name alone */ }
        /* Claude Code's own shell runs went nowhere but this note, so the
           "running" pill in the corner never came up for a Claude chat. They
           go into the same live list as Codex's; the result closes them. */
        if (id && CLAUDE_SHELL_TOOLS.has(name) && typeof input.command === 'string') {
          noteCommand({ id, command: input.command, status: 'running', source: 'claude' });
          (this.commands ||= new Set()).add(id);
          /* What the work trees it may touch look like now, so the files it
             rewrites (sed, a Python one-off) get cards like an Edit's. */
          try {
            (this.shell ||= new ShellChanges()).watch([...pathsIn(input.command), ...(this.cwd ? [this.cwd] : [])]);
            (this.shellRuns ||= new Set()).add(id);
          } catch { /* no git, or a tree it cannot read: no cards, as before */ }
        } else if (typeof input.file_path === 'string') {
          // A file it reads or edits names a tree worth watching before any shell touches it.
          try { (this.shell ||= new ShellChanges()).watch([input.file_path]); } catch { /* */ }
        }
        const what = toolTarget(input);
        return { thinking: toolNote('tool', `${claudeToolLabel(name)}${what ? ` · ${what}` : ''}`) + inputNote(input) };
      }
      if (event.type === 'message_start') {
        if (this.textInMessage) this.gap = true;
        this.textInMessage = false;
        const usage = event.message?.usage || {};
        this.usage.prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0);
        /* What this one call sent: the context actually in use now. The
           run's `result` later sums every call, which is not a context. */
        if (Number.isFinite(usage.input_tokens)) {
          this.usage.context = this.usage.prompt;
          this.usage.contextEval = 0;
        }
        // The model has begun: generation is timed from here, not from the
        // first visible word, which comes after any unshown thinking.
        if (!this.began) { this.began = true; return { started: true }; }
      }
      if (event.type === 'message_delta' && Number.isFinite(event.usage?.output_tokens)) {
        this.usage.eval = event.usage.output_tokens;
        this.usage.contextEval = event.usage.output_tokens;
      }
      return null;
    }
    /* The results of the tools it ran, handed back to it as a user turn. */
    if (line.type === 'user') {
      const parts = Array.isArray(line.message?.content) ? line.message.content : [];
      const outs = parts.filter(part => part?.type === 'tool_result').map((part) => {
        const text = resultText(part.content);
        if (this.commands?.delete(part.tool_use_id)) {
          noteCommand({ id: part.tool_use_id, output: text, status: part.is_error ? 'failed' : 'done', source: 'claude' });
        }
        const shown = toolResultOutput(text);
        // A failure that is not a command (which carries its own exit code) is said as one.
        if (part.is_error && !shown?.thinking) {
          return { ...(shown || {}), thinking: toolNote('tool failed', text.replace(/^Error:\s*/i, '').split('\n')[0]) };
        }
        // Anything else it returned: the start of it, under the call.
        if (!shown) { const note = resultNote(text); return note ? { thinking: `\n${note}` } : null; }
        return shown;
      }).filter(Boolean);
      /* Claude Code's own Edit / Write (full access, or a project) report no
         `[file-change]`; the patch comes beside the result instead. */
      const native = nativeChangeText(line.tool_use_result);
      if (native) outs.push({ content: changesAsMarkdown(native) });
      // Its own card is shown above; the shell check must not show it again.
      if (typeof line.tool_use_result?.filePath === 'string') this.shell?.seen(line.tool_use_result.filePath);
      const shellDone = parts.some(part => part?.type === 'tool_result' && this.shellRuns?.delete(part.tool_use_id));
      if (shellDone && this.shell) {
        try {
          const reports = this.shell.collect();
          if (reports.length) outs.push({ content: changesAsMarkdown(reports.join('\n\n')) });
        } catch { /* */ }
      }
      if (!outs.length) return null;
      const content = outs.map(o => o.content || '').join('');
      const thinking = outs.map(o => o.thinking || '').join('');
      // The text after it is a new paragraph, not a continuation of the diff.
      if (content) { this.gap = true; this.sawText = true; }
      return { ...(content ? { content } : {}), ...(thinking ? { thinking } : {}) };
    }
    /* What is left of the subscription, sent with every answer. */
    if (line.type === 'rate_limit_event') return { limits: claudeLimitsOf(line.rate_limit_info || {}) };
    if (line.type === 'result') {
      /* The run's own totals, across every message of it, when it gives them. */
      const total = line.usage || {};
      if (Number.isFinite(total.output_tokens)) {
        const { context, contextEval } = this.usage;
        this.usage = {
          prompt: (total.input_tokens || 0) + (total.cache_read_input_tokens || 0) + (total.cache_creation_input_tokens || 0),
          eval: total.output_tokens,
          // Read back from the provider's cache: what resuming saves.
          ...(total.cache_read_input_tokens ? { cached: total.cache_read_input_tokens } : {}),
          fresh: total.input_tokens || 0,
          cacheWrite: total.cache_creation_input_tokens || 0,
          ...(Number.isFinite(context) ? { context, contextEval: contextEval || 0 } : {}),
        };
      }
      if (Number.isFinite(line.total_cost_usd)) this.usage.costUsd = line.total_cost_usd;
      const out = {
        done: true, usage: this.usage, reason: line.stop_reason === 'max_tokens' ? 'length' : 'stop',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      };
      if (line.is_error || (line.subtype && line.subtype !== 'success')) {
        out.error = String(line.result || line.subtype || 'Claude Code failed');
      } else if (!this.sawText && line.result) {
        // No partial messages came through (an older CLI); the whole answer did.
        out.content = String(line.result);
      }
      return out;
    }
    return null;
  }
}

/**
 * One answer from `codex app-server`, which is a conversation rather than a
 * stream: initialize, start a thread, start a turn, then read notifications
 * until the turn completes. `open()` is the first thing to write; `accept`
 * reads one message and may return more to write.
 */
export class CodexSession {
  constructor({ thread, turn, resume = '' }) {
    this.thread = thread;
    this.turn = turn;
    this.resume = resume;
    this.threadId = '';
    this.sent = new Map();       // agent message item -> characters passed on
    this.reasoning = new Map();  // reasoning item -> which kind of delta it uses
    this.messages = 0;
    this.usage = {};
    this.lastError = '';
    this.commands = new Set();   // commands started and not yet completed
  }

  /* The run is over (finished, stopped or timed out). A command Codex never
     reported the end of -- the turn was stopped mid-command -- stayed
     "running" in the corner pill for six hours. As ClaudeReader.close. */
  close() {
    for (const id of this.commands) noteCommand({ id, status: 'failed' });
    this.commands.clear();
  }

  open() {
    return [{ id: 1, method: 'initialize', params: { clientInfo: { name: 'ollama-webui', title: 'Ollama WebUI', version: '1.0.0' } } }];
  }

  /* The text of one agent message, from its deltas or, if none came, whole. A
     second message in one turn is set apart from the first. */
  text(itemId, fresh, whole = false) {
    let gap = '';
    if (!this.sent.has(itemId)) {
      if (this.messages++ > 0) gap = '\n\n';
      this.sent.set(itemId, 0);
    }
    const sent = this.sent.get(itemId);
    const add = whole ? fresh.slice(sent) : fresh;
    this.sent.set(itemId, sent + add.length);
    return add || gap ? { content: gap + add } : null;
  }

  accept(m) {
    if (m.id === 1 && m.result) {
      /* A thread this app ran before (server/cliSessions.js), picked up with
         the same settings it was started with. */
      const { ephemeral, ...settings } = this.thread;
      const open = this.resume
        ? { id: 2, method: 'thread/resume', params: { ...settings, threadId: this.resume } }
        : { id: 2, method: 'thread/start', params: { ...settings, ephemeral } };
      return { write: [{ method: 'initialized' }, open] };
    }
    if (m.id === 2 && m.result) {
      this.threadId = m.result.thread?.id || this.resume || '';
      return { write: [{ id: 3, method: 'turn/start', params: { threadId: this.threadId, ...this.turn } }] };
    }
    if ([1, 2, 3].includes(m.id) && m.error) {
      return { done: true, error: String(m.error.message || 'Codex refused the request') };
    }
    // A request from the server -- an approval, a question. In project mode
    // (`approvalPolicy: on-request`) an approval goes to the browser and the
    // answer comes back through `reply`; anything else, and any approval in
    // chat mode, is declined rather than left waiting forever.
    if (m.id !== undefined && m.method) {
      const ask = this.thread.approvalPolicy === 'on-request' ? codexApprovalOf(m) : null;
      if (ask) return { ask, reply: (decision) => codexApprovalReply(m, decision) };
      return { write: [{ id: m.id, error: { code: -32601, message: 'Not supported by this client' } }] };
    }

    const p = m.params || {};
    switch (m.method) {
      case 'turn/started':
        return { started: true };
      case 'item/agentMessage/delta':
        return p.delta ? this.text(p.itemId || '', String(p.delta)) : null;
      case 'item/commandExecution/outputDelta':
        // Not into the answer: into the live monitor, which shows it as it comes.
        if (p.itemId && p.delta) noteCommand({ id: p.itemId, append: String(p.delta) });
        return null;
      case 'item/started': {
        const item = p.item || {};
        if (item.type === 'mcpToolCall') {
          const input = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
          const what = toolTarget(input);
          return { thinking: toolNote('tool', `${item.server} / ${item.tool}${what ? ` · ${what}` : ''}`) + inputNote(input) };
        }
        if (item.type === 'webSearch') return { thinking: toolNote('web search', item.query) };
        if (item.type === 'commandExecution') {
          const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
          // Watched live like the workbench's (server/liveCommands.js).
          noteCommand({ id: item.id, command, cwd: item.cwd || '', status: 'running' });
          if (item.id) this.commands.add(item.id);
          return { thinking: toolNote('running', command) };
        }
        if (item.type === 'fileChange') return { thinking: toolNote('edit', (item.changes || []).map(c => c.path).join(', ')) };
        return null;
      }
      case 'item/completed': {
        const item = p.item || {};
        if (item.type === 'agentMessage' && typeof item.text === 'string') return this.text(item.id || '', item.text, true);
        /* A thought that came whole, with no deltas before it (some models and
           versions): shown from the finished item, once. */
        if (item.type === 'reasoning' && !this.reasoning.has(item.id)) {
          const parts = [...(item.summary || []), ...(item.summary?.length ? [] : item.content || [])]
            .map(s => (typeof s === 'string' ? s : s?.text || '')).filter(Boolean);
          if (!parts.length) return null;
          this.reasoning.set(item.id, 'whole');
          const lead = this.lastReasoning ? '\n\n' : '';
          this.lastReasoning = item.id;
          return { thinking: lead + parts.join('\n\n'), reasoning: true };
        }
        if (item.type === 'commandExecution') {
          const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
          const code = Number.isInteger(item.exitCode) ? item.exitCode : null;
          const failed = item.status === 'failed' || item.status === 'declined' || (code !== null && code !== 0);
          const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined;
          noteCommand({ id: item.id, command, output, code, status: failed ? 'failed' : 'done' });
          this.commands.delete(item.id);
          const end = String(output || '').trim().split('\n').slice(-15).join('\n');
          return { thinking: commandNoteOf(command, item.status === 'declined' ? 'declined' : `exit ${code ?? '?'}`, end) };
        }
        /* What an edit changed, as Claude Code's edits show it: each file's
           diff (kept short), or why it did not go through. */
        if (item.type === 'fileChange') {
          if (item.status === 'failed' || item.status === 'declined') {
            return { thinking: toolNote('tool failed', `edit ${item.status}: ${(item.changes || []).map(c => c.path).join(', ')}`) };
          }
          const diffs = (item.changes || []).map((c) => {
            const d = String(c.diff || c.unified_diff || '').split('\n').slice(0, 40).join('\n');
            return `${c.kind?.type || c.kind || 'update'} ${c.path}${d ? `\n${d}` : ''}`;
          }).join('\n\n');
          return diffs ? { thinking: `\n${resultNote(diffs)}` } : null;
        }
        if (item.type === 'mcpToolCall' && item.status === 'failed') {
          return { thinking: toolNote('tool failed', item.error?.message || `${item.server} / ${item.tool}`) };
        }
        if (item.type === 'mcpToolCall') {
          const shown = toolResultOutput(resultText(item.result));
          if (shown?.content) this.messages++;       // the next message is set apart from it
          return shown;
        }
        return null;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        // Some models send both a summary and the raw text of one thought.
        // Whichever arrives first is the one shown.
        const kind = m.method.endsWith('summaryTextDelta') ? 'summary' : 'raw';
        const seen = this.reasoning.get(p.itemId);
        if (seen && seen !== kind) return null;
        this.reasoning.set(p.itemId, kind);
        if (!p.delta) return null;
        // A new thought (another reasoning item) starts a new paragraph.
        const lead = this.lastReasoning && this.lastReasoning !== p.itemId ? '\n\n' : '';
        this.lastReasoning = p.itemId;
        return { thinking: lead + String(p.delta), reasoning: true };
      }
      /* One summary is several parts ("**Planning**", "**Checking**"); each
         was glued onto the last. */
      case 'item/reasoning/summaryPartAdded':
        if (Number(p.summaryIndex) > 0 && this.reasoning.get(p.itemId) !== 'raw') return { thinking: '\n\n', reasoning: true };
        return null;
      case 'account/rateLimits/updated':
        return p.rateLimits || p.primary ? { limits: codexLimitsOf(p.rateLimits || p) } : null;
      case 'thread/tokenUsage/updated': {
        /* `last` is the latest call (the context now); `total` sums the turn's
           calls (what was processed and billed). Codex's inputTokens already
           include the cached ones. */
        const last = p.tokenUsage?.last || {};
        const sum = p.tokenUsage?.total && Number.isFinite(p.tokenUsage.total.inputTokens) ? p.tokenUsage.total : last;
        this.usage = {
          prompt: sum.inputTokens, eval: sum.outputTokens,
          ...(sum.cachedInputTokens ? { cached: sum.cachedInputTokens } : {}),
          ...(Number.isFinite(sum.inputTokens) ? { fresh: sum.inputTokens - (sum.cachedInputTokens || 0) } : {}),
          ...(Number.isFinite(last.inputTokens) ? { context: last.inputTokens, contextEval: last.outputTokens || 0 } : {}),
        };
        return null;
      }
      case 'error':
        // Not always the end: a dropped connection being retried is one too.
        // The turn says whether it failed; this is kept for saying why.
        this.lastError = String(p.error?.message || '');
        return null;
      case 'turn/completed': {
        const turn = p.turn || {};
        if (turn.status === 'completed') {
          return { done: true, usage: this.usage, reason: 'stop', ...(this.threadId && !this.thread.ephemeral ? { sessionId: this.threadId } : {}) };
        }
        if (turn.status === 'interrupted') return { done: true, error: 'Generation cancelled' };
        return { done: true, error: String(turn.error?.message || this.lastError || 'Codex failed') };
      }
      default:
        return null;
    }
  }
}

/* agy names its conversation somewhere in what it prints; which field is not
   documented, so any of the likely ones is taken. None found, nothing resumes. */
const agyConversationOf = (line) => {
  for (const source of [line, line.result, line.step_update, line.init]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['conversation_id', 'conversationId', 'session_id', 'sessionId', 'cascade_id', 'cascadeId']) {
      if (typeof source[key] === 'string' && source[key]) return source[key];
    }
  }
  return '';
};

export class AgyReader {
  constructor() { this.sawText = false; this.sessionId = ''; }

  accept(line) {
    this.sessionId = agyConversationOf(line) || this.sessionId;
    if (line.event === 'step_update') {
      const step = line.step_update || {};
      /* The first step is the agent taking the question up. agy thinks
         without showing it and then sends its answer in a few large pieces,
         so timing from the first visible word measured a tenth of a second
         and reported thousands of tokens a second. */
      const started = this.began ? {} : { started: true };
      this.began = true;
      // Its reasoning, when the model shares any.
      if (step.thinking_delta) { this.sawThinking = true; return { ...started, thinking: String(step.thinking_delta), reasoning: true }; }
      if (step.step_type === 'agent_response' && step.text_delta) {
        this.sawText = true;
        this.text = (this.text || '') + String(step.text_delta);
        return { ...started, content: step.text_delta };
      }
      return started.started ? started : null;
    }
    if (line.event === 'result') {
      const result = line.result || {};
      const usage = result.usage || {};
      const out = {
        done: true,
        usage: {
          prompt: usage.input_tokens,
          eval: usage.output_tokens,
          ...(usage.cached_input_tokens || usage.cache_read_input_tokens ? { cached: usage.cached_input_tokens || usage.cache_read_input_tokens } : {}),
        },
        reason: 'stop',
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      };
      if (result.status && result.status !== 'SUCCESS') out.error = String(result.error || result.status);
      else if (!this.sawText && result.response) out.content = String(result.response);
      else if (result.response) {
        /* agy now and then ends the stream without its last text_delta, while
           the result still carries the whole answer -- the chat showed it cut
           off mid-sentence. Whatever the stream missed is added here. */
        const full = String(result.response), got = this.text || '';
        if (full.length > got.length && full.startsWith(got)) out.content = full.slice(got.length);
      }
      return out;
    }
    return null;
  }
}

const READERS = { 'claude-code': ClaudeReader, agy: AgyReader };

/* ------------------------------------------------- agy's own transcript */

/* agy's stdout carries only its words and thoughts: the files it read, the
   commands it ran, the edits it made never come through. They are in the
   transcript it writes as it goes (brain/<conversation>/.system_generated/
   logs/transcript_full.jsonl), one step per line -- a PLANNER_RESPONSE with
   `tool_calls`, then a step (VIEW_FILE, RUN_COMMAND, CODE_ACTION, …) with what
   the tool gave back. Followed while agy runs and shown as the same timeline
   notes Claude Code's tool calls are. */
export const agyBrainDir = (env = {}) => String(env.CLI_AGY_BRAIN_DIR || '').trim()
  || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
const AGY_TRANSCRIPT = path.join('.system_generated', 'logs', 'transcript_full.jsonl');
const AGY_QUIET_STEPS = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'EPHEMERAL_MESSAGE', 'CHECKPOINT',
  'CONVERSATION_HISTORY', 'SYSTEM_MESSAGE']);

/* The one argument that says what a call is about, in agy's spelling. */
export const agyToolTarget = (args = {}) => {
  if (!args || typeof args !== 'object') return '';
  for (const key of ['CommandLine', 'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'SearchDirectory',
    'Query', 'query', 'Pattern', 'Url', 'Prompt', 'Message']) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      const v = args[key].replace(/^file:\/\/\//, '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return key === 'Pattern' && args.SearchDirectory ? `${v} in ${args.SearchDirectory}` : v;
    }
  }
  return typeof args.toolSummary === 'string' ? args.toolSummary.slice(0, 160) : '';
};

/* What a step's content says, without agy's "Created At / Completed At" header. */
const agyStepBody = (text) => String(text || '')
  .replace(/^(Created At|Completed At):[^\n]*\n/gm, '')
  // agy's nudge to itself, not news for the reader.
  .replace(/\s*If relevant, proactively run terminal commands[^\n]*/g, '')
  .trim();

/** The timeline notes for one transcript step ('' for one there is nothing to show of). */
export const agyStepNotes = (step = {}, { withThinking = false } = {}) => {
  let out = '';
  /* agy's stdout says nothing while it thinks (often 20s+); the transcript
     keeps each planning step's reasoning. Shown only when stdout did not
     already stream it, so it is never said twice. */
  if (withThinking && step.type === 'PLANNER_RESPONSE' && typeof step.thinking === 'string' && step.thinking.trim()) {
    out += `${step.thinking.trim()}\n`;
  }
  for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
    const name = String(call?.name || 'tool');
    const { toolAction, toolSummary, CodeContent, ReplacementContent, ReplacementChunks, ...args } = call?.args || {};
    const what = agyToolTarget(call?.args);
    out += name === 'run_command'
      ? toolNote('running', what)
      : toolNote('tool', `${name}${what ? ` · ${what}` : ''}`) + inputNote(args);
  }
  if (step.type === 'ERROR_MESSAGE') {
    const why = String(step.error || agyStepBody(step.content)).replace(/^Error:\s*/i, '').split('\n')[0];
    if (why) out += toolNote('tool failed', why);
  } else if (!AGY_QUIET_STEPS.has(step.type) && step.status !== 'RUNNING') {
    const body = agyStepBody(step.content);
    if (body) out += `\n${resultNote(body)}`;
  }
  return out;
};

/* agy's own file edits as the Claude Code-style file cards (changesAsMarkdown's
   line), read from the call's arguments since agy reports no diff. */
const agyCard = (file, removed, added) => {
  const lines = (s) => (s ? String(s).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);
  const minus = removed.flatMap(lines), plus = added.flatMap(lines);
  const name = path.basename(file);
  return ['', `📝 **\`${file}\`** (+${plus.length} −${minus.length})`, '```diff',
    `--- a/${name}`, `+++ b/${name}`, ...minus.map(l => `-${l}`), ...plus.map(l => `+${l}`), '```', ''].join('\n');
};

export const agyEditCards = (step = {}) => {
  let out = '';
  for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
    const a = call?.args || {};
    const file = typeof a.TargetFile === 'string' ? a.TargetFile.replace(/^file:\/\/\//, '') : '';
    if (!file) continue;
    if (call.name === 'write_to_file') out += agyCard(file, [], [a.CodeContent]);
    else if (call.name === 'replace_file_content') out += agyCard(file, [a.TargetContent], [a.ReplacementContent]);
    else if (call.name === 'multi_replace_file_content' && Array.isArray(a.ReplacementChunks)) {
      out += agyCard(file, a.ReplacementChunks.map(c => c?.TargetContent), a.ReplacementChunks.map(c => c?.ReplacementContent));
    }
  }
  return out;
};

/* Finds the transcript of the run that began at `startedAt` -- its own
   conversation when agy has said which, else the newest one started since --
   and hands each new step's notes to `emit`. `finish()` reads what is left. */
export const watchAgyTranscript = ({ env = {}, startedAt = Date.now(), conversation = () => '', streamedThinking = () => false, emit }) => {
  const brain = agyBrainDir(env);
  let file = '', offset = 0, partial = '';
  const seen = new Set();
  const since = startedAt - 5000;   // created_at has whole seconds

  const locate = () => {
    const id = conversation();
    if (id) {
      const own = path.join(brain, id, AGY_TRANSCRIPT);
      if (fs.existsSync(own)) return own;
    }
    let best = '', bestAt = 0;
    let dirs = [];
    try { dirs = fs.readdirSync(brain, { withFileTypes: true }); } catch { return ''; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const f = path.join(brain, d.name, AGY_TRANSCRIPT);
      try {
        const st = fs.statSync(f);
        if (st.mtimeMs >= since && st.mtimeMs > bestAt) { best = f; bestAt = st.mtimeMs; }
      } catch { /* not this one */ }
    }
    return best;
  };

  const step = () => {
    if (!file) { file = locate(); if (!file) return; }
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < offset) { offset = 0; partial = ''; }       // rewritten
    if (size === offset) return;
    let chunk = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        chunk = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return; }
    offset = size;
    const lines = (partial + chunk).split('\n');
    partial = lines.pop();
    let notes = '', cards = '';
    for (const raw of lines) {
      let s;
      try { s = JSON.parse(raw); } catch { continue; }
      // A resumed conversation's earlier turns are not this run's work.
      const at = Date.parse(s.created_at || '');
      if (Number.isFinite(at) && at < since) continue;
      const key = `${s.step_index}:${s.status}:${(s.tool_calls || []).length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes += agyStepNotes(s, { withThinking: !streamedThinking() });
      /* agy's file edits, and any workbench diff a step returns, go into the
         answer as the same file card Claude Code and Codex get. */
      cards += agyEditCards(s);
      if (!AGY_QUIET_STEPS.has(s.type) && s.type !== 'ERROR_MESSAGE' && s.status !== 'RUNNING') {
        cards += changesAsMarkdown(agyStepBody(s.content));
      }
    }
    if (notes || cards) { try { emit(notes, cards); } catch { /* shown or not */ } }
  };

  const timer = setInterval(step, 600);
  timer.unref?.();
  return { finish: () => { clearInterval(timer); step(); }, stop: () => clearInterval(timer) };
};

/* ------------------------------------------------------------ running one */

/* Thirty minutes: with tools on, one answer can be a CLI reading, editing and
   running tests in its own loop, and ten minutes cut that off mid-change. */
const CLI_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000;
/* Shorter where a run cannot be a long loop: plain chat, then chat with tools.
   CLI_TIMEOUT_MS still sets all three at once; the _CHAT/_TOOLS/_PROJECT ones
   set each. */
/* No limit by default (0): an answer runs until the CLI finishes or the reader
   presses stop. CLI_TIMEOUT_MS / CLI_TIMEOUT_<MODE>_MS still set one. */
const CLI_TIMEOUT_DEFAULTS = { chat: 0, tools: 0, project: 0 };
export const cliTimeoutMs = (env = {}, { tools = null, project = null } = {}) => {
  const mode = project ? 'project' : tools ? 'tools' : 'chat';
  const raw = env[`CLI_TIMEOUT_${mode.toUpperCase()}_MS`] || env.CLI_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : CLI_TIMEOUT_DEFAULTS[mode];
};

/** The provider's sign-in variables found in .env, to hand to its process. */
const authEnvOf = (provider, env = {}) => {
  const out = {};
  for (const key of provider.authEnv || []) {
    if (env[key] && !process.env[key]) out[key] = String(env[key]);
  }
  return out;
};

/* A resume the CLI could not pick up: the session, conversation or thread is
   gone, not some other failure that happened while resuming. */
const SESSION_MISSING = /(session|conversation|thread|rollout)[^\n]{0,80}(not found|no such|does not exist|doesn't exist|could not (be )?(found|load|resume)|unknown|expired|invalid)|no (conversation|session|thread) (found|with)|(could not|unable to|failed to) (resume|find|load)[^\n]{0,40}(session|conversation|thread)/i;
export const isSessionMissingError = (message) => SESSION_MISSING.test(String(message || ''));

const SCRATCH = path.join(os.tmpdir(), 'ollama-webui-cli');

/* Request folders left behind by a crash or an older build: anything over an
   hour old goes when this module loads. */
const sweepScratch = () => {
  fs.readdir(SCRATCH, { withFileTypes: true }, (err, entries) => {
    if (err) return;
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith('req-')) continue;
      const dir = path.join(SCRATCH, e.name);
      fs.stat(dir, (statErr, st) => {
        if (!statErr && st.mtimeMs < cutoff) fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }, () => {});
      });
    }
  });
};
sweepScratch();
setInterval(sweepScratch, 60 * 60 * 1000).unref?.();

/* An empty directory to run in. The CLIs read instructions from where they
   start -- CLAUDE.md, AGENTS.md -- and started from this repository they would
   answer a question about a recipe as a coding agent for this repository. */
const workDir = () => {
  const dir = path.join(SCRATCH, 'cwd');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/* Without a project folder a CLI still writes files -- into workDir, where the
   reader would never look and nothing said it had. A cheap listing before and
   after (size + mtime, no git) finds what it wrote, shown as the same 📝 cards
   a project run gets, with the full path. */
const SCAN_MAX_FILES = 3000;
const SCAN_SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__']);
export const scanDir = (root) => {
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > 8 || out.size >= SCAN_MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= SCAN_MAX_FILES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SCAN_SKIP.has(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(full); out.set(full, `${st.size}:${st.mtimeMs}`); } catch { /* gone */ }
    }
  };
  walk(root, 0);
  return out;
};

const PREVIEW_BYTES = 64 * 1024;
export const scratchChangesMarkdown = (before, after) => {
  const changed = [...after.keys()].filter(f => before.get(f) !== after.get(f));
  const removed = [...before.keys()].filter(f => !after.has(f));
  if (!changed.length && !removed.length) return '';
  const blocks = changed.slice(0, 30).map((file) => {
    let text = '';
    try {
      const buf = fs.readFileSync(file);
      text = buf.subarray(0, 8000).includes(0) ? '' : buf.subarray(0, PREVIEW_BYTES).toString('utf8');
      if (buf.length > PREVIEW_BYTES) text += '\n… (cut)';
    } catch { /* unreadable */ }
    const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
    /* The same line changesAsMarkdown writes, so the chat draws it as the
       Claude Code-style file card (src/fileChanges.js ANSWER_CHANGE) rather
       than as a loose "Diff" code block. */
    const added = lines.length;
    return ['', `📝 **\`${file}\`** (+${added} −0)`, '```diff', added ? lines.map(l => `+${l}`).join('\n') : '+(binary or empty)', '```', ''].join('\n');
  });
  const more = changed.length > 30 ? `\n\n… +${changed.length - 30} more` : '';
  const gone = removed.length ? `\n\n🗑️ ${removed.slice(0, 30).map(f => `\`${f}\``).join(', ')}` : '';
  return `\n\n${blocks.join('\n')}${more}${gone}\n\n`;
};

/* Watches the scratch folder while a CLI runs and hands each file over as it
   is written, so its card lands in the answer where the work happened rather
   than all at the end. A file is shown once its size and time have held for
   one look (not half-written); `finish` shows whatever is left. */
const SCRATCH_POLL_MS = 1200;
export const watchScratch = (dir, before, emit) => {
  let shown = new Map(before);
  let last = before;
  const step = (final) => {
    let now;
    try { now = scanDir(dir); } catch { return; }
    const next = new Map(shown);
    for (const [f, stamp] of now) {
      if (final || last.get(f) === stamp) next.set(f, stamp);
    }
    for (const f of [...next.keys()]) if (!now.has(f) && (final || !last.has(f))) next.delete(f);
    last = now;
    try {
      const md = scratchChangesMarkdown(shown, next);
      if (md) emit(md);
    } catch { /* the answer stands without it */ }
    shown = next;
  };
  const timer = setInterval(() => step(false), SCRATCH_POLL_MS);
  timer.unref?.();
  return { finish: () => { clearInterval(timer); step(true); }, stop: () => clearInterval(timer) };
};

/* The whole tree: on Windows a CLI is often a launcher with the real work in a
   child, and killing only the launcher leaves the child answering nobody. */
const killTree = (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
};

/**
 * Run one answer. Calls `onDelta({ content, thinking })` as text arrives and
 * resolves with `{ usage, reason }`, or rejects with the CLI's own words.
 */
export const runCli = async (options) => {
  let answered = false;
  const onDelta = (delta) => { answered = true; options.onDelta?.(delta); };
  try {
    return await runCliOnce({ ...options, onDelta });
  } catch (e) {
    /* agy that cannot find its chat agent: asked again as itself, once, and
       not asked with the agent again. Nothing was said yet, so nothing is
       said twice. */
    if (options.provider.id === 'agy' && !answered && !options.signal?.aborted
      && /agent .{0,80}not found/i.test(String(e.message))) {
      agyAgentUnavailable = true;
      return runCliOnce({ ...options, onDelta });
    }
    throw e;
  }
};

const runCliOnce = ({
  provider, model, request, think, tools = null, env = {}, signal, onDelta, onStart, resume = '', persist = false,
  project = null, approve = null,
}) => new Promise((resolve, reject) => {
  const binary = resolveBinary(provider, env);
  if (!binary) {
    reject(new Error(`${provider.label} CLI (${provider.bin}) was not found. Install it or set ${provider.pathEnv} in .env.`));
    return;
  }
  fs.mkdirSync(SCRATCH, { recursive: true });
  const files = fs.mkdtempSync(path.join(SCRATCH, 'req-'));
  /* Retried: on Windows taskkill is asynchronous and the CLI can still hold
     the folder (agy runs in it when there are pictures). Once only. */
  let cleaned = false;
  let invocation;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rm(files, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }, () => {});
    // An agent made for this run only (agy's long messages, splitAgyInput).
    for (const dir of invocation?.cleanupDirs || []) fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }, () => {});
  };

  try { invocation = buildInvocation(provider, model, request, { think, files, tools, env, resume, persist, project }); } catch (e) { cleanup(); reject(e); return; }
  /* Asked in the browser, said in the thinking so a pause has a reason.
     Nobody to ask means no. */
  const ask = (question) => {
    try { onDelta?.({ content: '', thinking: `${stampNote()}\n[approval needed: ${question.title.slice(0, 200)}]\n` }); } catch { /* shown or not */ }
    return approve ? Promise.resolve(approve({ provider: provider.id, ...question })).catch(() => 'decline') : Promise.resolve('decline');
  };
  const stopWatching = invocation.approvalDir ? watchApprovalDir(invocation.approvalDir, ask) : () => {};

  const child = spawn(binary.command, [...binary.prefix, ...invocation.args], {
    // Its own scratch directory when it has files to open there (agy's pictures).
    cwd: invocation.cwd || workDir(),
    /* The sign-in keys this app's .env holds reach the CLI too, as signInOf
       already counts them; the rest of .env stays here. */
    env: { ...process.env, ...authEnvOf(provider, env), ...(invocation.extraEnv || {}), NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // A conversation (Codex) reads and writes; the others read a stream.
  const reader = invocation.session || new READERS[provider.id]();
  // Where its shell commands start, for the files they change (shellChanges.js).
  if (reader instanceof ClaudeReader) reader.cwd = invocation.cwd || workDir();
  // agy's tool steps, from its transcript (see watchAgyTranscript).
  const transcript = provider.id === 'agy' && !flag(env.CLI_AGY_TRANSCRIPT ?? 'on', true) ? null
    : provider.id === 'agy' ? watchAgyTranscript({
      env, startedAt: Date.now(), conversation: () => reader.sessionId || resume || '',
      streamedThinking: () => !!reader.sawThinking,
      emit: (thinking, content = '') => { try { onDelta?.({ content, thinking }); } catch { /* closed */ } },
    }) : null;
  const timeoutMs = cliTimeoutMs(env, { tools, project });
  let settled = false, stdout = '', stderr = '', last = null, exited = false;
  /* The folder goes once the process has exited, not as it is being killed;
     a backstop in case `close` never comes. */
  child.on('close', () => { exited = true; cleanup(); });
  const settle = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stopWatching();
    try { reader.close?.(); } catch { /* only the live list */ }
    // The last steps agy wrote, before the answer is called whole.
    if (transcript) { if (error) transcript.stop(); else transcript.finish(); }
    signal?.removeEventListener('abort', onAbort);
    killTree(child);
    if (exited) cleanup();
    else setTimeout(cleanup, 15000).unref?.();
    // Part of what it was told lived in a one-run agent: not a session to pick up.
    if (invocation.unresumable) {
      if (value) value.sessionId = '';
      if (error) error.sessionId = '';
    }
    if (error) reject(error); else resolve(value);
  };
  const onAbort = () => settle(new Error('Generation cancelled'));
  signal?.addEventListener('abort', onAbort);
  if (signal?.aborted) { onAbort(); return; }
  /* A timeout keeps the session it was in (when the CLI had said one), so the
     chat can carry on from there rather than starting the work over. */
  // 0 = no limit: no timer at all.
  const timer = timeoutMs > 0 ? setTimeout(() => {
    const e = new Error(`${provider.label} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    e.timedOut = true;
    e.sessionId = reader.sessionId || (reader.threadId && !reader.thread?.ephemeral ? reader.threadId : '') || '';
    settle(e);
  }, timeoutMs) : null;
  timer?.unref?.();

  const write = (message) => {
    if (!child.stdin.writable) return;
    try { child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8'); } catch { /* it exited; `close` says why */ }
  };

  const handle = (raw) => {
    const text = raw.trim();
    if (!text.startsWith('{')) return;
    let line;
    try { line = JSON.parse(text); } catch { return; }
    const out = reader.accept(line);
    if (!out) return;
    for (const message of out.write || []) write(message);
    if (out.ask && out.reply) ask(out.ask).then((decision) => { if (!settled) write(out.reply(decision)); });
    if (out.limits) noteLimits(provider.id, out.limits);
    // When the model began, for timing its output. Anything it sends counts,
    // should a CLI not say so first.
    if (out.started || out.content || out.thinking) {
      try { onStart?.(); } catch { /* timing only */ }
    }
    if (out.content || out.thinking) {
      try { onDelta?.({ content: out.content || '', thinking: out.thinking || '', reasoning: !!out.reasoning }); } catch { /* a closed reader is not our failure */ }
    }
    // The answer is whole once the CLI says so. Codex's app server would
    // otherwise wait for the next turn indefinitely.
    if (out.done) {
      last = out;
      settle(out.error ? new Error(out.error) : null, { usage: out.usage || {}, reason: out.reason || 'stop', sessionId: out.sessionId || '' });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 16 * 1024 * 1024) { settle(new Error('CLI output exceeded the memory limit')); return; }
    let index;
    while ((index = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      handle(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', (e) => settle(new Error(`${provider.label} could not start: ${e.message}`)));
  child.on('close', (code) => {
    if (stdout.trim()) handle(stdout);
    if (last && !last.error) return settle(null, { usage: last.usage || {}, reason: last.reason || 'stop', sessionId: last.sessionId || '' });
    const detail = reader.lastError || stderr.trim().split('\n').slice(-6).join('\n');
    settle(new Error(`${provider.label} exited with code ${code} before answering${detail ? `:\n${detail}` : ''}`));
  });

  child.stdin.on('error', () => { /* it exited first; `close` says why */ });
  if (invocation.session) invocation.session.open().forEach(write);
  else child.stdin.end(invocation.stdin, 'utf8');
});

/* --------------------------------------------------------------- models */

const MODEL_CACHE_MS = 10 * 60 * 1000;
const modelCache = new Map();

/* Codex keeps the list its server last sent, with which ones to show. */
const codexModels = () => {
  try {
    const file = path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'models_cache.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.models || [])
      .filter(m => m && (m.visibility === undefined || m.visibility === 'list'))
      .map(m => m.slug || m.id)
      .filter(Boolean);
  } catch { return []; }
};

/* `agy models` prints `<id>\t<label>` per line, after a "Fetching" banner. */
export const parseAgyModels = (text) => String(text || '')
  .split(/\r?\n/)
  .map(line => line.split('\t')[0].trim())
  .filter(id => /^[a-z0-9][a-z0-9.\-_]*$/i.test(id));

const agyModels = (env) => new Promise((resolve) => {
  const binary = resolveBinary(PROVIDERS.agy, env);
  if (!binary) return resolve([]);
  execFile(binary.command, [...binary.prefix, 'models'], { timeout: 20000, windowsHide: true, cwd: workDir() },
    (error, stdout) => resolve(error ? [] : parseAgyModels(stdout)));
});

/** The models one CLI offers: `.env` if it says, else what the CLI says, else a default. */
export const modelsOf = async (provider, env = {}) => {
  const configured = listOf(env[provider.modelsEnv]);
  if (configured.length) return configured;
  const cached = modelCache.get(provider.id);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  let found = [];
  if (provider.id === 'codex') found = codexModels();
  if (provider.id === 'agy') found = await agyModels(env);
  const models = found.length ? found : provider.defaultModels;
  /* A fallback is remembered for 30 s only, not 10 min. On a fresh PC Codex
     has no models_cache.json until its first run and `agy models` fails until
     the sign-in, so the defaults are what shows -- and they used to stick
     long after the CLI could have given its full list. */
  modelCache.set(provider.id, { at: found.length ? Date.now() : Date.now() - MODEL_CACHE_MS + 30 * 1000, models });
  return models;
};

/** The CLIs that are installed, and not switched off with `CLI_PROVIDERS`. */
export const availableProviders = (env = {}) => {
  if (!enabledOf(env)) return [];
  const only = listOf(env.CLI_PROVIDERS);
  return Object.values(PROVIDERS)
    .filter(p => !only.length || only.includes(p.id))
    .filter(p => resolveBinary(p, env));
};

/** Shaped like one entry of Ollama's `/api/tags`. */
export const toTagEntry = (provider, model) => ({
  name: `${provider.id}:${model}`,
  model: `${provider.id}:${model}`,
  modified_at: new Date(0).toISOString(),
  size: 0,
  digest: '',
  details: {
    format: 'cli',
    family: provider.family,
    families: [provider.family],
    parameter_size: provider.label,
    quantization_level: '',
  },
  // What Ollama puts on its own cloud models: nothing on this card.
  remote_host: provider.label,
  remote_model: model,
});

/** Shaped like Ollama's `/api/show`. */
export const toShow = (provider, model, env = {}) => ({
  modelfile: '',
  parameters: '',
  template: '',
  details: toTagEntry(provider, model).details,
  model_info: { 'general.architecture': provider.family, 'general.basename': model },
  /* `mcp` is not Ollama's: it tells the browser this model is handed the MCP
     servers itself when the tools are on, so listing them again as tags in the
     prompt would only offer every tool twice. */
  capabilities: [
    'completion',
    ...(provider.vision ? ['vision'] : []),
    ...(provider.thinking ? ['thinking'] : []),
    ...(nativeMcpOf(provider, env).length && flag(env.CLI_MCP, true) ? ['mcp'] : []),
  ],
  remote_host: provider.label,
  remote_model: model,
});

/* -------------------------------------------------------------- the routes */

const sendJson = (res, payload, status = 200) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const ns = (ms) => Math.round(ms * 1e6);

/* The paths whose body says which model. Only these are read ahead of the
   backend; every other request passes through untouched. */
const BODY_PATHS = new Set(['/api/chat', '/api/generate', '/api/show', '/api/embed', '/api/embeddings']);

/** What the backend itself lists, so the CLI models can be added to it. */
const upstreamTags = async (env) => {
  if (backendOf(env) === 'llamacpp') {
    const base = (env.LLAMACPP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
    const res = await callServer(base, '/models', { timeout: 20000 });
    if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
    const data = await res.json();
    return toTags(data.data || data.models || []).models;
  }
  const res = await fetch(`${(env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/tags`,
    { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  return (await res.json()).models || [];
};

/** Every CLI model on offer, as `/api/tags` entries. */
export const cliTagEntries = async (env = {}, providers = availableProviders(env)) =>
  (await Promise.all(providers.map(async p => (await modelsOf(p, env)).map(m => toTagEntry(p, m))))).flat();

const listTags = async (req, res, env, providers) => {
  res.setHeader('Cache-Control', 'no-store');
  const [upstream, mine] = await Promise.all([
    upstreamTags(env).then(models => ({ models }), error => ({ error })),
    cliTagEntries(env, providers),
  ]);
  const models = [...(upstream.models || []), ...mine];
  // With the local backend down and no CLI either, it is still an error.
  if (upstream.error && !models.length) return sendJson(res, { error: String(upstream.error.message) }, 502);
  sendJson(res, { models });
};

/* ------------------------------------------------------------ the tally

   What each CLI has done since the server started: how many answers, how
   many failed and why the last one did, and what they cost where the CLI
   says. Kept in memory only -- it is a glance at "is this working", not an
   account, and the CLIs keep the real one. */
const tally = new Map();
const record = (id, { usage = {}, error = '', ms = 0, tools = null } = {}) => {
  const t = tally.get(id) || { runs: 0, failures: 0, promptTokens: 0, evalTokens: 0, costUsd: 0, toolRuns: 0, totalMs: 0 };
  t.runs++;
  t.totalMs += ms;
  t.lastAt = Date.now();
  if (error) { t.failures++; t.lastError = error.slice(0, 500); t.lastErrorAt = Date.now(); }
  if (Number.isFinite(usage.prompt)) t.promptTokens += usage.prompt;
  if (Number.isFinite(usage.eval)) t.evalTokens += usage.eval;
  if (Number.isFinite(usage.costUsd)) t.costUsd += usage.costUsd;
  if (tools && (tools.web || Object.keys(tools.servers || {}).length)) t.toolRuns++;
  tally.set(id, t);
};

/* ----------------------------------------------------- back from the limit

   Somebody told "Claude Code is over its limit" wants to hear when it is
   not. Their account is kept with the time the CLI said it would be back, in
   server/data/cli-reset-waiters.json, and a minute after that they get the
   same push a finished answer sends (server/push.js), naming the CLI. Only a
   time the CLI gave is waited for: "it might be back by now" is not news. */

const dataDir = () => (process.env.WEBUI_DATA_DIR
  ? path.resolve(process.env.WEBUI_DATA_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data'));
const waitersFile = () => path.join(dataDir(), 'cli-reset-waiters.json');
let waiters = null;
const loadWaiters = () => {
  if (waiters) return waiters;
  try { waiters = JSON.parse(fs.readFileSync(waitersFile(), 'utf8')); } catch { waiters = []; }
  if (!Array.isArray(waiters)) waiters = [];
  return waiters;
};
const saveWaiters = () => {
  try {
    fs.mkdirSync(path.dirname(waitersFile()), { recursive: true });
    fs.writeFileSync(waitersFile(), JSON.stringify(waiters));
  } catch { /* kept in memory */ }
};

/** When a CLI over its limit is back: the last of its full windows to reset. */
export const backAt = (limits, now = Date.now()) => {
  if (!limits || limits.status !== 'rejected') return null;
  const times = [
    limits.resetsAt,
    ...(limits.windows || []).filter(w => !w.reset && w.usedPercent >= 100).map(w => w.resetsAt),
  ].filter(t => Number.isFinite(t) && t > now);
  return times.length ? Math.max(...times) : null;
};

/** Remember that `owner` wants to know when this CLI is back. */
export const noteResetWaiter = (providerId, owner, until) => {
  if (!Number.isFinite(until)) return;
  const list = loadWaiters();
  const existing = list.find(w => w.provider === providerId && w.owner === String(owner || ''));
  if (existing) existing.until = until;
  else list.push({ provider: providerId, owner: String(owner || ''), until });
  saveWaiters();
};

/** The waits that are over, and the ones that are not. */
export const dueWaiters = (list = [], now = Date.now(), graceMs = 60_000) => {
  const due = [];
  const left = [];
  for (const w of list) (w.until + graceMs <= now ? due : left).push(w);
  return { due, left };
};

let watchingResets = false;
const watchResets = () => {
  if (watchingResets) return;
  watchingResets = true;
  const timer = setInterval(() => {
    if (!loadWaiters().length) return;
    const { due, left } = dueWaiters(waiters);
    if (!due.length) return;
    waiters = left;
    saveWaiters();
    for (const w of due) {
      noteFinished(w.owner, 'cli-reset', Date.now(), { name: PROVIDERS[w.provider]?.label || w.provider });
      sendPush(w.owner).catch(() => {});
    }
  }, 60_000);
  timer.unref?.();
};

/* ------------------------------------------------------------ one answer */

const OFF = /^(off|0|false|no)$/i;

/**
 * One answer, streamed as Ollama's NDJSON or returned whole.
 *
 * Tried with the model asked for and then, if that one is over its limit or
 * not there, each model in CLI_FALLBACK (server/cliFallback.js) -- as long as
 * nothing has been said yet, so an answer is never two models' halves. A CLI
 * conversation seen before is resumed rather than sent whole
 * (server/cliSessions.js).
 */
/* Per-chat choices from the composer (src/CliTurn.jsx), laid over .env for
   this request only. Narrow on purpose: the effort level, and the web/MCP
   switches only ever turned *off* -- a browser cannot switch on what .env
   (the one running the server) has switched off. */
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const envForRequest = (env = {}, headers = {}) => {
  const out = { ...env };
  const effort = String(headers['x-cli-effort'] || '').trim().toLowerCase();
  if (EFFORTS.includes(effort)) out.CLI_EFFORT = effort;
  for (const [header, key] of [['x-cli-web', 'CLI_WEB'], ['x-cli-mcp', 'CLI_MCP']]) {
    if (String(headers[header] || '').trim().toLowerCase() === 'off') out[key] = 'off';
  }
  return out;
};

/* A run that timed out, by chat: its session, so "carry on" resumes it
   instead of doing the work again. An hour at most, in memory only. */
const CONTINUE_TTL_MS = 60 * 60 * 1000;
const continuable = new Map();
const continueKey = (owner, chat) => `${owner}\u0000${chat}`;
export const noteContinuable = (owner, chat, entry) => {
  if (!chat || !entry?.id) return;
  continuable.set(continueKey(owner, chat), { ...entry, at: Date.now() });
};
export const takeContinuable = (owner, chat, { provider, keyModel }) => {
  const key = continueKey(owner, chat);
  const hit = continuable.get(key);
  if (!hit) return null;
  continuable.delete(key);
  if (Date.now() - hit.at > CONTINUE_TTL_MS || hit.provider !== provider || hit.keyModel !== keyModel) return null;
  return hit;
};

const answer = async (req, res, baseEnv, body, target, { generate = false, providers = availableProviders(baseEnv) } = {}) => {
  const env = generate ? baseEnv : envForRequest(baseEnv, req.headers);
  const wantsContinue = !generate && /^(on|1|true)$/i.test(String(req.headers['x-cli-continue'] || ''));
  const name = body.model;
  const messages = generate
    ? [...(body.system ? [{ role: 'system', content: body.system }] : []),
      { role: 'user', content: body.prompt || '', images: body.images }]
    : body.messages || [];
  const stream = body.stream !== false;
  const showThinking = body.think !== false;
  const owner = ownerOfRequest(req);
  const chat = generate ? '' : String(req.headers['x-chat-conversation'] || '').trim();
  const via = String(req.headers['x-cli-via'] || '').trim().replace(/[^a-z-]/gi, '').slice(0, 20) || (generate ? 'generate' : 'chat');
  const allowFallback = !OFF.test(String(req.headers['x-cli-fallback'] || '').trim());
  const toolsWanted = /^(on|1|true)$/i.test(String(req.headers['x-cli-tools'] || ''));
  /* A folder to work in (server/cliProject.js). Refused outright, before
     anything runs, when it is not under CLI_PROJECT_ROOTS. */
  let project = null;
  try { project = generate ? null : projectFromHeaders(req.headers, env); } catch (e) { return sendJson(res, { error: String(e.message || e) }, 403); }
  const approve = (question) => requestApproval({ owner, chat, ...question });

  const controller = new AbortController();
  const jobId = generate ? '' : String(req.headers['x-chat-job-id'] || '').trim();
  if (jobId) {
    try {
      const job = beginChatJob(jobId, { owner, chat });
      if (job.finished || job.controller) return sendJson(res, { error: 'Chat job already exists' }, 409);
      attachChatController(jobId, controller);
    } catch (e) { return sendJson(res, { error: String(e.message || e) }, 503); }
  }

  const started = Date.now();
  let firstAt = 0, genAt = 0, content = '', thinking = '', delivered = false;
  const frameOf = (delta, extra = {}) => (generate
    ? { model: name, created_at: new Date().toISOString(), response: delta.content || '', ...(delta.thinking ? { thinking: delta.thinking } : {}), ...extra }
    : { model: name, created_at: new Date().toISOString(), message: { role: 'assistant', content: delta.content || '', ...(delta.thinking ? { thinking: delta.thinking } : {}) }, ...extra });

  let connected = true;
  res.on('close', () => { connected = false; });
  if (stream) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
  }
  const publish = (frame) => {
    if (jobId && !appendChatFrame(jobId, frame)) return;
    if (!stream || !connected || res.writableEnded) return;
    try { res.write(`${JSON.stringify(frame)}\n`); } catch { connected = false; }
  };
  const onStart = () => { if (!genAt) genAt = Date.now(); };
  const onDelta = (delta) => {
    delivered = true;
    if (!firstAt) firstAt = Date.now();
    /* The model's reasoning unless thinking was switched off, as Ollama does.
       What the CLI did -- a tool, a command, an edit, its output -- travels in
       the thinking too, but it is not reasoning: it stays, or with thinking
       off the chat showed no steps at all (src/agentActivity.js). */
    const shown = showThinking || !delta.reasoning ? delta.thinking || '' : '';
    content += delta.content || '';
    thinking += shown;
    if (!shown && !delta.content) return;
    publish(frameOf({ content: delta.content || '', thinking: shown }, { done: false }));
  };

  /* The last frame: timings as Ollama gives them, and what only a CLI says --
     the price, what came from the cache, whether it was resumed, and who
     answered if not the model asked for. */
  const passedOver = [];
  const finish = ({ usage = {}, reason = 'stop', answeredBy = name, resumed = false, timings = null, toolCalls = null, run = null }) => {
    const ended = Date.now();
    const done = frameOf({ content: '' }, {
      done: true,
      done_reason: reason === 'length' ? 'length' : 'stop',
      total_duration: ns(ended - started),
      load_duration: 0,
      /* From when the model began, not from the first visible word: the
         count includes thinking a CLI may not stream, and timing it over
         only the last burst of text gave thousands of tokens a second. */
      prompt_eval_duration: ns((genAt || firstAt || ended) - started),
      eval_duration: ns(ended - (genAt || firstAt || ended)),
      ...(timings || {}),
      /* prompt_eval_count is what the context meter reads, so it is the last
         call's input -- the context in use -- not the run's sum over every
         tool round. The sums go alongside, split into fresh, cache and output. */
      /* Without a per-call figure (agy, or Claude without partial messages)
         the only number is the run's sum, which can be millions after a few
         dozen tool rounds -- never a context. So no context is claimed then. */
      ...(Number.isFinite(usage.context) ? { prompt_eval_count: usage.context } : {}),
      ...(Number.isFinite(usage.eval) ? { eval_count: usage.eval } : {}),
      ...(Number.isFinite(usage.context) || Number.isFinite(usage.prompt) ? {
        cli_tokens: {
          context: Number.isFinite(usage.context) ? usage.context : null,
          contextOut: Number.isFinite(usage.context) ? (usage.contextEval || 0) : (usage.eval || 0),
          input: usage.prompt,
          fresh: Number.isFinite(usage.fresh) ? usage.fresh : null,
          cacheRead: usage.cached || 0,
          cacheWrite: usage.cacheWrite || 0,
          output: usage.eval,
        },
      } : {}),
      ...(Number.isFinite(usage.costUsd) ? { cost_usd: usage.costUsd } : {}),
      ...(usage.cached > 0 ? { cached_count: usage.cached } : {}),
      ...(resumed ? { cli_resumed: true } : {}),
      ...(run ? { cli_run: run } : {}),
      ...(answeredBy !== name ? {
        answered_by: answeredBy,
        fallback_from: name,
        fallback_reason: passedOver.find(p => p.model === name)?.reason || passedOver[0]?.reason || 'limit',
        // When the model asked for is back, if its CLI has said.
        ...(() => {
          const asked = parseCliModel(name);
          let at = null;
          try { at = asked ? backAt(allLimits(env)[asked.provider.id]) : null; } catch { /* unknown */ }
          return Number.isFinite(at) && at > Date.now() ? { fallback_back_at: at } : {};
        })(),
      } : {}),
    });
    if (toolCalls && !generate) done.message.tool_calls = toolCalls;
    if (stream) {
      publish(done);
    } else {
      const text = body.format ? unfence(content) : content;
      if (generate) Object.assign(done, { response: text }, thinking ? { thinking } : {});
      else Object.assign(done.message, { content: text }, thinking ? { thinking } : {});
      if (jobId) appendChatFrame(jobId, done);
      if (!res.writableEnded) sendJson(res, done);
    }
  };

  /* Said in the thinking as it happens, and on the last frame for good. */
  const announce = (to) => {
    if (!passedOver.length || !showThinking) return;
    const from = passedOver.map(p => `${p.model} (${p.reason})`).join(', ');
    publish(frameOf({ content: '', thinking: `[fallback: ${from} → ${to}]\n` }, { done: false }));
  };

  const waitFor = (providerId) => noteResetWaiter(providerId, owner, backAt(allLimits(env)[providerId]));

  const runOneCli = async ({ provider, model }) => {
    const tools = toolsFor(provider, env, { wanted: toolsWanted });
    // A run that can act is told, in the transcript too, to act (see AGENTIC_FRAME).
    const agentic = !body.format && (!!project || Object.keys(tools?.servers || {}).length > 0 || !!tools?.web);
    const full = toPrompt(messages, { format: body.format, agentic });
    const resumable = !generate && resumeEnabled(provider.id, env);
    // A session belongs to the folder it ran in: the same history in
    // another folder (or none) is a different session.
    const keyModel = project ? `${model}@${project.dir}#${project.mode}` : model;
    let request = full, resume = '', resumeKey = '';
    /* "Carry on" after a timeout: the session that ran out of time, given
       only the newest message -- the work so far is in that session. */
    const carry = wantsContinue && chat ? takeContinuable(owner, chat, { provider: provider.id, keyModel }) : null;
    if (carry) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      request = { system: full.system, ...tailRequest(lastUser ? [lastUser] : [], { formatInstruction: formatInstruction(body.format) }) };
      resume = carry.id;
    } else if (resumable) {
      const split = splitForResume(messages);
      if (split) {
        resumeKey = historyKey(provider.id, keyModel, split.prefix);
        const hit = sessions.find(resumeKey, env);
        if (hit) {
          request = { system: full.system, ...tailRequest(split.tail, { formatInstruction: formatInstruction(body.format) }) };
          resume = hit.id;
        }
      }
    }
    const attempt = (asked, id) => runCli({
      provider, model, request: asked, env, tools, think: body.think, signal: controller.signal,
      resume: id, persist: resumable, onStart, onDelta, project, approve,
    });
    const before = project ? await snapshotTree(project.dir) : null;
    const scratchBefore = project || generate ? null : scanDir(workDir());
    /* Said before anything else: which CLI, since when and for how long at
       most, so the chat can show a clock against the limit. */
    publish(frameOf({ content: '' }, {
      done: false,
      cli_started: { provider: provider.id, model, startedAt: Date.now(), timeoutMs: cliTimeoutMs(env, { tools, project }), continued: !!carry },
    }));
    // No folder picked: each file it writes is shown as it appears, with its real path.
    const scratchWatch = scratchBefore
      ? watchScratch(workDir(), scratchBefore, (md) => onDelta({ content: md, thinking: '' }))
      : null;
    let result;
    try {
      result = await attempt(request, resume);
    } catch (e) {
      scratchWatch?.stop();
      if (e.timedOut && e.sessionId && chat && !generate) {
        noteContinuable(owner, chat, { id: e.sessionId, provider: provider.id, keyModel });
        e.canContinue = true;
      }
      /* A session the CLI would not pick up -- deleted, or too old on its
         side -- costs one more start, whole, and is not offered again. */
      /* Only when the CLI said the session itself is missing: a timeout or a
         crash run again from the start would cost as much again. */
      if (!resume || delivered || controller.signal.aborted || !isSessionMissingError(e.message)) throw e;
      sessions.forget(resumeKey);
      resume = '';
      result = await attempt(full, '');
    }
    /* What the run changed, as diffs at the end of the answer, and kept so it
       can be undone (`/cli/project/revert`). Remembered for resuming with the
       diff included, because that is the message the app will send back. */
    let run = null;
    if (before) {
      const after = await snapshotTree(project.dir);
      const changes = after ? await diffTrees(before.root, before.tree, after.tree) : { files: [] };
      if (changes.files.length) {
        run = noteRun({ owner, chat, root: before.root, before: before.tree, after: after.tree, files: changes.files }).id;
        onDelta({ content: changesMarkdown(changes, run), thinking: '' });
      }
    } else if (scratchWatch) {
      scratchWatch.finish();   // whatever was written in the last moment
    }
    if (resumable && result.sessionId) {
      const said = body.format ? unfence(content) : content;
      sessions.remember(historyKey(provider.id, keyModel, [...messages, { role: 'assistant', content: said }]),
        { id: result.sessionId, provider: provider.id });
    }
    return { result, resumed: !!resume, tools, run };
  };

  const candidates = allowFallback ? candidatesFor(name, env) : [name];
  try {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const lastChance = i === candidates.length - 1;
      const cli = parseCliModel(candidate);
      if (!delivered) { firstAt = 0; genAt = 0; }

      if (cli) {
        const id = cli.provider.id;
        if (!providers.includes(cli.provider)) {
          if (lastChance) throw new Error(`${candidate} is not available: ${cli.provider.label} is not installed or is switched off.`);
          passedOver.push({ model: candidate, reason: 'unavailable' });
          continue;
        }
        /* Over its limit by its own account: not started at all, unless it
           is the last there is to try. */
        if (!lastChance && blockedUntil(id === 'agy' ? agyQuotaForModel(allLimits(env)[id], cli.model) : allLimits(env)[id])) {
          waitFor(id);
          passedOver.push({ model: candidate, reason: 'limit' });
          continue;
        }
        /* Past CLI_DAILY_BUDGET_USD today (the API-equivalent price the CLIs
           report): the rest of the day goes to whatever is next -- a local
           model, normally -- and with nothing next, it is refused. */
        if (Number(env.CLI_DAILY_BUDGET_USD) > 0) {
          const budget = budgetState(readUsage({ since: Date.now() - 24 * 3600 * 1000 }), env);
          if (budget.over) {
            if (lastChance) throw new Error(`Today's CLI budget of $${budget.cap} is spent ($${budget.spent}). Set CLI_DAILY_BUDGET_USD higher, or pick a local model.`);
            passedOver.push({ model: candidate, reason: 'budget' });
            continue;
          }
        }
        announce(candidate);
        const runStarted = Date.now();
        try {
          const { result, resumed, tools, run } = await runOneCli(cli);
          const ms = Date.now() - runStarted;
          record(id, { usage: result.usage, ms, tools });
          recordUsage({
            provider: id, model: cli.model, owner, chat, via, usage: result.usage, ms, resumed,
            fallbackFrom: candidate !== name ? name : '',
          });
          finish({ usage: result.usage, reason: result.reason, answeredBy: candidate, resumed, run });
          return;
        } catch (e) {
          const message = String(e.message || e);
          if (controller.signal.aborted) throw e;
          record(id, { error: message, ms: Date.now() - runStarted });
          recordUsage({ provider: id, model: cli.model, owner, chat, via, error: message, ms: Date.now() - runStarted });
          noteLimitError(id, message, cli.model);
          if (isLimitError(message)) waitFor(id);
          if (!delivered && !lastChance && (isLimitError(message) || isUnavailableError(message))) {
            passedOver.push({ model: candidate, reason: isLimitError(message) ? 'limit' : 'unavailable' });
            continue;
          }
          throw e;
        }
      }

      /* A local model: through Ollama or llama-server, frame by frame. */
      announce(candidate);
      const last = await streamLocal(env, {
        model: candidate,
        messages,
        ...(body.options ? { options: body.options } : {}),
        ...(body.think !== undefined ? { think: body.think } : {}),
        ...(body.format ? { format: body.format } : {}),
        ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
      }, {
        signal: controller.signal,
        onFrame: (frame) => {
          if (frame.done) return;
          const m = frame.message || {};
          if (m.content || m.thinking) onDelta({ content: m.content || '', thinking: m.thinking || '', reasoning: true });
        },
      });
      const pick = (key) => (Number.isFinite(last?.[key]) ? { [key]: last[key] } : {});
      finish({
        usage: { prompt: last?.prompt_eval_count, eval: last?.eval_count },
        reason: last?.done_reason,
        answeredBy: candidate,
        timings: { ...pick('prompt_eval_duration'), ...pick('eval_duration'), ...pick('load_duration') },
        toolCalls: last?.message?.tool_calls || null,
      });
      return;
    }
  } catch (e) {
    const message = String(e.message || e);
    if (stream) {
      if (!controller.signal.aborted) {
        publish({
          model: name, error: message, done: true, done_reason: 'error',
          ...(e.timedOut ? { cli_timed_out: true } : {}),
          ...(e.canContinue ? { cli_can_continue: true } : {}),
        });
      }
    } else if (!res.writableEnded) {
      sendJson(res, { error: message }, 502);
    }
  } finally {
    if (jobId) finishChatJob(jobId);
    if (stream && !res.writableEnded) res.end();
  }
};

/**
 * Connect-style middleware: `(req, res, next)`. Mounted ahead of the backend
 * in both the dev server (vite.config.js) and the production one
 * (server/index.js), so `npm run dev` and `npm start` offer the same models.
 */
export const cliInterceptor = (env = {}) => {
  const providers = availableProviders(env);
  if (providers.length) watchResets();
  return async (req, res, next) => {
    if (!providers.length) return next();
    // Proxies may send an absolute request target; use the same pathname as
    // the outer server router so CLI requests cannot fall through to Ollama.
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;

    if (pathname === '/api/tags' && req.method === 'GET') {
      try { return await listTags(req, res, env, providers); } catch (e) { return sendJson(res, { error: String(e.message || e) }, 502); }
    }
    /* A body already read is still looked at, not waved through. RisuAI's
       route (server/risuai.js) reads and rewrites the body before handing it
       here, and skipping every request with `rawBody` sent its `agy:…`,
       `claude-code:…` and `codex:…` models straight to Ollama, which answered
       "model not found". readRequestBody returns the stored bytes, so a second
       look costs a parse and nothing else. */
    if (req.method !== 'POST' || !BODY_PATHS.has(pathname)) return next();

    let raw;
    try { raw = await readRequestBody(req); } catch (e) { return sendJson(res, { error: String(e.message || e) }, e.statusCode || 400); }
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* the backend says what is wrong with it */ }
    const target = parseCliModel(body?.model || body?.name);
    if (!target || !providers.includes(target.provider)) {
      req.rawBody = raw;
      return next();
    }

    if (pathname === '/api/show') return sendJson(res, toShow(target.provider, target.model, env));
    if (pathname === '/api/embed' || pathname === '/api/embeddings') {
      return sendJson(res, { error: `${body.model} is a chat model run through a CLI and has no embeddings.` }, 400);
    }
    if (pathname === '/api/generate') {
      // "Unload this model": there is nothing loaded.
      if (!body.prompt && (body.keep_alive === 0 || body.keep_alive === '0')) {
        return sendJson(res, { model: body.model, created_at: new Date().toISOString(), response: '', done: true, done_reason: 'unload' });
      }
      return answer(req, res, env, body, target, { generate: true, providers });
    }
    return answer(req, res, env, body, target, { providers });
  };
};

/**
 * One answer, whole, for the server's own turns (server/turns.js: schedules)
 * where there is no browser request to stream into. The same fallback and
 * ledger as a chat; `project` is `{ dir, mode }` and is checked against
 * CLI_PROJECT_ROOTS here. Answers in Ollama's `/api/chat` shape.
 */
export const answerOnce = async ({ model: name, messages, env = {}, owner = '', chat = '', project = null, via = 'schedule', signal = null }) => {
  const folder = project?.dir ? { dir: resolveProject(project.dir, env), mode: project.mode === 'edit' ? 'edit' : 'plan', maxTurns: maxTurnsOf(env) } : null;
  const providers = availableProviders(env);
  const candidates = candidatesFor(name, env);
  const passed = [];
  for (const [i, candidate] of candidates.entries()) {
    if (signal?.aborted) throw new Error('Generation cancelled');
    const cli = parseCliModel(candidate);
    const last = i === candidates.length - 1;
    if (!cli) {
      /* A local model that is not there or not running: the next one, as a
         CLI that is unavailable would be. */
      try {
        let said = '';
        const frame = await streamLocal(env, { model: candidate, messages }, { signal, onFrame: (f) => { if (!f.done) said += f.message?.content || ''; } });
        return { ...frame, model: candidate, message: { role: 'assistant', content: said || frame?.message?.content || '' } };
      } catch (e) {
        if (signal?.aborted || last) throw e;
        passed.push(candidate);
        continue;
      }
    }
    if (!providers.includes(cli.provider) || (!last && blockedUntil(cli.provider.id === 'agy' ? agyQuotaForModel(allLimits(env).agy, cli.model) : allLimits(env)[cli.provider.id]))) { passed.push(candidate); continue; }
    // The same daily budget as a chat.
    if (Number(env.CLI_DAILY_BUDGET_USD) > 0) {
      const budget = budgetState(readUsage({ since: Date.now() - 24 * 3600 * 1000 }), env);
      if (budget.over) {
        if (last) throw new Error(`Today's CLI budget of $${budget.cap} is spent ($${budget.spent}). Set CLI_DAILY_BUDGET_USD higher, or pick a local model.`);
        passed.push(candidate);
        continue;
      }
    }
    let text = '';
    const started = Date.now();
    const before = folder ? await snapshotTree(folder.dir) : null;
    try {
      const result = await runCli({
        provider: cli.provider, model: cli.model, env, request: toPrompt(messages, { agentic: !!folder }), project: folder, signal,
        approve: (question) => requestApproval({ owner, chat, ...question }),
        onDelta: (d) => { text += d.content || ''; },
      });
      if (before) {
        const after = await snapshotTree(folder.dir);
        const changes = after ? await diffTrees(before.root, before.tree, after.tree) : { files: [] };
        if (changes.files.length) {
          const run = noteRun({ owner, chat, root: before.root, before: before.tree, after: after.tree, files: changes.files });
          text += changesMarkdown(changes, run.id);
        }
      }
      recordUsage({ provider: cli.provider.id, model: cli.model, owner, chat, via, usage: result.usage, ms: Date.now() - started, fallbackFrom: candidate !== name ? name : '' });
      return {
        model: candidate, message: { role: 'assistant', content: text }, done: true,
        total_duration: ns(Date.now() - started),
        ...(Number.isFinite(result.usage?.prompt) ? { prompt_eval_count: result.usage.prompt } : {}),
        ...(Number.isFinite(result.usage?.eval) ? { eval_count: result.usage.eval } : {}),
      };
    } catch (e) {
      recordUsage({ provider: cli.provider.id, model: cli.model, owner, chat, via, error: String(e.message || e), ms: Date.now() - started });
      noteLimitError(cli.provider.id, e.message, cli.model);
      if (!last && !text && (isLimitError(e.message) || isUnavailableError(e.message))) { passed.push(candidate); continue; }
      throw e;
    }
  }
  throw new Error(`No model could answer (${passed.join(', ')} unavailable)`);
};

/* ------------------------------------------------------------- status */

/* `--version`, once per ten minutes per CLI. It spends no quota: it is the
   binary saying what it is, not a question to a model. */
const versionCache = new Map();
const versionOf = (provider, binary) => new Promise((resolve) => {
  const cached = versionCache.get(provider.id);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return resolve(cached.version);
  execFile(binary.command, [...binary.prefix, '--version'], { timeout: 10000, windowsHide: true, cwd: workDir() },
    (error, stdout) => {
      const version = error ? '' : String(stdout || '').trim().split(/\r?\n/).pop().slice(0, 120);
      versionCache.set(provider.id, { at: Date.now(), version });
      resolve(version);
    });
});

/* Whether it looks signed in: a credentials file where the CLI keeps one, or
   a key in the environment. A guess, said as one -- the only proof is a run. */
const signInOf = (provider, env) => {
  const key = (provider.authEnv || []).find(name => env[name] || process.env[name]);
  if (key) return { signedIn: true, how: key };
  // Read, not just found: an empty account file is no sign-in (cliAuth.js).
  const file = signedInFile(provider.authFiles, HOME);
  return file ? { signedIn: true, how: path.basename(file) } : { signedIn: provider.authFiles?.length ? false : null, how: '' };
};

/* ------------------------------------------------------------ doctor */

/* One check per CLI: installed, version, signed in -- and with `live`, a real
   one-line answer, plus for agy a read-only plan run in a scratch folder, which
   is what shows whether CLI_AGY_PLAN_TOOLS names tools agy actually has.
   `live` spends a little quota, so it runs only when asked. */
const DOCTOR_TIMEOUT_MS = 90 * 1000;
const doctorRun = async (provider, model, env, extra = {}) => {
  const started = Date.now();
  let text = '';
  try {
    await runCli({
      provider, model, env: { ...env, CLI_TIMEOUT_MS: String(DOCTOR_TIMEOUT_MS) },
      request: toPrompt([{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }]),
      think: false, signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS + 5000),
      onDelta: (d) => { text += d.content || ''; },
      ...extra,
    });
    return { ok: true, ms: Date.now() - started, said: text.trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e.message || e).slice(0, 1000) };
  }
};

export const cliDoctor = async (env = {}, { live = false, only = '' } = {}) => {
  const providers = availableProviders(env);
  const out = [];
  for (const provider of Object.values(PROVIDERS)) {
    if (only && provider.id !== only) continue;
    const binary = resolveBinary(provider, env);
    const row = {
      id: provider.id, label: provider.label,
      installed: !!binary, offered: providers.includes(provider),
      version: binary ? await versionOf(provider, binary) : '',
      ...signInOf(provider, env),
      checks: [],
    };
    if (provider.id === 'agy') {
      row.planTools = agyPlanTools(env);
    }
    if (live && row.offered) {
      const model = (await modelsOf(provider, env).catch(() => []))[0] || '';
      row.checks.push({ name: 'answer', model, ...(await doctorRun(provider, model, env)) });
      if (provider.id === 'agy') {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-webui-doctor-'));
        try {
          fs.writeFileSync(path.join(dir, 'README.md'), '# doctor\n');
          row.checks.push({
            name: 'plan', model,
            ...(await doctorRun(provider, model, env, {
              project: { dir, mode: 'plan', maxTurns: 3 },
              request: toPrompt([{ role: 'user', content: 'Read README.md in this folder and reply with its first line only.' }]),
            })),
          });
        } finally {
          fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
        }
      }
    }
    out.push(row);
  }
  return out;
};

/** Everything the settings panel shows about the CLIs. */
export const cliStatus = async (env = {}) => {
  const enabled = enabledOf(env);
  const only = listOf(env.CLI_PROVIDERS);
  const mcp = readMcpConfig(env, {});
  const limits = withForecasts(allLimits(env));
  const providers = await Promise.all(Object.values(PROVIDERS).map(async (provider) => {
    const binary = resolveBinary(provider, env);
    const offered = enabled && !!binary && (!only.length || only.includes(provider.id));
    const tools = toolsFor(provider, env, { wanted: true });
    const skipped = Object.entries(mcp.servers || {})
      .filter(([name, s]) => !s.disabled && !(name in (tools?.servers || {})))
      .map(([name, s]) => ({ name, why: isDelegate(s) ? 'delegate' : !SAFE_NAME.test(name) ? 'name' : 'transport', transport: s.transport }));
    return {
      id: provider.id,
      label: provider.label,
      family: provider.family,
      bin: provider.bin,
      pathEnv: provider.pathEnv,
      path: binary ? [binary.command, ...binary.prefix].join(' ') : '',
      installed: !!binary,
      offered,
      version: binary ? await versionOf(provider, binary) : '',
      ...signInOf(provider, env),
      models: offered ? await modelsOf(provider, env) : [],
      vision: provider.vision,
      thinking: provider.thinking,
      efforts: provider.efforts,
      tools: {
        mcp: Object.keys(tools?.servers || {}),
        mcpSkipped: nativeMcpOf(provider, env).length && flag(env.CLI_MCP, true) ? skipped : [],
        web: !!tools?.web,
        native: nativeMcpOf(provider, env).length > 0 && flag(env.CLI_MCP, true),
      },
      usage: tally.get(provider.id) || null,
      limits: limits[provider.id] || null,
    };
  }));
  return {
    enabled,
    settings: {
      fallback: listOf(env.CLI_FALLBACK),
      resume: String(env.CLI_RESUME ?? '') || 'on',
      // What nativeMcpOf actually does (on unless CLI_AGY_MCP/CLI_AGY_AGENT say off).
      agyMcp: nativeMcpOf(PROVIDERS.agy, env).length > 0,
      mcp: flag(env.CLI_MCP, true),
      web: flag(env.CLI_WEB, true),
      effort: String(env.CLI_EFFORT || ''),
      timeoutMs: cliTimeoutMs(env, { project: {} }),
      timeouts: {
        chat: cliTimeoutMs(env, {}),
        tools: cliTimeoutMs(env, { tools: {} }),
        project: cliTimeoutMs(env, { project: {} }),
      },
      only,
      project: projectSettings(env),
    },
    providers,
  };
};

/**
 * `/cli/status` and `/cli/refresh`, mounted with the other API routes.
 *
 * Read-only apart from forgetting caches: which CLIs are offered, and how, is
 * `.env`'s to say, for the reason `mcp.json` is not edited from the browser.
 */
const jsonBody = async (req) => {
  const raw = await readRequestBody(req);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return {}; }
};
const queryOf = (req) => new URL(req.originalUrl || req.url || '/', 'http://localhost').searchParams;
const guarded = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { if (!res.writableEnded) sendJson(res, { success: false, error: String(e.message || e) }, e.statusCode || 400); }
};
const postOnly = (req) => { if (req.method !== 'POST') throw Object.assign(new Error('POST only'), { statusCode: 405 }); };

/* The workbench as mcp.json starts it: its folders and whether commands are off. */
const workbenchStartOf = (env) => {
  let servers = {};
  try { servers = readMcpConfig(env, {}).servers || {}; } catch { return null; }
  for (const server of Object.values(servers)) {
    const args = (server.args || []).map(String);
    const script = args.findIndex(a => /mcpWorkbench\.mjs$/i.test(a));
    if (script === -1 || server.disabled) continue;
    const rest = args.slice(script + 1);
    return { roots: rest.filter(a => !a.startsWith('--')).map(a => path.resolve(a)), noCommands: rest.includes('--no-commands') };
  }
  return null;
};
setTimeout(() => sweepBackups(), 60_000).unref?.();

/* One CLI run in a folder, whole, for a worktree race. */
const runInFolder = (env, owner) => async ({ model: name, dir, mode, prompt }) => {
  const cli = parseCliModel(name);
  if (!cli || !availableProviders(env).includes(cli.provider)) throw new Error(`${name} is not available`);
  let text = '';
  const started = Date.now();
  try {
    const result = await runCli({
      provider: cli.provider, model: cli.model, env,
      request: { system: '', prompt, images: [] },
      project: { dir, mode, maxTurns: maxTurnsOf(env) },
      approve: (question) => requestApproval({ owner, chat: '', ...question, title: `[${name}] ${question.title}` }),
      onDelta: (d) => { text += d.content || ''; },
    });
    recordUsage({ provider: cli.provider.id, model: cli.model, owner, via: 'race', usage: result.usage, ms: Date.now() - started });
    return text;
  } catch (e) {
    recordUsage({ provider: cli.provider.id, model: cli.model, owner, via: 'race', error: String(e.message || e), ms: Date.now() - started });
    noteLimitError(cli.provider.id, e.message, cli.model);
    throw e;
  }
};

/* Where on this PC a file or folder the browser handed over lives.
 *
 * A browser never says a dropped file's path -- only its name, size and
 * modification time. The server runs on the same PC, so it looks for an entry
 * with that name (and, for a file, that size and time; for a folder, the
 * children that were dropped with it) under the usual places: the user's
 * folders, the project, and LOCATE_ROOTS from .env (";"-separated). Bounded in
 * depth, entries and time, so a miss costs a second, not a disk scan. Only
 * unambiguous answers come back; two equal candidates are no answer. */
const SKIP_DIRS = new Set(['node_modules', '.git', '$Recycle.Bin', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)', '.cache', 'site-packages', '__pycache__']);
const locateRoots = (env) => {
  const home = os.homedir();
  const extra = String(env.LOCATE_ROOTS || process.env.LOCATE_ROOTS || '').split(';').map(s => s.trim()).filter(Boolean);
  const named = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Videos', 'Music', 'OneDrive', 'OneDrive/Desktop', 'OneDrive/Documents', '바탕 화면', '문서', '다운로드']
    .map(d => path.join(home, d));
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // Drive roots last: breadth-first, their top folders (C:\작업) cost little.
  const drives = process.platform === 'win32' ? 'CDEFGH'.split('').map(l => `${l}:\\`) : [];
  return [...new Set([...extra, project, ...named, home, ...drives])].filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
};
const locateEntries = async (env, wanted) => {
  const found = wanted.map(() => []);
  const deadline = Date.now() + 2500;
  let budget = 60000;
  const seen = new Set();
  /* Breadth-first over every root at once. Depth-first spent the whole entry
     budget inside Desktop/Downloads before it ever reached the drive-level
     folders (C:\Artificial_Intelligence\ollama-webui came back as nothing):
     shallow places are where dropped things usually live, so they go first. */
  let level = locateRoots(env).map(dir => ({ dir, depth: 0 }));
  const visit = async ({ dir, depth }, next) => {
    if (depth > 6 || budget <= 0 || Date.now() > deadline || seen.has(dir)) return;
    seen.add(dir);
    let list;
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    budget -= list.length;
    for (const ent of list) {
      const full = path.join(dir, ent.name);
      for (let i = 0; i < wanted.length; i++) {
        const w = wanted[i];
        if (w.name !== ent.name || found[i].includes(full)) continue;
        if (w.kind === 'folder' && ent.isDirectory()) {
          const kids = (w.children || []).slice(0, 5);
          if (kids.every(k => fs.existsSync(path.join(full, k)))) found[i].push(full);
        } else if (w.kind !== 'folder' && ent.isFile()) {
          try {
            const st = await fs.promises.stat(full);
            if ((!Number.isFinite(w.size) || st.size === w.size)
              && (!Number.isFinite(w.lastModified) || Math.abs(st.mtimeMs - w.lastModified) < 2000)) found[i].push(full);
          } catch { /* gone */ }
        }
      }
    }
    for (const ent of list) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && !SKIP_DIRS.has(ent.name)) next.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
    }
  };
  while (level.length && budget > 0 && Date.now() <= deadline) {
    const next = [];
    for (const item of level) await visit(item, next);
    // Something found at this depth: deeper namesakes are not looked for.
    if (found.every(f => f.length)) break;
    level = next;
  }
  return found.map(f => (f.length === 1 ? f[0] : null));
};

export const createCliRoutes = (env = {}) => [
  /* Paths of dropped files and folders (see locateEntries). */
  {
    // Not under /localfs: api.js drops those whenever HOST is not loopback
    // (ALLOW_LOCAL_FS off), which is how the installed app runs -- so every
    // lookup came back 403 and only the name was written. This reads no file
    // and writes nothing; it answers "where is X" behind the access token.
    path: '/cli/locate',
    handler: guarded(async (req, res) => {
      postOnly(req);
      const body = await jsonBody(req);
      const wanted = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map(it => ({
        kind: it?.kind === 'folder' ? 'folder' : 'file',
        name: path.basename(String(it?.name || '')),
        size: Number(it?.size),
        lastModified: Number(it?.lastModified),
        children: (Array.isArray(it?.children) ? it.children : []).map(c => path.basename(String(c))).filter(Boolean),
      })).filter(w => w.name);
      sendJson(res, { success: true, paths: wanted.length ? await locateEntries(env, wanted) : [] });
    }),
  },
  /* Just the limits: cheap enough for the header to ask every minute, since
     it reads files and runs nothing. With a forecast of when each window
     runs out at the rate it is being used. */
  {
    path: '/cli/limits',
    handler: async (req, res) => {
      try {
        // The daily budget beside the windows, when CLI_DAILY_BUDGET_USD sets one.
        let budget = null;
        if (Number(env.CLI_DAILY_BUDGET_USD) > 0) {
          try { budget = budgetState(readUsage({ since: Date.now() - 24 * 3600 * 1000 }), env); } catch { /* shown without */ }
        }
        /* Fresh figures from the providers when the last ask is a minute old;
           waited for briefly, and otherwise shown on the next read. */
        const force = /[?&]force=1/.test(req.url || '');
        await Promise.race([refreshLiveLimits(env, { force }), new Promise(r => setTimeout(r, 6000))]);
        sendJson(res, { success: true, limits: withForecasts(allLimits(env)), budget, now: Date.now() });
      } catch (e) { sendJson(res, { success: false, error: String(e.message || e) }, 500); }
    },
  },
  /* Commands a CLI is running right now (server/liveCommands.js), with their
     output so far; POST `{ id }` to /cli/commands/stop ends one. */
  {
    path: '/cli/commands',
    handler: guarded(async (req, res) => {
      sendJson(res, { success: true, commands: listCommands(), now: Date.now() });
    }),
  },
  {
    path: '/cli/commands/stop',
    handler: guarded(async (req, res) => {
      postOnly(req);
      const { id } = await jsonBody(req);
      sendJson(res, { success: await stopCommand(String(id || '')) });
    }),
  },
  /* A command's whole output, as a file to save. */
  {
    path: '/cli/commands/log',
    handler: guarded(async (req, res) => {
      const id = String(queryOf(req).get('id') || '');
      const log = readLog(id);
      if (log === null) return sendJson(res, { success: false, error: 'No such command' }, 404);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="command-${id.replace(/[^\w.-]/g, '_')}.log"`,
        'Cache-Control': 'no-store',
      });
      res.end(log);
    }),
  },
  /* The workbench's dimmer (server/workbenchState.js): what mcp.json allows
     it, and how much of that is on. Narrowing only -- see there. */
  {
    path: '/cli/workbench/policy',
    handler: guarded(async (req, res) => {
      if (req.method === 'POST') writePolicy(await jsonBody(req));
      const start = workbenchStartOf(env);
      const policy = readPolicy();
      sendJson(res, {
        success: true, policy, configured: !!start,
        allowed: start?.roots || [], noCommands: !!start?.noCommands,
        effective: start ? effectiveAccess(start.roots, { noCommands: start.noCommands }, policy) : null,
      });
    }),
  },
  /* Which of these files the workbench can put back, and putting one back. */
  {
    path: '/cli/workbench/revert',
    handler: guarded(async (req, res) => {
      if (req.method === 'GET') return sendJson(res, { success: true, backups: listBackups() });
      const body = await jsonBody(req);
      if (Array.isArray(body.files)) {
        return sendJson(res, { success: true, files: Object.fromEntries(body.files.slice(0, 200).map(f => [f, hasBackup(String(f))])) });
      }
      postOnly(req);
      sendJson(res, { success: true, ...restoreBackup(String(body.file || '')) });
    }),
  },
  /* Questions a CLI working in a folder is waiting on, and their answers. */
  {
    path: '/cli/approvals',
    handler: guarded(async (req, res) => {
      const owner = ownerOfRequest(req);
      if (req.method === 'POST') {
        const { id, decision } = await jsonBody(req);
        return sendJson(res, { success: decideApproval(owner, String(id || ''), String(decision || 'decline')) });
      }
      return sendJson(res, { success: true, approvals: listApprovals(owner) });
    }),
  },
  /* Project mode: which folders, and the runs that changed something. */
  {
    path: '/cli/project',
    handler: guarded(async (req, res) => {
      sendJson(res, { success: true, ...projectSettings(env), budget: budgetState(readUsage({ since: Date.now() - 24 * 3600 * 1000 }), env), runs: listRuns(ownerOfRequest(req)) });
    }),
  },
  {
    path: '/cli/project-revert',
    handler: guarded(async (req, res) => {
      postOnly(req);
      const { id, files = null } = await jsonBody(req);
      const run = await revertRun(ownerOfRequest(req), String(id || ''), { files: Array.isArray(files) ? files : null });
      sendJson(res, { success: true, run: getRun(ownerOfRequest(req), run.id) });
    }),
  },
  /* One run, for the card under the answer that made it (src/CliTurn.jsx). */
  {
    path: '/cli/project-run',
    handler: guarded(async (req, res) => {
      const run = getRun(ownerOfRequest(req), String(queryOf(req).get('id') || ''));
      return run ? sendJson(res, { success: true, run }) : sendJson(res, { success: false, error: 'No such run' }, 404);
    }),
  },
  /* The check button in the CLI panel. GET is the free part; POST
     `{ live: true }` also asks each CLI for a one-word answer. */
  {
    path: '/cli/doctor',
    handler: guarded(async (req, res) => {
      const body = req.method === 'POST' ? await jsonBody(req) : {};
      const live = req.method === 'POST' && body.live === true;
      sendJson(res, { success: true, live, providers: await cliDoctor(env, { live, only: String(body.only || '') }) });
    }),
  },
  /* The same task to several CLIs in git worktrees; merge the one you like. */
  {
    path: '/cli/race',
    handler: guarded(async (req, res) => {
      const owner = ownerOfRequest(req);
      if (req.method === 'POST') {
        const { dir, prompt, models = [], mode = 'edit' } = await jsonBody(req);
        if (!String(prompt || '').trim()) throw new Error('A race needs a task');
        if (!Array.isArray(models) || models.length < 1) throw new Error('Pick at least one model');
        const race = await startRace({ owner, dir: resolveProject(dir, env), prompt: String(prompt), models: models.map(String), mode: mode === 'plan' ? 'plan' : 'edit', run: runInFolder(env, owner) });
        return sendJson(res, { success: true, race });
      }
      const id = queryOf(req).get('id');
      if (id) {
        const race = getRace(owner, id);
        return race ? sendJson(res, { success: true, race }) : sendJson(res, { success: false, error: 'No such race' }, 404);
      }
      return sendJson(res, { success: true, races: listRaces(owner) });
    }),
  },
  {
    path: '/cli/race-finish',
    handler: guarded(async (req, res) => {
      postOnly(req);
      const { id, winner = null } = await jsonBody(req);
      sendJson(res, { success: true, ...(await finishRace(ownerOfRequest(req), String(id || ''), winner)) });
    }),
  },
  /* Skills, subagents and prompts in each CLI's home folder. Switching one
     off renames its file; only with CLI_EXTENSIONS_EDIT=on, and only on a
     server without accounts or for a signed-in one. */
  {
    path: '/cli/extensions',
    handler: guarded(async (req, res) => {
      if (req.method === 'POST') {
        if (!projectSettings(env).extensionsEditable) throw Object.assign(new Error('Set CLI_EXTENSIONS_EDIT=on in .env to switch these from the browser.'), { statusCode: 403 });
        const { file, enabled } = await jsonBody(req);
        return sendJson(res, { success: true, extension: setExtensionEnabled(env, String(file || ''), !!enabled) });
      }
      return sendJson(res, { success: true, editable: projectSettings(env).extensionsEditable, extensions: listExtensions(env) });
    }),
  },
  /* Claude Code and Codex conversations from the terminal, to carry on here. */
  {
    path: '/cli/terminal-sessions',
    handler: guarded(async (req, res) => {
      // This machine's own transcripts: off unless .env says so.
      if (!flag(env.CLI_TERMINAL_IMPORT, false)) throw Object.assign(new Error('Set CLI_TERMINAL_IMPORT=on in .env to import terminal sessions.'), { statusCode: 403 });
      const key = queryOf(req).get('key');
      if (key) return sendJson(res, { success: true, session: readTerminalSession(env, key) });
      // More than the default when asked (the panel searches them), never past 200.
      const limit = Math.max(1, Math.min(200, Number(queryOf(req).get('limit')) || 40));
      return sendJson(res, { success: true, sessions: listTerminalSessions(env, undefined, { limit }) });
    }),
  },
  /* The account kept in server/data/cli-usage.jsonl, folded: the reader's
     own, unless `?all=1` on a server with no accounts to tell apart. */
  {
    path: '/cli/usage',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
        const owner = ownerOfRequest(req);
        const lines = readUsage({ since: Date.now() - days * 24 * 3600 * 1000 });
        sendJson(res, {
          success: true,
          ...summariseUsage(lines, { owner: url.searchParams.get('all') === '1' && !owner ? null : owner, days }),
          resume: Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, resumeEnabled(id, env)])),
          fallback: listOf(env.CLI_FALLBACK),
        });
      } catch (e) { sendJson(res, { success: false, error: String(e.message || e) }, 500); }
    },
  },
  {
    path: '/cli/status',
    handler: async (req, res) => {
      try { sendJson(res, { success: true, ...(await cliStatus(env)) }); } catch (e) { sendJson(res, { success: false, error: String(e.message || e) }, 500); }
    },
  },
  {
    path: '/cli/refresh',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, { success: false, error: 'POST only' }, 405);
      modelCache.clear();
      versionCache.clear();
      try { return sendJson(res, { success: true, ...(await cliStatus(env)) }); } catch (e) { return sendJson(res, { success: false, error: String(e.message || e) }, 500); }
    },
  },
];

/** For the startup banner. */
export const describeProviders = (env = {}) => availableProviders(env).map(p => p.label);
