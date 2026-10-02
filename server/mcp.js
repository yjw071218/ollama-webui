/**
 * Tools this app did not write.
 *
 * The agent tools here are a fixed set of eleven, and they are the eleven
 * somebody thought of: read a file, search the web, draw a picture. That is a
 * reasonable list and it is also a ceiling — wanting the model to query a
 * SQLite database, or read a git log, or drive a headless browser, has meant
 * writing a twelfth tool into this repository, and a thirteenth, for ever.
 *
 * The Model Context Protocol is the shape of the answer: a server describes
 * its tools over JSON-RPC, and anything that speaks it can offer them. There
 * are hundreds already written. This file is the client half, and what it buys
 * is that the list of tools stops being a property of this codebase.
 *
 * The toggle in the interface has been labelled "MCP" since long before any of
 * this existed, which was a name for a thing that was not there. It is there
 * now.
 *
 * ## Nothing runs unless a file says so
 *
 * A protocol whose stdio transport is "spawn this command" is a protocol that
 * runs programs on the machine. So there is no discovery, no default server,
 * and nothing is contacted until `mcp.json` exists and names it — the same
 * file Claude Desktop and the rest of the ecosystem use, so a server anyone
 * has already configured elsewhere can be pasted in:
 *
 *     {
 *       "mcpServers": {
 *         "sqlite": { "command": "uvx", "args": ["mcp-server-sqlite", "--db-path", "D:/notes.db"] },
 *         "docs":   { "url": "https://example.internal/mcp",
 *                     "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *       },
 *       "import": ["claude-code", "codex"]
 *     }
 *
 * `mcp.json` is gitignored, because a config that spawns commands and holds
 * API keys is not project data. `MCP_CONFIG` names a different path.
 *
 * A server can carry `"disabled": true` to be kept without being started, and
 * `"allow": ["query"]` to offer some of its tools rather than all of them
 * (`"deny"` is the other way round). That is not paranoia about the server: it
 * is about the model. Twenty tool descriptions in a prompt is a large part of
 * a small model's context spent on tools it will not use, and it measurably
 * degrades its choice among the ones it will.
 *
 * `${NAME}` and `${NAME:-fallback}` in any string are read from the
 * environment and `.env`, so a token lives in `.env` rather than in a file
 * that gets pasted into a chat when somebody asks for help with it.
 *
 * ## Servers already configured somewhere else
 *
 * Claude Code, Claude Desktop, Codex and Antigravity each keep their own list
 * of MCP servers, and a reader who uses them has already written that list
 * once. `"import"` (or `MCP_IMPORT` in `.env`) names which of those files to
 * read as well. It is opt-in for the same reason `mcp.json` is: those files
 * are the permission those programs were given, and this one is asked for
 * separately. A server named in `mcp.json` wins over an imported one of the
 * same name.
 *
 * ## Started when first needed, not when the server boots
 *
 * Four MCP servers is four Node or Python processes. Starting them because the
 * app was opened would mean paying for them on a machine whose whole purpose
 * is to have VRAM and RAM free for a model. So a server is spawned on the
 * first request that needs its tools, and a crash is not fatal: the next
 * request starts it again. What a dead server costs is its own tools being
 * missing from one turn, reported as such, rather than the turn failing. A
 * server whose entry in the config changes is restarted with the new one.
 *
 * ## Three transports, one client
 *
 * **stdio** is a child process speaking newline-delimited JSON-RPC on its
 * stdin and stdout. Note *newline-delimited*: the framing with `Content-Length`
 * headers belongs to the Language Server Protocol, which MCP resembles and is
 * not. Its stderr is drained and kept — a server that fails to start says why
 * there and nowhere else, and a pipe nobody reads fills up and blocks the
 * child.
 *
 * **Streamable HTTP** is the same JSON-RPC posted to a URL. The reply may come
 * back as JSON or as one SSE event carrying it, at the server's discretion, so
 * both are read. A session id, if the server issues one, comes back in a
 * header and has to be echoed on every later request or the session is
 * silently a new one each time; a 404 on it means the server forgot it, and
 * the connection is made again.
 *
 * **SSE** is the transport HTTP replaced and a good many servers still speak:
 * a long GET whose first event names where to POST, with every reply coming
 * back down the GET. `"type": "sse"`, or a URL ending in `/sse`.
 *
 * ## Beyond tools
 *
 * A server may also offer *resources* (documents it can hand over by URI) and
 * *prompts* (templates a person picks). Resources reach the model as one more
 * tool per server, `read_resource`; prompts are for the reader, and the panel
 * lists them to be dropped into the message box.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* The revision of the protocol this client implements. A server that speaks a
   different one answers `initialize` saying so, and we keep talking: the parts
   used here -- initialize, tools, resources, prompts -- have been stable across
   every revision, and refusing to work with a server over a date string would
   be a client that breaks every time the spec is published. */
const PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'ollama-webui', title: 'Ollama WebUI', version: '1.0.0' };

/* How long a single JSON-RPC call may take. Generous, because a tool call is
   allowed to do real work -- a query, a page fetch, a build -- and stingy
   enough that a hung server does not hold the chat open for ever. `initialize`
   gets its own, shorter, limit: a server that cannot say hello in twenty
   seconds is not going to answer a query. `npx -y` fetching a package on its
   first run is most of those twenty. */
const CALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;

/* Enough of a tool result to be useful, not enough to flood the context. A
   server returning a whole table has to be trimmed somewhere, and doing it
   here means the trim is reported once rather than discovered as a truncated
   answer. */
const MAX_RESULT_CHARS = 20_000;

/* stderr is kept for the panel to show, because "it did not start" with no
   reason is the most common way this goes wrong and the reason is always
   there. Bounded, or a server that logs every request is a slow memory leak. */
const MAX_STDERR_CHARS = 4_000;

/* A server that pages its lists is asked for this many pages at most. A
   server with ten thousand resources is not going to have them all read into
   a tool description anyway. */
const MAX_PAGES = 20;

