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

const { createMcpPool, readConfig, qualifiedName } = await import(pathToFileURL(OUT).href);

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
check('an image is named rather than inlined', /image content/.test(nonText.text),
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

fs.rmSync(workdir, { recursive: true, force: true });

// Let the killed children's handles finish closing before the process goes.
// `process.exit` while libuv is mid-teardown of a pipe aborts on Windows with
// an assertion, after every check has already passed -- a green run that exits
// 127, which is the worst of both.
await new Promise(resolve => setTimeout(resolve, 150));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
