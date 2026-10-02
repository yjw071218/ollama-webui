// The MCP client, against a real child process speaking the real protocol.
//
// Not a mock: the stdio transport is the part with the framing bug waiting in
// it -- a message split across two chunks, two messages in one chunk, a server
// that prints a banner on stdout -- and none of those are reachable by stubbing
// the thing that reads them. `scripts/fixtures/mcp-stub-server.mjs` is a real
// server, spawned the way a real one would be.
import { rolldown } from 'rolldown';
import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.mcp-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../server/mcp.js'),
  platform: 'node',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const {
  createMcpPool, readConfig, qualifiedName, expandVars, parseToml, normalizeServer, renderContent,
} = await import(pathToFileURL(OUT).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const STUB = path.resolve(HERE, 'fixtures/mcp-stub-server.mjs');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
const writeConfig = (config) =>
  fs.writeFileSync(path.join(workdir, 'mcp.json'), JSON.stringify(config, null, 2));

// ------------------------------------------------------------------- naming
//
// The prefix is what stops a server's tool colliding with a built-in one. A
// server called `git` offering `read_file` must not be able to become the
// `read_file` that reads this machine's disk.
check('a tool name is prefixed by its server', qualifiedName('git', 'log') === 'mcp_git_log');
check('and cannot collide with a built-in', qualifiedName('x', 'read_file') !== 'read_file');
check('characters a grammar cannot carry are replaced',
  qualifiedName('my-server', 'tool/v2') === 'mcp_my_server_tool_v2');

// -------------------------------------------------------------------- config
check('no file is not an error', readConfig({}, { cwd: workdir }).missing === true);
check('and yields no servers', Object.keys(readConfig({}, { cwd: workdir }).servers).length === 0);

fs.writeFileSync(path.join(workdir, 'mcp.json'), '{ not json');
const broken = readConfig({}, { cwd: workdir });
check('invalid JSON is reported rather than thrown', /not valid JSON/.test(broken.error || ''));

writeConfig({ servers: { a: { command: 'x' } } });
check("the plainer spelling 'servers' is accepted too",
  Object.keys(readConfig({}, { cwd: workdir }).servers).join() === 'a');

// ---------------------------------------------------------------- variables
check('a variable is read from the environment', expandVars('Bearer ${TOKEN}', { TOKEN: 'abc' }) === 'Bearer abc');
check('a fallback is used when it is unset', expandVars('${NOPE:-dflt}', {}) === 'dflt');
check('an unset one with no fallback is empty', expandVars('[${NOPE}]', {}) === '[]');
check('every string of a config is expanded',
  JSON.stringify(expandVars({ args: ['${A}'], env: { K: '${A}' } }, { A: '1' })) === '{"args":["1"],"env":{"K":"1"}}');

// --------------------------------------------------------------------- TOML
{
  const toml = parseToml([
    'model = "gpt" # a comment',
    '[mcp_servers.fs]',
    'command = "npx"',
    'args = [',
    '  "-y",   # the package',
    "  '@modelcontextprotocol/server-filesystem',",
    ']',
    'env = { ROOT = "C:\\\\data", "QUOTED KEY" = \'x\' }',
    'enabled_tools = ["read_file"]',
    'tool_timeout_sec = 30',
    '',
    '[mcp_servers."web-api"]',
    'url = "http://127.0.0.1:8080/mcp"',
    'bearer_token_env_var = "WEB_TOKEN"',
    'enabled = false',
    '',
    '[[profiles.list]]',
    'name = "ignored"',
  ].join('\n'));
  check('TOML: a top-level key', toml.model === 'gpt');
  check('TOML: an array over several lines, with comments',
    JSON.stringify(toml.mcp_servers?.fs?.args) === '["-y","@modelcontextprotocol/server-filesystem"]',
    JSON.stringify(toml.mcp_servers?.fs));
  check('TOML: an inline table with escapes and quoted keys',
    toml.mcp_servers?.fs?.env?.ROOT === 'C:\\data' && toml.mcp_servers.fs.env['QUOTED KEY'] === 'x',
    JSON.stringify(toml.mcp_servers?.fs?.env));
  check('TOML: a quoted table name', toml.mcp_servers?.['web-api']?.url === 'http://127.0.0.1:8080/mcp');
  check('TOML: numbers and booleans',
    toml.mcp_servers?.fs?.tool_timeout_sec === 30 && toml.mcp_servers['web-api'].enabled === false);

  const fsServer = normalizeServer(toml.mcp_servers.fs);
  check("Codex's spelling: enabled_tools is an allow-list", fsServer.allow?.join() === 'read_file');
  check('and tool_timeout_sec a timeout', fsServer.timeout === 30000);
  const web = normalizeServer(toml.mcp_servers['web-api'], { WEB_TOKEN: 't0k' });
  check('a bearer token is read from the named variable', web.headers.Authorization === 'Bearer t0k');
  check('enabled = false is disabled', web.disabled === true);
  check('a URL is HTTP', web.transport === 'http');
}
check('a URL ending in /sse is the SSE transport', normalizeServer({ url: 'http://x/sse' }).transport === 'sse');
check("type: 'sse' says so outright", normalizeServer({ type: 'sse', url: 'http://x/events' }).transport === 'sse');
check("Antigravity's serverUrl is a URL", normalizeServer({ serverUrl: 'http://x/mcp' }).url === 'http://x/mcp');
check('a command is stdio', normalizeServer({ command: 'npx' }).transport === 'stdio');
check('a structured result with no text is shown as JSON',
  renderContent({ content: [], structuredContent: { a: 1 } }).text.includes('"a": 1'));
check('a resource link is named',
  renderContent({ content: [{ type: 'resource_link', uri: 'file:///d', name: 'Doc' }] }).text === '[resource: Doc <file:///d>]');

// ------------------------------------------------------------------- imports
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'));
  const project = path.join(workdir, 'proj');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { cc: { type: 'stdio', command: 'cc-server' }, shared: { command: 'from-claude' } },
    projects: { [project]: { mcpServers: { here: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } } },
  }));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.cx]\ncommand = "codex-server"\n');
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'antigravity', 'mcp_config.json'), '');
  fs.writeFileSync(path.join(project, 'mcp.json'), JSON.stringify({
    mcpServers: { shared: { command: 'from-mcp-json' } },
    import: ['claude', 'codex', 'agy', 'nonsense'],
  }));

  const imported = readConfig({}, { cwd: project, home });
  check('Claude Code user servers are imported', imported.servers.cc?.command === 'cc-server',
    JSON.stringify(Object.keys(imported.servers)));
  check("and this project's own", imported.servers.here?.transport === 'http');
  check('Codex servers are imported', imported.servers.cx?.command === 'codex-server');
  check('mcp.json wins over an import of the same name', imported.servers.shared?.command === 'from-mcp-json');
  check('each server says where it came from',
    imported.servers.cc.source === 'claude-code' && imported.servers.shared.source === 'mcp.json');
  check('an empty Antigravity file is no servers, not an error',
    imported.imports.find(i => i.source === 'antigravity')?.count === 0, JSON.stringify(imported.imports));
  check('an unknown import is reported', imported.imports.some(i => i.source === 'nonsense' && i.error));

  const onlyEnv = readConfig({ MCP_IMPORT: 'codex' }, { cwd: path.join(workdir, 'nowhere'), home });
  check('MCP_IMPORT works with no mcp.json at all', !!onlyEnv.servers.cx && !onlyEnv.missing);
  fs.rmSync(home, { recursive: true, force: true });
}

