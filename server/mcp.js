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
 *         "docs":   { "url": "https://example.internal/mcp" }
 *       }
 *     }
 *
 * `mcp.json` is gitignored, because a config that spawns commands and holds
 * API keys is not project data. `MCP_CONFIG` names a different path.
 *
 * A server can carry `"disabled": true` to be kept without being started, and
 * `"allow": ["query"]` to offer some of its tools rather than all of them.
 * That second one is not paranoia about the server: it is about the model.
 * Twenty tool descriptions in a prompt is a large part of a small model's
 * context spent on tools it will not use, and it measurably degrades its
 * choice among the ones it will.
 *
 * ## Started when first needed, not when the server boots
 *
 * Four MCP servers is four Node or Python processes. Starting them because the
 * app was opened would mean paying for them on a machine whose whole purpose
 * is to have VRAM and RAM free for a model. So a server is spawned on the
 * first request that needs its tools, and a crash is not fatal: the next
 * request starts it again. What a dead server costs is its own tools being
 * missing from one turn, reported as such, rather than the turn failing.
 *
 * ## Two transports, one client
 *
 * **stdio** is a child process speaking newline-delimited JSON-RPC on its
 * stdin and stdout. Note *newline-delimited*: the framing with `Content-Length`
 * headers belongs to the Language Server Protocol, which MCP resembles and is
 * not. Its stderr is drained and kept — a server that fails to start says why
 * there and nowhere else, and a pipe nobody reads fills up and blocks the
 * child.
 *
 * **HTTP** is the same JSON-RPC posted to a URL. The reply may come back as
 * JSON or as one SSE event carrying it, at the server's discretion, so both
 * are read. A session id, if the server issues one, comes back in a header and
 * has to be echoed on every later request or the session is silently a new
 * one each time.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/* The revision of the protocol this client implements. A server that speaks a
   different one answers `initialize` saying so, and we keep talking: the parts
   used here -- initialize, tools/list, tools/call -- have been stable across
   every revision, and refusing to work with a server over a date string would
   be a client that breaks every time the spec is published. */
const PROTOCOL_VERSION = '2025-06-18';

const CLIENT_INFO = { name: 'ollama-webui', version: '1.0.0' };

/* How long a single JSON-RPC call may take. Generous, because a tool call is
   allowed to do real work -- a query, a page fetch, a build -- and stingy
   enough that a hung server does not hold the chat open for ever. `initialize`
   gets its own, shorter, limit: a server that cannot say hello in ten seconds
   is not going to answer a query. */
const CALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/* Enough of a tool result to be useful, not enough to flood the context. A
   server returning a whole table has to be trimmed somewhere, and doing it
   here means the trim is reported once rather than discovered as a truncated
   answer. */
const MAX_RESULT_CHARS = 20_000;

/* stderr is kept for the panel to show, because "it did not start" with no
   reason is the most common way this goes wrong and the reason is always
   there. Bounded, or a server that logs every request is a slow memory leak. */
const MAX_STDERR_CHARS = 4_000;

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

/** Read a config file, or explain why there is nothing to read. */
export const readConfig = (env = {}, { cwd = process.cwd() } = {}) => {
  const file = env.MCP_CONFIG
    ? path.resolve(cwd, env.MCP_CONFIG)
    : path.join(cwd, 'mcp.json');

  if (!fs.existsSync(file)) return { file, servers: {}, missing: true };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, servers: {}, error: `${path.basename(file)} is not valid JSON: ${e.message}` };
  }

  /* Both spellings. `mcpServers` is what the ecosystem's files use and what
     somebody will paste in; `servers` is what a person writing one from
     scratch guesses. Accepting both costs a line. */
  const raw = parsed?.mcpServers || parsed?.servers || {};
  const servers = {};
  for (const [name, config] of Object.entries(raw)) {
    if (!config || typeof config !== 'object') continue;
    servers[name] = config;
  }
  return { file, servers };
};

/* One JSON-RPC id space per process, so a reply can never be matched to a
   request from a different connection. */
let nextId = 1;