/** The tool every server with resources gets, to read one by URI. */
export const RESOURCE_TOOL = 'read_resource';

/**
 * The tool name the model is shown.
 *
 * Prefixed, because two servers may both call a tool `search` and a model
 * handed two identical names cannot pick between them — and because a name
 * arriving from outside this codebase must not be able to collide with a
 * built-in one. `mcp_git_log` cannot be mistaken for `read_file`.
 *
 * Everything outside `[a-z0-9_]` goes, since this ends up in a JSON schema a
 * sampler builds a grammar from, and a model asked to emit `git-log/v2` will
 * produce something close to it rather than it.
 */
export const qualifiedName = (server, tool) =>
  `mcp_${String(server).replace(/[^a-zA-Z0-9_]/g, '_')}_${String(tool).replace(/[^a-zA-Z0-9_]/g, '_')}`;

/* ------------------------------------------------------------ variables */

/**
 * `${NAME}` and `${NAME:-fallback}` in every string of a config, read from
 * `vars`. An unset name with no fallback becomes the empty string, which is
 * what a shell does and what every other MCP client does.
 */
export const expandVars = (value, vars = {}) => {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name, fallback) => {
        const found = vars[name];
        return found !== undefined && found !== '' ? String(found) : (fallback ?? '');
      });
  }
  if (Array.isArray(value)) return value.map(item => expandVars(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandVars(v, vars)]));
  }
  return value;
};

/* ------------------------------------------------------------------ TOML */

/**
 * Enough TOML to read Codex's `config.toml`: tables, dotted and quoted keys,
 * strings of both kinds, numbers, booleans, arrays over several lines and
 * inline tables. Not a TOML parser -- dates and arrays of tables are skipped
 * -- but every key an `[mcp_servers.x]` table can hold is one of the above,
 * and a dependency for the rest would be a dependency for nothing.
 */