// --------------------------------------------------------------------- stdio
writeConfig({
  mcpServers: {
    stub: { command: process.execPath, args: [STUB] },
    off: { command: process.execPath, args: [STUB], disabled: true },
    broken: { command: path.join(workdir, 'there-is-no-such-program') },
    limited: { command: process.execPath, args: [STUB], allow: ['echo'] },
  },
});

const pool = createMcpPool({}, { cwd: workdir });
const listed = await pool.listTools();

check('the stub server\'s tools come back',
  listed.tools.some(tool => tool.server === 'stub' && tool.name === 'echo'),
  JSON.stringify(listed.tools.map(tool => `${tool.server}/${tool.name}`)));
check('every tool carries its qualified name',
  listed.tools.every(tool => tool.qualified.startsWith('mcp_')));
check('a tool with no schema still gets one',
  listed.tools.find(tool => tool.name === 'no_schema')?.inputSchema?.type === 'object');

check('a disabled server is not started',
  !listed.tools.some(tool => tool.server === 'off'));
check('and is not reported as a problem either',
  !listed.problems.some(problem => problem.server === 'off'));

// The point of settling each server separately: one that will not start must
// not cost the others their tools.
check('a server that cannot start is a problem, not an exception',
  listed.problems.some(problem => problem.server === 'broken'),
  JSON.stringify(listed.problems));