/**
 * A connection to one server, in whichever transport it asked for.
 *
 * The object is the same either way: `call(method, params)` and `close()`.
 * Everything above this line in the file is about which one gets built;
 * everything below treats them as the same thing.
 */
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
const shellPlan = (config) => {
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

const connectStdio = (name, config, { onLog }) => {
  const plan = shellPlan(config);
  const child = spawn(plan.command, plan.args, {
    /* The server's own environment plus whatever the config adds. Passing only
       what the config names would break every server that reads PATH, HOME or
       a proxy setting, which is nearly all of them. */
    env: { ...process.env, ...(config.env || {}) },
    cwd: config.cwd || process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: plan.shell,
  });

  const pending = new Map();
  let stderr = '';
  let buffer = '';
  let dead = null;

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
      const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); waiting(message); }
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

  const send = (payload) => {
    if (dead) throw new Error(dead);
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    kind: 'stdio',
    get stderr() { return stderr; },
    get dead() { return dead; },
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    call: (method, params, timeoutMs = CALL_TIMEOUT_MS) => new Promise((resolve, reject) => {
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

      try {
        send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    }),
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

const connectHttp = (name, config) => {
  /* Issued by the server on `initialize` and required on every request after
     it. A client that forgets it gets a fresh, empty session each call, which
     works for a stateless server and silently loses state on any other. */
  let session = null;

  const post = async (payload, timeoutMs) => {
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
          ...(config.headers || {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const issued = res.headers.get('mcp-session-id');
      if (issued) session = issued;

      /* A notification is answered with 202 and no body. Reading it as JSON
         would throw on the empty string. */
      if (res.status === 202) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${config.url}`);

      const type = res.headers.get('content-type') || '';
      const text = await res.text();

      if (type.includes('text/event-stream')) {
        /* One JSON-RPC message per `data:` line. Several may arrive; the reply
           to this request is the last one carrying an id, and anything else is
           a notification we did not ask for. */
        let last = null;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const message = JSON.parse(line.slice(5).trim());
            if (message?.id !== undefined) last = message;
          } catch (e) { /* a keep-alive comment, or a partial frame */ }
        }
        return last;
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
    dead: null,
    notify: (method, params) => post({ jsonrpc: '2.0', method, params }, HANDSHAKE_TIMEOUT_MS).catch(() => {}),
    call: async (method, params, timeoutMs = CALL_TIMEOUT_MS) => {
      const message = await post({ jsonrpc: '2.0', id: nextId++, method, params }, timeoutMs);
      if (!message) throw new Error(`${name}: no reply to '${method}'`);
      if (message.error) throw new Error(message.error.message || 'the server returned an error');
      return message.result;
    },
    close: () => {},
  };
};

/**
 * The pool.
 *
 * One live connection per configured server, built on demand and remembered
 * until it dies. `tools` is what `tools/list` said, cached with it: a server
 * may add a tool while running, but asking again before every turn is a round
 * trip per server per message to hear the same answer.
 */
export const createMcpPool = (env = {}, { cwd = process.cwd(), onLog = null } = {}) => {
  const live = new Map();          // name -> { connection, tools }
  const starting = new Map();      // name -> Promise, so two turns at once start one process

  const configFor = (name) => readConfig(env, { cwd }).servers[name] || null;

  const handshake = async (name, config) => {
    const connection = config.url
      ? connectHttp(name, config)
      : connectStdio(name, config, { onLog });

    try {
      await connection.call('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }, HANDSHAKE_TIMEOUT_MS);

      /* Required by the spec and easy to skip, because most servers answer
         `tools/list` without it. The ones that do not simply never reply, and
         the failure looks like a timeout rather than a missing notification. */
      await connection.notify('notifications/initialized');

      const listed = await connection.call('tools/list', {}, HANDSHAKE_TIMEOUT_MS);
      const allow = Array.isArray(config.allow) ? new Set(config.allow) : null;
      const tools = (listed?.tools || [])
        .filter(tool => tool?.name && (!allow || allow.has(tool.name)))
        .map(tool => ({
          name: tool.name,
          qualified: qualifiedName(name, tool.name),
          description: tool.description || `A tool from the ${name} server.`,
          /* The schema is passed to the model verbatim. A server that sends
             none gets an empty object, which is a tool taking no arguments --
             the honest reading, and one the sampler can build a grammar from.
             `undefined` here would be a schema-less function in the request
             and a 400 from Ollama. */
          inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        }));

      return { connection, tools };
    } catch (e) {
      connection.close();
      throw e;
    }
  };

  const connect = async (name) => {
    const existing = live.get(name);
    if (existing && !existing.connection.dead) return existing;
    if (existing) live.delete(name);          // it died; start again

    if (starting.has(name)) return starting.get(name);

    const config = configFor(name);
    if (!config) throw new Error(`No MCP server named '${name}' is configured`);
    if (config.disabled) throw new Error(`The MCP server '${name}' is switched off in the config`);
    if (!config.url && !config.command) {
      throw new Error(`The MCP server '${name}' has neither a 'command' nor a 'url'`);
    }

    const attempt = handshake(name, config)
      .then((entry) => { live.set(name, entry); return entry; })
      .finally(() => starting.delete(name));

    starting.set(name, attempt);
    return attempt;
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
    const { servers, file, missing, error } = readConfig(env, { cwd });
    const names = Object.entries(servers).filter(([, c]) => !c.disabled).map(([n]) => n);

    const tools = [];
    const problems = [];
    if (error) problems.push({ server: null, error });

    const results = await Promise.allSettled(names.map(name => connect(name)));
    results.forEach((result, i) => {
      const name = names[i];
      if (result.status === 'fulfilled') {
        for (const tool of result.value.tools) tools.push({ ...tool, server: name });
      } else {
        problems.push({ server: name, error: result.reason?.message || String(result.reason) });
      }
    });

    return { tools, problems, file, configured: names.length, missing: !!missing };
  };

  /**
   * Run one tool and return its text.
   *
   * MCP results are a list of content parts, which may be text, an image or a
   * reference to a resource. Only text is passed on: the tool result goes into
   * a chat as a string, and a base64 PNG inlined there would be a megabyte of
   * tokens the model reads as gibberish. A non-text part is named instead, so
   * the model knows something came back that it is not being shown.
   */
  const callTool = async (serverName, toolName, args, { timeoutMs = CALL_TIMEOUT_MS } = {}) => {
    const { connection, tools } = await connect(serverName);
    if (!tools.some(tool => tool.name === toolName)) {
      throw new Error(`The '${serverName}' server has no tool called '${toolName}'`);
    }

    const result = await connection.call('tools/call', {
      name: toolName,
      arguments: args && typeof args === 'object' ? args : {},
    }, timeoutMs);

    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .map((part) => {
        if (part?.type === 'text') return part.text;
        if (part?.type === 'resource') return part.resource?.text || `[resource: ${part.resource?.uri || 'unnamed'}]`;
        return `[${part?.type || 'unknown'} content, which this app does not pass to the model]`;
      })
      .filter(Boolean)
      .join('\n');

    const trimmed = text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[... trimmed; the tool returned ${text.length} characters]`
      : text;

    return {
      /* `isError` is the server saying the *tool* failed -- a query with a
         syntax error, a file that is not there. That is a result the model
         should see and act on, not an exception: it is the difference between
         "your SQL was wrong" and "the database is unreachable". */
      isError: !!result?.isError,
      text: trimmed || '(the tool returned nothing)',
    };
  };

  const close = () => {
    for (const [, entry] of live) entry.connection.close();
    live.clear();
  };

  return { listTools, callTool, connect, close };
};

/**
 * `/mcp/tools` and `/mcp/call`.
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

  route('/mcp/tools', async (req, res) => {
    try {
      json(res, { success: true, ...(await pool.listTools()) });
    } catch (e) {
      json(res, { success: false, error: e.message }, 500);
    }
  });

  route('/mcp/call', async (req, res) => {
    try {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
      const { server, tool, args } = body;
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

  /* Processes this app started are processes this app ends. Without it, a dev
     server restarted forty times leaves forty Python servers running. */
  const shutdown = () => pool.close();
  process.once('exit', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return routes;
};