export const parseToml = (text) => {
  const root = {};
  let table = root;
  const src = String(text || '').replace(/\r\n?/g, '\n');
  let i = 0;

  const fail = (why) => { throw new Error(`config.toml: ${why} near line ${src.slice(0, i).split('\n').length}`); };
  const skipSpace = (newlines = false) => {
    for (;;) {
      const c = src[i];
      if (c === ' ' || c === '\t' || (newlines && c === '\n')) { i++; continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
      return;
    }
  };

  const readString = () => {
    const quote = src[i];
    const triple = src.startsWith(quote.repeat(3), i);
    i += triple ? 3 : 1;
    if (triple && src[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= src.length) fail('unterminated string');
      if (triple ? src.startsWith(quote.repeat(3), i) : src[i] === quote) { i += triple ? 3 : 1; return out; }
      const c = src[i++];
      if (c === '\n' && !triple) fail('newline in string');
      if (c === '\\' && quote === '"') {
        const e = src[i++];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (e in simple) out += simple[e];
        else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          out += String.fromCodePoint(parseInt(src.slice(i, i + len), 16));
          i += len;
        } else if (e === '\n' && triple) { while (/\s/.test(src[i] || '')) i++; }
        else fail(`bad escape \\${e}`);
        continue;
      }
      out += c;
    }
  };

  const readKey = () => {
    const parts = [];
    for (;;) {
      skipSpace();
      if (src[i] === '"' || src[i] === "'") parts.push(readString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
        if (!m) fail('expected a key');
        parts.push(m[0]);
        i += m[0].length;
      }
      skipSpace();
      if (src[i] !== '.') return parts;
      i++;
    }
  };

  const readValue = () => {
    skipSpace();
    const c = src[i];
    if (c === '"' || c === "'") return readString();
    if (c === '[') {
      i++;
      const list = [];
      for (;;) {
        skipSpace(true);
        if (src[i] === ']') { i++; return list; }
        list.push(readValue());
        skipSpace(true);
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return list; }
        fail('expected , or ] in an array');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      skipSpace();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        const key = readKey();
        if (src[i] !== '=') fail('expected = in an inline table');
        i++;
        setPath(obj, key, readValue());
        skipSpace();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail('expected , or } in an inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i));
    if (!m) fail('expected a value');
    i += m[0].length;
    const word = m[0];
    if (word === 'true') return true;
    if (word === 'false') return false;
    const n = Number(word.replace(/_/g, ''));
    return Number.isFinite(n) ? n : word;
  };

  const setPath = (obj, keys, value) => {
    let at = obj;
    for (const key of keys.slice(0, -1)) {
      if (!at[key] || typeof at[key] !== 'object') at[key] = {};
      at = at[key];
    }
    at[keys[keys.length - 1]] = value;
  };

  while (i < src.length) {
    skipSpace(true);
    if (i >= src.length) break;
    if (src[i] === '[') {
      const array = src[i + 1] === '[';
      i += array ? 2 : 1;
      const keys = readKey();
      i += array ? 2 : 1;
      if (array) {
        // An array of tables: nothing Codex keeps MCP servers in. Its rows go
        // to a table nobody reads, rather than over one somebody does.
        table = {};
        continue;
      }
      table = root;
      for (const key of keys) {
        if (!table[key] || typeof table[key] !== 'object') table[key] = {};
        table = table[key];
      }
      continue;
    }
    const key = readKey();
    if (src[i] !== '=') fail('expected =');
    i++;
    setPath(table, key, readValue());
    skipSpace();
    if (i < src.length && src[i] !== '\n') fail('expected the end of the line');
  }
  return root;
};

/* --------------------------------------------------------------- imports */

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

/**
 * Where each other client keeps its MCP servers, and how to read them.
 *
 * Every reader returns the servers in whatever spelling that client uses;
 * `normalizeServer` below turns every spelling into one.
 */
export const IMPORT_SOURCES = {
  /* User-scope servers, plus the project-scope ones for this directory. The
     file is Claude Code's whole state; only two keys of it are read. */
  'claude-code': {
    file: ({ home }) => path.join(home, '.claude.json'),
    read: (file, { cwd }) => {
      const data = readJson(file);
      const key = (dir) => path.resolve(dir).split(path.sep).join('/').toLowerCase();
      const project = Object.entries(data.projects || {})
        .find(([dir]) => key(dir) === key(cwd))?.[1];
      return { ...(data.mcpServers || {}), ...(project?.mcpServers || {}) };
    },
  },
  'claude-desktop': {
    file: ({ home, env }) => path.join(
      process.platform === 'win32'
        ? (env.APPDATA || process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
        : process.platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support')
          : path.join(home, '.config'),
      'Claude', 'claude_desktop_config.json',
    ),
    read: (file) => readJson(file).mcpServers || {},
  },
  codex: {
    file: ({ home, env }) => path.join(env.CODEX_HOME || process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
    read: (file) => parseToml(fs.readFileSync(file, 'utf8')).mcp_servers || {},
  },
  antigravity: {
    file: ({ home }) => path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    read: (file) => {
      const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
      // An empty file is what Antigravity leaves before a server is added.
      return text ? (JSON.parse(text).mcpServers || {}) : {};
    },
  },
};

/* Read again only when the file changes: the panel, every turn and every CLI
   invocation ask, and the answer is the same until somebody edits the file. */
const importCache = new Map();
const readImport = (source, { home, cwd, env }) => {
  const spec = IMPORT_SOURCES[source];
  const file = spec.file({ home, env });
  const stat = fs.statSync(file);
  const key = `${file}|${cwd}`;
  const cached = importCache.get(key);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return { file, servers: cached.servers };
  const servers = spec.read(file, { cwd });
  importCache.set(key, { mtime: stat.mtimeMs, size: stat.size, servers });
  return { file, servers };
};

// The names people will type for them.
const IMPORT_ALIASES = { claude: 'claude-code', desktop: 'claude-desktop', agy: 'antigravity', gemini: 'antigravity' };
export const importNameOf = (name) => {
  const key = String(name || '').trim().toLowerCase();
  return IMPORT_ALIASES[key] || key;
};

/**
 * One server's entry, in any client's spelling, as the one shape used here:
 * `{ transport, command, args, env, cwd, url, headers, allow, deny, timeout,
 * disabled, resources }`.
 *
 * - Codex writes `enabled = false`, `enabled_tools`, `disabled_tools`,
 *   `http_headers`, `bearer_token_env_var`, `tool_timeout_sec`.
 * - Antigravity writes `serverUrl`; Gemini CLI `httpUrl`.
 * - Claude writes `"type": "stdio" | "http" | "sse"`.
 */
export const normalizeServer = (raw, vars = {}) => {
  const c = expandVars(raw || {}, vars);
  const url = c.url || c.serverUrl || c.httpUrl || '';
  const type = String(c.type || c.transport || '').toLowerCase();
  const headers = { ...(c.headers || {}), ...(c.http_headers || {}) };
  for (const [header, name] of Object.entries(c.env_http_headers || {})) {
    if (vars[name]) headers[header] = vars[name];
  }
  if (c.bearer_token_env_var && vars[c.bearer_token_env_var]) {
    headers.Authorization = `Bearer ${vars[c.bearer_token_env_var]}`;
  }
  const transport = !url ? 'stdio'
    : type === 'sse' || (!type && !c.httpUrl && /\/sse\/?(\?.*)?$/i.test(url)) ? 'sse'
      : 'http';
  const list = (value) => (Array.isArray(value) ? value.map(String) : null);
  const seconds = Number(c.tool_timeout_sec);
  return {
    transport,
    command: c.command || '',
    args: Array.isArray(c.args) ? c.args.map(String) : [],
    env: c.env && typeof c.env === 'object' ? c.env : {},
    cwd: c.cwd || '',
    url,
    headers,
    allow: list(c.allow) || list(c.enabled_tools) || list(c.includeTools),
    deny: list(c.deny) || list(c.disabled_tools) || list(c.excludeTools),
    timeout: Number(c.timeout) > 0 ? Number(c.timeout) : seconds > 0 ? seconds * 1000 : CALL_TIMEOUT_MS,
    disabled: c.disabled === true || c.enabled === false,
    resources: c.resources !== false,
  };
};

/** Read the config file and whatever it imports, or explain why there is nothing. */
export const readConfig = (env = {}, { cwd = process.cwd(), home = os.homedir() } = {}) => {
  const file = env.MCP_CONFIG
    ? path.resolve(cwd, env.MCP_CONFIG)
    : path.join(cwd, 'mcp.json');
  const vars = { ...process.env, ...env };

  let parsed = {};
  let missing = !fs.existsSync(file);
  let error;
  if (!missing) {
    try {
      parsed = readJson(file) || {};
    } catch (e) {
      return { file, servers: {}, imports: [], error: `${path.basename(file)} is not valid JSON: ${e.message}` };
    }
  }

  /* Both spellings. `mcpServers` is what the ecosystem's files use and what
     somebody will paste in; `servers` is what a person writing one from
     scratch guesses. Accepting both costs a line. */
  const raw = parsed?.mcpServers || parsed?.servers || {};
  const servers = {};
  for (const [name, config] of Object.entries(raw)) {
    if (!config || typeof config !== 'object') continue;
    servers[name] = { ...normalizeServer(config, vars), source: 'mcp.json' };
  }

  const wanted = [
    ...(Array.isArray(parsed?.import) ? parsed.import : []),
    ...String(env.MCP_IMPORT || '').split(','),
  ].map(importNameOf).filter(Boolean);
  const imports = [];
  for (const source of [...new Set(wanted)]) {
    if (!IMPORT_SOURCES[source]) { imports.push({ source, error: `unknown import '${source}'` }); continue; }
    try {
      const found = readImport(source, { home, cwd, env });
      let count = 0;
      for (const [name, config] of Object.entries(found.servers || {})) {
        if (!config || typeof config !== 'object' || servers[name]) continue;
        servers[name] = { ...normalizeServer(config, vars), source };
        count++;
      }
      imports.push({ source, file: found.file, count });
    } catch (e) {
      imports.push({ source, error: e.code === 'ENOENT' ? `not found (${e.path})` : e.message });
    }
  }

  if (missing && imports.length) missing = false;
  return { file, servers, imports, missing, error };
};

/* ------------------------------------------------------------ transports */

/* One JSON-RPC id space per process, so a reply can never be matched to a
   request from a different connection. */
let nextId = 1;

/**
 * What a server asks of us, answered.
 *
 * Servers may send requests too: `ping` to see we are alive, `roots/list` to
 * ask which directories it may work in. `sampling` and `elicitation` would
 * hand a server the model or the reader, and are refused rather than ignored
 * -- a request nobody answers is a server waiting for ever.
 */
const answerServer = (message, { cwd }) => {
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  if (message.method === 'roots/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { roots: [{ uri: pathToFileURL(cwd).href, name: path.basename(cwd) }] },
    };
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported by this client` } };
};

/**
 * Sorting one incoming message: a reply to something we asked, a request the
 * server makes of us, or a notification. A request and a reply both carry an
 * id and the ids are the server's own for requests, so it is `method` that
 * tells them apart -- going by id alone, a server's request 3 answers our
 * call 3.
 */
const routeMessage = (message, { pending, reply, onNotification, cwd }) => {
  if (!message || typeof message !== 'object') return;
  if (message.method) {
    if (message.id !== undefined) reply(answerServer(message, { cwd }));
    else onNotification?.(message.method, message.params || {});
    return;
  }
  const waiting = pending.get(message.id);
  if (waiting) { pending.delete(message.id); waiting(message); }
};

/**
 * Whether this command has to go through a shell, and how to spell it if so.
 *
 * On Windows `npx`, `uvx` and most of the ecosystem's launchers are `.cmd`
 * shims, which `CreateProcess` cannot execute — the spawn fails with EINVAL
 * and a message naming the shim rather than the reason. A shell fixes that,
 * and immediately breaks the other half of the cases: with `shell: true` the
 * command and its arguments are concatenated into one command line, so
 * `C:\Program Files\nodejs\node.exe` is read as the program `C:\Program` with
 * `Files\nodejs\node.exe` as its first argument. That is not a hypothetical
 * path; it is where Node installs itself.
 *
 * So the shell is used only where it is needed — a bare name, or a shim — and
 * everything going through it is quoted. An executable named by its full path
 * is spawned directly, which is both correct and one less process.
 */
export const shellPlan = (config) => {
  if (process.platform !== 'win32') return { shell: false, command: config.command, args: config.args || [] };

  // A real executable named outright needs no interpreter.
  if (/\.(exe|com)$/i.test(config.command)) {
    return { shell: false, command: config.command, args: config.args || [] };
  }

  const quote = (value) => (/[\s&|<>^]/.test(String(value)) ? `"${value}"` : String(value));
  return {
    shell: true,
    command: quote(config.command),
    args: (config.args || []).map(quote),
  };
};

/* A pending call, with its own timer, settled by whichever comes first. */
const makeCall = (name, pending, send) => (method, params, timeoutMs = CALL_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${name}: '${method}' did not answer within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();

    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || 'the server returned an error'));
      else resolve(message.result);
    });

    Promise.resolve()
      .then(() => send({ jsonrpc: '2.0', id, method, params }))
      .catch((e) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      });
  });

const connectStdio = (name, config, { onLog, onNotification, cwd }) => {
  const plan = shellPlan(config);
  const child = spawn(plan.command, plan.args, {
    /* The server's own environment plus whatever the config adds. Passing only
       what the config names would break every server that reads PATH, HOME or
       a proxy setting, which is nearly all of them. */
    env: { ...process.env, ...(config.env || {}) },
    cwd: config.cwd || cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: plan.shell,
    windowsHide: true,
  });

  const pending = new Map();
  let stderr = '';
  let buffer = '';
  let dead = null;

  const send = (payload) => {
    if (dead) throw new Error(dead);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    /* Newline-delimited, and a message may arrive split across chunks or
       several at once. Both are normal and neither is an error. */
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (e) {
        /* A server that prints a banner to stdout has broken its own
           transport. Worth saying once, and worth surviving. */
        onLog?.(`${name}: ignored a non-JSON line on stdout`);
        continue;
      }
      routeMessage(message, {
        pending, onNotification, cwd,
        reply: (payload) => { try { send(payload); } catch { /* it is going away */ } },
      });
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });

  const die = (reason) => {
    if (dead) return;
    dead = reason;
    for (const [, waiting] of pending) waiting({ error: { message: reason } });
    pending.clear();
  };

  child.on('error', (e) => die(`could not start '${config.command}': ${e.message}`));
  child.on('exit', (code, signal) => die(
    `'${config.command}' exited (${signal || `code ${code}`})${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`,
  ));
  child.stdin.on('error', () => { /* it exited first; `exit` says why */ });

  return {
    kind: 'stdio',
    get stderr() { return stderr; },
    get dead() { return dead; },
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    call: makeCall(name, pending, send),
    /* Closed in the order the handles can survive. Killing first and tearing
       down the pipes afterwards means a write can land on a handle that is
       already closing, which on Windows is not an exception — it is libuv
       aborting the process, after the work is done and with an assertion for a
       message. So: stop writing, end the pipe, and only kill something that
       has not already exited. */
    close: () => {
      die('closed');
      try { child.stdin.end(); child.stdin.destroy(); } catch (e) { /* already closed */ }
      try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) { /* already closed */ }
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      } catch (e) { /* already gone */ }
    },
  };
};

/* What an HTTP failure means, in words that say what to do about it. */
const httpError = (res, url) => {
  if (res.status === 401 || res.status === 403) {
    return new Error(`HTTP ${res.status} from ${url}: the server wants credentials. `
      + 'Put a token in "headers" (e.g. "Authorization": "Bearer ${TOKEN}") -- OAuth sign-in is not supported here.');
  }
  return new Error(`HTTP ${res.status} from ${url}`);
};

const connectHttp = (name, config, { onNotification, cwd }) => {
  /* Issued by the server on `initialize` and required on every request after
     it. A client that forgets it gets a fresh, empty session each call, which
     works for a stateless server and silently loses state on any other. */
  let session = null;
  let dead = null;
  let protocol = null;

  const post = async (payload, timeoutMs) => {
    if (dead) throw new Error(dead);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          /* Both, because the server chooses which to reply with per request
             and a client that accepts one of them gets a 406 for the other. */
          Accept: 'application/json, text/event-stream',
          ...(session ? { 'Mcp-Session-Id': session } : {}),
          ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}),
          ...(config.headers || {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const issued = res.headers.get('mcp-session-id');
      if (issued) session = issued;

      /* The server has forgotten the session: restarted, or expired it. The
         connection is dead and the pool makes a new one. */
      if (res.status === 404 && session && payload.method !== 'initialize') {
        dead = 'the server ended the session';
        throw new Error(`${name}: ${dead}`);
      }

      /* A notification is answered with 202 and no body. Reading it as JSON
         would throw on the empty string. */
      if (res.status === 202) return null;
      if (!res.ok) throw httpError(res, config.url);

      const type = res.headers.get('content-type') || '';
      const text = await res.text();

      if (type.includes('text/event-stream')) {
        /* One JSON-RPC message per `data:` line. Several may arrive; the reply
           to this request is the one carrying its id, and anything else is a
           notification we did not ask for -- handed on, since a list having
           changed is worth knowing. */
        let reply = null;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const message = JSON.parse(line.slice(5).trim());
            if (message?.id !== undefined && !message.method) reply = message;
            else if (message?.method && message.id === undefined) onNotification?.(message.method, message.params || {});
          } catch (e) { /* a keep-alive comment, or a partial frame */ }
        }
        return reply;
      }

      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`${name}: '${payload.method}' did not answer within ${Math.round(timeoutMs / 1000)}s`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    kind: 'http',
    stderr: '',
    get dead() { return dead; },
    set protocol(value) { protocol = value; },
    notify: (method, params) => post({ jsonrpc: '2.0', method, params }, HANDSHAKE_TIMEOUT_MS).catch(() => {}),
    call: async (method, params, timeoutMs = CALL_TIMEOUT_MS) => {
      const message = await post({ jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs);
      if (!message) throw new Error(`${name}: no reply to '${method}'`);
      if (message.error) throw new Error(message.error.message || 'the server returned an error');
      return message.result;
    },
    /* Said goodbye to, so the server can let the session go now rather than
       when it times out. Nobody waits for the answer. */
    close: () => {
      const had = session;
      dead = dead || 'closed';
      session = null;
      if (had) {
        fetch(config.url, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': had, ...(config.headers || {}) },
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
    },
  };
};

/**
 * Read an SSE stream, calling `onEvent({ event, data })` per event. Resolves
 * when the stream ends.
 */
const readEvents = async (body, onEvent) => {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data = [];
  const flush = () => {
    if (data.length) onEvent({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).replace(/\r$/, '');
      buffer = buffer.slice(cut + 1);
      if (line === '') flush();
      else if (line.startsWith(':')) continue;
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
};

/**
 * The older SSE transport: GET a stream, wait for the `endpoint` event that
 * says where to POST, and read every reply off the stream.
 */
const connectSse = (name, config, { onNotification, cwd }) => {
  const controller = new AbortController();
  const pending = new Map();
  let dead = null;
  let endpoint = null;
  let found;
  let lost;
  const ready = new Promise((resolve, reject) => { found = resolve; lost = reject; });
  ready.catch(() => {});

  const die = (reason) => {
    if (dead) return;
    dead = reason;
    lost(new Error(`${name}: ${reason}`));
    for (const [, waiting] of pending) waiting({ error: { message: reason } });
    pending.clear();
  };

  const post = async (payload) => {
    await ready;
    if (dead) throw new Error(dead);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 202) throw httpError(res, endpoint);
  };

  (async () => {
    const res = await fetch(config.url, {
      headers: { Accept: 'text/event-stream', ...(config.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) throw httpError(res, config.url);
    await readEvents(res.body, ({ event, data }) => {
      if (event === 'endpoint') {
        endpoint = new URL(data.trim(), config.url).href;
        found();
        return;
      }
      let message;
      try { message = JSON.parse(data); } catch { return; }
      routeMessage(message, {
        pending, onNotification, cwd,
        reply: (payload) => { post(payload).catch(() => {}); },
      });
    });
    die('the event stream ended');
  })().catch((e) => die(e.name === 'AbortError' ? 'closed' : `could not reach ${config.url}: ${e.message}`));

  return {
    kind: 'sse',
    stderr: '',
    get dead() { return dead; },
    notify: (method, params) => post({ jsonrpc: '2.0', method, params }).catch(() => {}),
    call: makeCall(name, pending, post),
    close: () => { die('closed'); controller.abort(); },
  };
};

/* ------------------------------------------------------------ the pool */

/** Every page of a paginated list, up to a limit. */
const listAll = async (connection, method, key) => {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await connection.call(method, cursor ? { cursor } : {}, HANDSHAKE_TIMEOUT_MS);
    items.push(...(result?.[key] || []));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return items;
};

/**
 * A result's content parts as text for the model, with any pictures kept
 * aside for a caller that can show them.
 *
 * A base64 PNG inlined in a chat would be a megabyte of tokens the model
 * reads as gibberish, so a picture is named in the text and returned
 * separately. `structuredContent` is used when a tool sent nothing else.
 */
export const renderContent = (result) => {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const images = [];
  const lines = parts.map((part) => {
    switch (part?.type) {
      case 'text': return part.text;
      case 'image':
        images.push({ mimeType: part.mimeType || 'image/png', data: part.data || '' });
        return `[image ${images.length}: ${part.mimeType || 'image'}, ${Math.round(((part.data || '').length * 3) / 4 / 1024)} KB]`;
      case 'audio': return `[audio: ${part.mimeType || 'audio'}, which this app does not pass to the model]`;
      case 'resource_link': return `[resource: ${part.name || part.uri}${part.name ? ` <${part.uri}>` : ''}]`;
      case 'resource': return part.resource?.text || `[resource: ${part.resource?.uri || 'unnamed'}]`;
      default: return `[${part?.type || 'unknown'} content, which this app does not pass to the model]`;
    }
  }).filter(Boolean);
  if (!lines.length && result?.structuredContent !== undefined) {
    lines.push(JSON.stringify(result.structuredContent, null, 2));
  }
  const text = lines.join('\n');
  const trimmed = text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[... trimmed; the tool returned ${text.length} characters]`
    : text;
  return { text: trimmed, images };
};

/* The synthetic tool that reads a server's resources, described with a few of
   them so the model knows what there is to ask for. */
const resourceTool = (server, resources, templates) => {
  const shown = resources.slice(0, 15).map(r => `  ${r.uri}${r.name ? ` -- ${r.name}` : ''}`);
  const more = resources.length > shown.length ? `\n  ... and ${resources.length - shown.length} more` : '';
  const patterns = templates.slice(0, 5).map(t => `  ${t.uriTemplate}${t.name ? ` -- ${t.name}` : ''}`);
  return {
    name: RESOURCE_TOOL,
    qualified: qualifiedName(server, RESOURCE_TOOL),
    synthetic: true,
    description: [
      `Read a resource from the ${server} server by its URI.`,
      shown.length ? `Resources:\n${shown.join('\n')}${more}` : '',
      patterns.length ? `URI templates:\n${patterns.join('\n')}` : '',
    ].filter(Boolean).join('\n'),
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'The URI of the resource to read' } },
      required: ['uri'],
    },
    annotations: { readOnlyHint: true },
  };
};

/**
 * The pool.
 *
 * One live connection per configured server, built on demand and remembered
 * until it dies or its config changes. `tools` is what `tools/list` said,
 * cached with it: a server may add a tool while running, and says so with a
 * notification that marks the list stale -- but asking again before every
 * turn is a round trip per server per message to hear the same answer.
 */
export const createMcpPool = (env = {}, { cwd = process.cwd(), home = os.homedir(), onLog = null } = {}) => {
  const live = new Map();          // name -> entry
  const starting = new Map();      // name -> Promise, so two turns at once start one process
  const failures = new Map();      // name -> the last reason it could not start

  const config = () => readConfig(env, { cwd, home });
  const configFor = (name) => config().servers[name] || null;
  const fingerprint = (c) => JSON.stringify(c);

  const describe = async (name, c, connection) => {
    const allow = c.allow ? new Set(c.allow) : null;
    const deny = new Set(c.deny || []);
    const listed = await listAll(connection, 'tools/list', 'tools');
    const tools = listed
      .filter(tool => tool?.name && (!allow || allow.has(tool.name)) && !deny.has(tool.name))
      .map(tool => ({
        name: tool.name,
        qualified: qualifiedName(name, tool.name),
        title: tool.title || tool.annotations?.title || '',
        description: tool.description || `A tool from the ${name} server.`,
        /* The schema is passed to the model verbatim. A server that sends
           none gets an empty object, which is a tool taking no arguments --
           the honest reading, and one the sampler can build a grammar from.
           `undefined` here would be a schema-less function in the request
           and a 400 from Ollama. */
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        annotations: tool.annotations || {},
      }));
    return tools;
  };

  const describeExtras = async (connection, capabilities, c) => {
    const quietly = (promise) => promise.catch(() => []);
    const [resources, templates, prompts] = await Promise.all([
      capabilities.resources && c.resources ? quietly(listAll(connection, 'resources/list', 'resources')) : [],
      capabilities.resources && c.resources ? quietly(listAll(connection, 'resources/templates/list', 'resourceTemplates')) : [],
      capabilities.prompts ? quietly(listAll(connection, 'prompts/list', 'prompts')) : [],
    ]);
    return { resources, templates, prompts };
  };

  const handshake = async (name, c) => {
    let entry = null;
    const onNotification = (method) => {
      if (!entry) return;
      if (method === 'notifications/tools/list_changed') entry.stale = true;
      if (method === 'notifications/resources/list_changed' || method === 'notifications/prompts/list_changed') {
        entry.staleExtras = true;
      }
    };
    const options = { onLog, onNotification, cwd };
    const connection = c.transport === 'sse' ? connectSse(name, c, options)
      : c.transport === 'http' ? connectHttp(name, c, options)
        : connectStdio(name, c, options);

    try {
      const hello = await connection.call('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        /* No `roots`. The filesystem server, offered roots, drops the
           directories its own arguments name and uses the roots instead --
           so offering this app's directory would quietly overrule what
           `mcp.json` says it may read. The file is the permission. */
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }, HANDSHAKE_TIMEOUT_MS);
      if ('protocol' in connection) connection.protocol = hello?.protocolVersion || PROTOCOL_VERSION;

      /* Required by the spec and easy to skip, because most servers answer
         `tools/list` without it. The ones that do not simply never reply, and
         the failure looks like a timeout rather than a missing notification. */
      await connection.notify('notifications/initialized');

      const capabilities = hello?.capabilities || {};
      /* Asked even when it declares no tools: plenty of servers leave the
         capability out and answer anyway. Only a declared one may fail loudly. */
      const tools = capabilities.tools
        ? await describe(name, c, connection)
        : await describe(name, c, connection).catch(() => []);
      const extras = await describeExtras(connection, capabilities, c);

      entry = {
        connection,
        config: c,
        fingerprint: fingerprint(c),
        tools,
        ...extras,
        capabilities,
        serverInfo: hello?.serverInfo || {},
        instructions: typeof hello?.instructions === 'string' ? hello.instructions : '',
        startedAt: Date.now(),
        stale: false,
        staleExtras: false,
      };
      return entry;
    } catch (e) {
      connection.close();
      throw e;
    }
  };

  const drop = (name) => {
    const entry = live.get(name);
    if (entry) entry.connection.close();
    live.delete(name);
  };

  const connect = async (name) => {
    const c = configFor(name);
    const existing = live.get(name);
    if (existing && !existing.connection.dead && c && !c.disabled && existing.fingerprint === fingerprint(c)) {
      if (existing.stale) {
        existing.stale = false;
        existing.tools = await describe(name, existing.config, existing.connection).catch(() => existing.tools);
      }
      if (existing.staleExtras) {
        existing.staleExtras = false;
        Object.assign(existing, await describeExtras(existing.connection, existing.capabilities, existing.config));
      }
      return existing;
    }
    if (existing) drop(name);          // it died, or its config changed; start again

    if (starting.has(name)) return starting.get(name);

    if (!c) throw new Error(`No MCP server named '${name}' is configured`);
    if (c.disabled) throw new Error(`The MCP server '${name}' is switched off in the config`);
    if (!c.url && !c.command) {
      throw new Error(`The MCP server '${name}' has neither a 'command' nor a 'url'`);
    }

    const attempt = handshake(name, c)
      .then((entry) => { live.set(name, entry); failures.delete(name); return entry; })
      .catch((e) => { failures.set(name, e.message || String(e)); throw e; })
      .finally(() => starting.delete(name));

    starting.set(name, attempt);
    return attempt;
  };

  /* The tools one server offers the model, its resource reader included. */
  const toolsOf = (name, entry) => {
    const list = entry.tools.map(tool => ({ ...tool, server: name }));
    /* An allow-list means "only these", so the reader is offered only when it
       is on it -- by the same name the model would call it. */
    const { allow, deny } = entry.config;
    const hasReader = (entry.resources.length || entry.templates.length)
      && !entry.tools.some(tool => tool.name === RESOURCE_TOOL)
      && (!allow || allow.includes(RESOURCE_TOOL)) && !(deny || []).includes(RESOURCE_TOOL);
    if (hasReader) list.push({ ...resourceTool(name, entry.resources, entry.templates), server: name });
    return list;
  };

  /**
   * Every tool on offer, with the servers that could not be reached named.
   *
   * One server being down must not cost the others their tools, so each is
   * settled on its own and a failure becomes a line in `problems` rather than
   * a rejection. The interface shows those; the model is not told about them,
   * because "a tool exists but is broken" is not something it can act on.
   */
  const listTools = async () => {
    const { servers, file, missing, error, imports } = config();
    const names = Object.entries(servers).filter(([, c]) => !c.disabled).map(([n]) => n);

    // A server taken out of the config, or switched off, is stopped.
    for (const name of [...live.keys()]) if (!names.includes(name)) drop(name);

    const tools = [];
    const problems = [];
    if (error) problems.push({ server: null, error });
    for (const found of imports || []) {
      if (found.error) problems.push({ server: null, error: `import ${found.source}: ${found.error}` });
    }

    const results = await Promise.allSettled(names.map(name => connect(name)));
    const status = [];
    results.forEach((result, i) => {
      const name = names[i];
      const c = servers[name];
      if (result.status === 'fulfilled') {
        const entry = result.value;
        const offered = toolsOf(name, entry);
        tools.push(...offered);
        status.push({
          name,
          source: c.source,
          transport: c.transport,
          state: 'running',
          startedAt: entry.startedAt,
          stats: statsOf(name),
          serverInfo: entry.serverInfo,
          instructions: entry.instructions.slice(0, 500),
          tools: offered.length,
          resources: entry.resources.length,
          prompts: entry.prompts.map(p => ({
            name: p.name,
            title: p.title || '',
            description: p.description || '',
            arguments: (p.arguments || []).map(a => ({ name: a.name, description: a.description || '', required: !!a.required })),
          })),
        });
      } else {
        const reason = result.reason?.message || String(result.reason);
        problems.push({ server: name, error: reason });
        status.push({ name, source: c.source, transport: c.transport, state: 'failed', error: reason, stats: statsOf(name), tools: 0, resources: 0, prompts: [] });
      }
    });
    for (const [name, c] of Object.entries(servers)) {
      if (c.disabled) status.push({ name, source: c.source, transport: c.transport, state: 'disabled', tools: 0, resources: 0, prompts: [] });
    }

    return {
      tools, problems, file,
      servers: status,
      imports: imports || [],
      configured: names.length,
      missing: !!missing,
    };
  };

  /**
   * Run one tool and return its text.
   *
   * `isError` is the server saying the *tool* failed -- a query with a syntax
   * error, a file that is not there. That is a result the model should see
   * and act on, not an exception: it is the difference between "your SQL was
   * wrong" and "the database is unreachable".
   */
  const callTool = async (serverName, toolName, args, { timeoutMs } = {}) => {
    const run = async () => {
      const entry = await connect(serverName);
      const offered = toolsOf(serverName, entry);
      const tool = offered.find(t => t.name === toolName);
      if (!tool) throw new Error(`The '${serverName}' server has no tool called '${toolName}'`);
      const limit = timeoutMs || entry.config.timeout;

      if (tool.synthetic) {
        const uri = String(args?.uri || '').trim();
        if (!uri) return { isError: true, text: "read_resource needs a 'uri'", images: [] };
        const result = await entry.connection.call('resources/read', { uri }, limit);
        const contents = Array.isArray(result?.contents) ? result.contents : [];
        const parts = contents.map(item => (item.text !== undefined
          ? { type: 'text', text: item.text }
          : item.blob && /^image\//.test(item.mimeType || '')
            ? { type: 'image', data: item.blob, mimeType: item.mimeType }
            : { type: 'text', text: `[${item.mimeType || 'binary'} resource ${item.uri}, ${Math.round((item.blob || '').length * 0.75 / 1024)} KB]` }));
        const rendered = renderContent({ content: parts });
        return { isError: false, text: rendered.text || '(the resource is empty)', images: rendered.images };
      }

      const result = await entry.connection.call('tools/call', {
        name: toolName,
        arguments: args && typeof args === 'object' ? args : {},
      }, limit);
      const rendered = renderContent(result);
      return {
        isError: !!result?.isError,
        text: rendered.text || '(the tool returned nothing)',
        images: rendered.images,
      };
    };

    const began = Date.now();
    try {
      let result;
      try {
        result = await run();
      } catch (e) {
        /* An HTTP session the server forgot is not the tool failing: the
           connection is made again and the call asked once more. */
        const entry = live.get(serverName);
        if (entry?.connection.dead && /ended the session/.test(e.message)) result = await run();
        else throw e;
      }
      countCall(serverName, toolName, Date.now() - began, result?.isError ? String(result.text || '').split('\n')[0] : '');
      return result;
    } catch (e) {
      countCall(serverName, toolName, Date.now() - began, e.message || String(e));
      throw e;
    }
  };

  /* How each server's tools have been used since this process started, for
     the panel (src/McpPanel.jsx): calls, failures, time, the last error. */
  const stats = new Map();
  const countCall = (server, tool, ms, error = '') => {
    const s = stats.get(server) || { calls: 0, errors: 0, ms: 0, lastAt: 0, lastError: '', lastErrorAt: 0, tools: {} };
    const t = s.tools[tool] || { calls: 0, errors: 0, ms: 0 };
    s.calls += 1; t.calls += 1; s.ms += ms; t.ms += ms; s.lastAt = Date.now();
    if (error) { s.errors += 1; t.errors += 1; s.lastError = String(error).slice(0, 300); s.lastErrorAt = Date.now(); }
    s.tools[tool] = t;
    stats.set(server, s);
  };
  const statsOf = (name) => stats.get(name) || null;

  /** One prompt, filled in, as the text of its messages. */
  const getPrompt = async (serverName, promptName, args = {}) => {
    const entry = await connect(serverName);
    const result = await entry.connection.call('prompts/get', {
      name: promptName,
      arguments: Object.fromEntries(Object.entries(args || {}).map(([k, v]) => [k, String(v)])),
    }, entry.config.timeout);
    const messages = (result?.messages || []).map(message => ({
      role: message.role,
      text: renderContent({ content: [message.content].flat().filter(Boolean) }).text,
    }));
    return { description: result?.description || '', messages, text: messages.map(m => m.text).join('\n\n') };
  };

  /** What resources each running server has. */
  const listResources = async (serverName) => {
    const entry = await connect(serverName);
    return { resources: entry.resources, templates: entry.templates };
  };

  /** Stop one server, or all of them, so the next request starts it afresh. */
  const restart = (name) => {
    if (name) { drop(name); failures.delete(name); return; }
    for (const key of [...live.keys()]) drop(key);
    failures.clear();
    importCache.clear();
  };

  const close = () => {
    for (const [, entry] of live) entry.connection.close();
    live.clear();
  };

  return { listTools, callTool, getPrompt, listResources, connect, restart, close };
};

/**
 * `/mcp/tools`, `/mcp/call`, and the routes around them.
 *
 * Mounted always. With no `mcp.json` they answer with an empty list and say
 * which file they looked for, which is what lets the panel explain itself
 * rather than 404.
 */
export const createMcpRoutes = (env = {}, { cwd = process.cwd(), readBody, onLog = null } = {}) => {
  const pool = createMcpPool(env, { cwd, onLog });
  const routes = [];
  const route = (routePath, handler) => routes.push({ path: routePath, handler });

  const json = (res, payload, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  };
  const bodyOf = async (req) => JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');

  route('/mcp/tools', async (req, res) => {
    try {
      json(res, { success: true, ...(await pool.listTools()) });
    } catch (e) {
      json(res, { success: false, error: e.message }, 500);
    }
  });

  route('/mcp/call', async (req, res) => {
    try {
      const { server, tool, args } = await bodyOf(req);
      if (!server || !tool) return json(res, { success: false, error: "'server' and 'tool' are required" }, 400);
      const result = await pool.callTool(server, tool, args);
      json(res, { success: true, ...result });
    } catch (e) {
      /* A tool that could not be run at all is still answered 200 with the
         reason, because the caller is a chat turn: the model is given the
         sentence and can say "that tool is not available" or try another. A
         500 here becomes an exception in the middle of an answer. */
      json(res, { success: false, error: e.message });
    }
  });

  /* Only servers the config already names can be restarted; this starts
     nothing the file did not already allow. */
  route('/mcp/restart', async (req, res) => {
    if (req.method !== 'POST') return json(res, { success: false, error: 'POST only' }, 405);
    try {
      const { server } = await bodyOf(req);
      pool.restart(server ? String(server) : '');
      json(res, { success: true, ...(await pool.listTools()) });
    } catch (e) {
      json(res, { success: false, error: e.message }, 500);
    }
  });

  route('/mcp/prompt', async (req, res) => {
    try {
      const { server, name, args } = await bodyOf(req);
      if (!server || !name) return json(res, { success: false, error: "'server' and 'name' are required" }, 400);
      json(res, { success: true, ...(await pool.getPrompt(String(server), String(name), args)) });
    } catch (e) {
      json(res, { success: false, error: e.message });
    }
  });

  route('/mcp/resources', async (req, res) => {
    try {
      const { server } = req.method === 'POST' ? await bodyOf(req) : {};
      if (!server) return json(res, { success: false, error: "'server' is required" }, 400);
      json(res, { success: true, ...(await pool.listResources(String(server))) });
    } catch (e) {
      json(res, { success: false, error: e.message });
    }
  });

  /* Processes this app started are processes this app ends. Without it, a dev
     server restarted forty times leaves forty Python servers running. */
  const shutdown = () => pool.close();
  process.once('exit', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return routes;
};