check('and the working servers still answered',
  listed.tools.some(tool => tool.server === 'stub'));

check('an allow-list narrows a server to some of its tools',
  listed.tools.filter(tool => tool.server === 'limited').map(tool => tool.name).join() === 'echo',
  JSON.stringify(listed.tools.filter(tool => tool.server === 'limited').map(tool => tool.name)));

// ----------------------------------------------------------------- calling
const echoed = await pool.callTool('stub', 'echo', { text: 'hello' });
check('a tool call returns its text', echoed.text === 'echo: hello', JSON.stringify(echoed));
check('and is not marked an error', echoed.isError === false);

// The framing cases. `split` replies in two writes with the message cut in
// half; `burst` replies with several messages in one write. Both are ordinary
// on a pipe and both break a reader that assumes one chunk is one message.
const split = await pool.callTool('stub', 'split_reply', {});
check('a reply split across two writes is read', split.text === 'reassembled', JSON.stringify(split));

const burst = await pool.callTool('stub', 'burst', {});
check('a reply preceded by other messages in one write is read',
  burst.text === 'after the burst', JSON.stringify(burst));

// A server that prints to stdout has broken its own transport. Surviving it
// matters because a great many of them do it.
const noisy = await pool.callTool('stub', 'noisy', {});
check('a non-JSON line on stdout does not derail the connection',
  noisy.text === 'survived', JSON.stringify(noisy));

// `isError` is the tool failing, which the model should see and act on. It is
// not the same as the server being unreachable.
const failed = await pool.callTool('stub', 'always_fails', {});
check('a tool reporting failure is a result, not a throw', failed.isError === true);
check('and its text explains what went wrong', /on purpose/.test(failed.text));

const nonText = await pool.callTool('stub', 'image', {});
check('an image is named rather than inlined, and kept aside', nonText.text.startsWith('[image 1: image/png') && nonText.images?.[0]?.data === 'AAAA',
  JSON.stringify(nonText));

const empty = await pool.callTool('stub', 'silent', {});
check('a tool returning nothing says so', /returned nothing/.test(empty.text));

let refused = null;
try { await pool.callTool('stub', 'not_a_tool', {}); } catch (e) { refused = e; }
check('a tool the server never offered is refused',
  /no tool called/.test(refused?.message || ''), refused?.message);

let unknown = null;
try { await pool.callTool('nowhere', 'x', {}); } catch (e) { unknown = e; }
check('an unconfigured server is refused', /No MCP server named/.test(unknown?.message || ''));

let disabled = null;
try { await pool.callTool('off', 'echo', {}); } catch (e) { disabled = e; }
check('a disabled server is refused by name', /switched off/.test(disabled?.message || ''));

// The connection is reused rather than remade: spawning a Python server per
// tool call is the difference between a tool that is usable and one that is not.
const before = Date.now();
await pool.callTool('stub', 'echo', { text: 'again' });
check('a second call reuses the live connection', Date.now() - before < 1000);

// A server that dies is started again on the next request rather than being
// dead for the session.
await pool.callTool('stub', 'exit_now', {}).catch(() => {});
await new Promise(resolve => setTimeout(resolve, 200));
const revived = await pool.callTool('stub', 'echo', { text: 'back' });
check('a crashed server is restarted by the next call', revived.text === 'echo: back',
  JSON.stringify(revived));

// ------------------------------------------------ beyond a plain tool call

// Paging: the stub lists its tools in two pages. A client that ignores
// `nextCursor` sees half a server.
check('a paged tool list is followed to the end',
  listed.tools.some(tool => tool.server === 'stub' && tool.name === 'structured'),
  JSON.stringify(listed.tools.filter(t => t.server === 'stub').map(t => t.name)));

// A server's own request, carrying the same id as the call it is inside.
const askedBack = await pool.callTool('stub', 'ask_back', {});
check('a request from the server is answered, not taken for a reply',
  askedBack.text === 'the client answered', JSON.stringify(askedBack));

const caps = JSON.parse((await pool.callTool('stub', 'client_caps', {})).text);
check('this client offers no roots, so a server keeps the directories mcp.json gave it',
  caps.capabilities && !('roots' in caps.capabilities), JSON.stringify(caps));

const structured = await pool.callTool('stub', 'structured', {});
check('structured content is shown when there is nothing else', structured.text.includes('"answer": 42'), structured.text);

// Resources reach the model as one more tool.
const reader = listed.tools.find(tool => tool.server === 'stub' && tool.name === 'read_resource');
check('a server with resources offers read_resource', !!reader);
check('which names what there is to read', (reader?.description || '').includes('stub://readme'), reader?.description);
check('and its URI templates', (reader?.description || '').includes('stub://note/{id}'));
const readme = await pool.callTool('stub', 'read_resource', { uri: 'stub://readme' });
check('a resource is read by URI', readme.text === 'contents of Read me', JSON.stringify(readme));
let missingResource = null;
try { await pool.callTool('stub', 'read_resource', { uri: 'stub://nothing' }); } catch (e) { missingResource = e; }
check('a resource that is not there is an error', /no resource/.test(missingResource?.message || ''));

// Prompts are for the reader, filled in on request.
const stubStatus = listed.servers.find(server => server.name === 'stub');
check('the server list reports it running', stubStatus?.state === 'running', JSON.stringify(stubStatus));
check('with its prompts and their arguments',
  stubStatus?.prompts?.[0]?.name === 'greet' && stubStatus.prompts[0].arguments[0].required === true);
check('and its resource count', stubStatus?.resources === 2);
check('a disabled server is listed as such', listed.servers.find(s => s.name === 'off')?.state === 'disabled');
check('a broken one as failed, with why', listed.servers.find(s => s.name === 'broken')?.state === 'failed');
const prompt = await pool.getPrompt('stub', 'greet', { who: 'Minsu' });
check('a prompt comes back filled in', prompt.text === 'Please greet Minsu.', JSON.stringify(prompt));

// A server that adds a tool says so, and the next list has it.
await pool.callTool('stub', 'grow', {});
await new Promise(resolve => setTimeout(resolve, 50));
const regrown = await pool.listTools();
check('a tool added later is offered after list_changed',
  regrown.tools.some(tool => tool.server === 'stub' && tool.name === 'grown'));
const grown = await pool.callTool('stub', 'grown', {});
check('and can be called', grown.text === 'hello from the new tool');

// A changed config entry restarts that server with the new one.
writeConfig({
  mcpServers: {
    stub: { command: process.execPath, args: [STUB], env: { STUB_VAR: '${STUB_TEST_VALUE:-fallback}' } },
    limited: { command: process.execPath, args: [STUB], deny: ['echo', 'read_resource'] },
  },
});
const renewed = await pool.callTool('stub', 'env', {});
check('a changed entry is picked up without a restart', renewed.text === 'STUB_VAR=fallback', renewed.text);
const denied = (await pool.listTools()).tools.filter(tool => tool.server === 'limited').map(tool => tool.name);
check('a deny-list takes tools away',
  !denied.includes('echo') && denied.includes('burst') && !denied.includes('read_resource'), JSON.stringify(denied));
check('a server taken out of the config is gone from the list',
  !(await pool.listTools()).servers.some(server => server.name === 'broken'));

pool.close();

// ---------------------------------------------------------------------- HTTP
//
// The second transport. Its own failure is the session header: a server that
// issues one and a client that drops it means every call starts a new session,
// which works until the server keeps state and then silently does not.
let sawSession = null;
let requests = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    requests++;
    const message = JSON.parse(body || '{}');
    if (message.id === undefined) { res.statusCode = 202; return res.end(); }
    if (message.method !== 'initialize') sawSession = req.headers['mcp-session-id'] || null;

    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-stub' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'pong' }] };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Mcp-Session-Id', 'session-123');
    // Deliberately as SSE rather than JSON: a server may answer either way per
    // request, and a client that reads only one of them gets nothing here.
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;

writeConfig({ mcpServers: { web: { url } } });
const httpPool = createMcpPool({}, { cwd: workdir });
const httpTools = await httpPool.listTools();
check('an HTTP server\'s tools come back',
  httpTools.tools.map(tool => tool.qualified).join() === 'mcp_web_ping',
  JSON.stringify(httpTools));

const pong = await httpPool.callTool('web', 'ping', {});
check('an SSE-framed reply is read', pong.text === 'pong', JSON.stringify(pong));
check('the session id the server issued is echoed back', sawSession === 'session-123', String(sawSession));
check('the handshake was not repeated for the call', requests > 2);

httpPool.close();
await new Promise(resolve => server.close(resolve));

// ------------------------------------------------ a forgotten HTTP session
//
// A server restarted between two calls answers the old session id with 404.
// The client starts a new session and asks again, rather than failing a turn
// on something the reader cannot see.
{
  let sessions = 0;
  let current = null;
  const forgetful = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'DELETE') { res.statusCode = 200; return res.end(); }
      const message = JSON.parse(body || '{}');
      if (message.id === undefined) { res.statusCode = 202; return res.end(); }
      if (message.method === 'initialize') {
        current = `s${++sessions}`;
        res.setHeader('Mcp-Session-Id', current);
      } else if (req.headers['mcp-session-id'] !== current) {
        res.statusCode = 404; return res.end();
      }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'forgetful' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'hi', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: `hi from ${current}` }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(resolve => forgetful.listen(0, '127.0.0.1', resolve));
  writeConfig({ mcpServers: { forgetful: { url: `http://127.0.0.1:${forgetful.address().port}/mcp` } } });
  const p = createMcpPool({}, { cwd: workdir });
  const first = await p.callTool('forgetful', 'hi', {});
  current = 'restarted';                       // the server forgets every session
  const second = await p.callTool('forgetful', 'hi', {});
  check('a first call on an HTTP session', first.text === 'hi from s1', first.text);
  check('a forgotten session is started again and the call retried', second.text === 'hi from s2', second.text);
  p.close();
  await new Promise(resolve => forgetful.close(resolve));
}

// ------------------------------------------------------------- legacy SSE
//
// The transport HTTP replaced: a long GET that first says where to POST, and
// carries every reply after that.
{
  let stream = null;
  const sse = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: endpoint\ndata: /messages?session=abc\n\n');
      stream = res;
      return undefined;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.statusCode = 202; res.end();
      const message = JSON.parse(body || '{}');
      if (message.id === undefined || !req.url.includes('session=abc')) return;
      const result = message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'old' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'legacy', description: 'An old server', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'from the stream' }] };
      // Split across two writes, as a real stream may be.
      const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`;
      stream.write(frame.slice(0, 20));
      setTimeout(() => stream.write(frame.slice(20)), 10);
    });
  });
  await new Promise(resolve => sse.listen(0, '127.0.0.1', resolve));
  writeConfig({ mcpServers: { old: { url: `http://127.0.0.1:${sse.address().port}/sse` } } });
  const p = createMcpPool({}, { cwd: workdir });
  const oldTools = await p.listTools();
  check("an SSE server's tools come back", oldTools.tools.map(t => t.name).join() === 'legacy', JSON.stringify(oldTools));
  check('reported as the SSE transport', oldTools.servers[0]?.transport === 'sse');
  const legacy = await p.callTool('old', 'legacy', {});
  check('a reply read off the event stream', legacy.text === 'from the stream', JSON.stringify(legacy));
  p.close();
  stream?.end();
  sse.closeAllConnections?.();
  await new Promise(resolve => sse.close(resolve));
}

// ---------------------------------------------------------- credentials
{
  const locked = http.createServer((req, res) => { req.resume(); res.statusCode = 401; res.end(); });
  await new Promise(resolve => locked.listen(0, '127.0.0.1', resolve));
  writeConfig({ mcpServers: { locked: { url: `http://127.0.0.1:${locked.address().port}/mcp` } } });
  const p = createMcpPool({}, { cwd: workdir });
  const result = await p.listTools();
  check('a 401 says to add a token', /wants credentials/.test(result.problems[0]?.error || ''), JSON.stringify(result.problems));
  p.close();
  await new Promise(resolve => locked.close(resolve));
}

fs.rmSync(workdir, { recursive: true, force: true });

// Let the killed children's handles finish closing before the process goes.
// `process.exit` while libuv is mid-teardown of a pipe aborts on Windows with
// an assertion, after every check has already passed -- a green run that exits
// 127, which is the worst of both.
await new Promise(resolve => setTimeout(resolve, 150));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
