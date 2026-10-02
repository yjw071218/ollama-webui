// A real MCP server, small enough to read, speaking the real stdio transport.
//
// It exists so scripts/mcp.test.mjs can exercise the framing rather than stub
// past it: newline-delimited JSON on a pipe arrives split, doubled up and
// mixed with whatever the server prints, and none of those cases are reachable
// by mocking the reader. Each of the tools below is one of them.

const TOOLS = [
  { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'split_reply', description: 'Reply in two writes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'burst', description: 'Reply behind other messages in one write.', inputSchema: { type: 'object', properties: {} } },
  { name: 'noisy', description: 'Print rubbish on stdout first.', inputSchema: { type: 'object', properties: {} } },
  { name: 'always_fails', description: 'Report a tool-level failure.', inputSchema: { type: 'object', properties: {} } },
  { name: 'image', description: 'Return a non-text part.', inputSchema: { type: 'object', properties: {} } },
  { name: 'silent', description: 'Return no content at all.', inputSchema: { type: 'object', properties: {} } },
  { name: 'exit_now', description: 'Die without replying.', inputSchema: { type: 'object', properties: {} } },
  // No inputSchema at all: the client has to supply one, or Ollama rejects a
  // function with no parameters block.
  { name: 'no_schema', description: 'A tool whose author forgot the schema.' },
  { name: 'ask_back', description: 'Ask the client something before answering.', inputSchema: { type: 'object', properties: {} } },
  { name: 'grow', description: 'Offer one more tool, and say so.', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'Say what STUB_VAR is.', inputSchema: { type: 'object', properties: {} } },
  { name: 'structured', description: 'Return structured content only.', inputSchema: { type: 'object', properties: {} } },
  { name: 'client_caps', description: 'Say what the client offered on initialize, and where this runs.', inputSchema: { type: 'object', properties: {} } },
];

const RESOURCES = [
  { uri: 'stub://readme', name: 'Read me', mimeType: 'text/plain' },
  { uri: 'stub://notes', name: 'Notes', mimeType: 'text/plain' },
];
const PROMPTS = [
  { name: 'greet', description: 'Say hello to someone.', arguments: [{ name: 'who', required: true }] },
];

// What the client offered on `initialize`.
let clientCapabilities = null;

// Requests this server has made of the client, waiting for their answers.
const asked = new Map();

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const text = (id, body) => reply(id, { content: [{ type: 'text', text: body }] });

const handle = (message) => {
  const { id, method, params } = message;
  // The client answering a request of ours.
  if (!method && asked.has(id)) { asked.get(id)(message); asked.delete(id); return undefined; }
  if (id === undefined) return;                      // a notification

  if (method === 'initialize') {
    clientCapabilities = params?.capabilities || {};
    return reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      serverInfo: { name: 'stub', version: '0.0.0' },
    });
  }

  // In two pages, so the client has to follow the cursor to see every tool.
  if (method === 'tools/list') {
    const half = Math.ceil(TOOLS.length / 2);
    return params?.cursor === 'page2'
      ? reply(id, { tools: TOOLS.slice(half) })
      : reply(id, { tools: TOOLS.slice(0, half), nextCursor: 'page2' });
  }
  if (method === 'resources/list') return reply(id, { resources: RESOURCES });
  if (method === 'resources/templates/list') return reply(id, { resourceTemplates: [{ uriTemplate: 'stub://note/{id}', name: 'A note' }] });
  if (method === 'resources/read') {
    const found = RESOURCES.find(r => r.uri === params?.uri);
    if (!found) return write({ jsonrpc: '2.0', id, error: { code: -32002, message: `no resource ${params?.uri}` } });
    return reply(id, { contents: [{ uri: found.uri, mimeType: 'text/plain', text: `contents of ${found.name}` }] });
  }
  if (method === 'prompts/list') return reply(id, { prompts: PROMPTS });
  if (method === 'prompts/get') {
    return reply(id, {
      description: 'A greeting',
      messages: [{ role: 'user', content: { type: 'text', text: `Please greet ${params?.arguments?.who}.` } }],
    });
  }

  if (method !== 'tools/call') return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } });

  const name = params?.name;
  const args = params?.arguments || {};

  switch (name) {
    case 'echo':
      return text(id, `echo: ${args.text ?? ''}`);

    case 'split_reply': {
      // One message, two writes, with the cut in the middle of a JSON string.
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'reassembled' }] } })}\n`;
      const at = Math.floor(payload.length / 2);
      process.stdout.write(payload.slice(0, at));
      setTimeout(() => process.stdout.write(payload.slice(at)), 20);
      return undefined;
    }

    case 'burst': {
      // Two notifications and the reply, in a single write.
      const notice = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } });
      const answer = JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'after the burst' }] } });
      return process.stdout.write(`${notice}\n${notice}\n${answer}\n`);
    }

    case 'noisy':
      // What a server does when it logs to the wrong stream.
      process.stdout.write('Listening on stdio...\n');
      return text(id, 'survived');

    case 'always_fails':
      return reply(id, { isError: true, content: [{ type: 'text', text: 'this tool fails on purpose' }] });

    case 'image':
      return reply(id, { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });

    case 'silent':
      return reply(id, { content: [] });

    case 'exit_now':
      return process.exit(1);

    case 'ask_back':
      // A request of our own, carrying the same id as the call it is inside:
      // a client that sorts by id alone takes this for its answer.
      asked.set(id, (answer) => text(id, answer.result && !answer.error ? 'the client answered' : 'no answer'));
      return write({ jsonrpc: '2.0', id, method: 'ping' });

    case 'grow':
      if (!TOOLS.some(t => t.name === 'grown')) {
        TOOLS.push({ name: 'grown', description: 'Added later.', inputSchema: { type: 'object', properties: {} } });
      }
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return text(id, 'grew');

    case 'grown':
      return text(id, 'hello from the new tool');

    case 'env':
      return text(id, `STUB_VAR=${process.env.STUB_VAR ?? ''}`);

    case 'client_caps':
      return text(id, JSON.stringify({ capabilities: clientCapabilities, cwd: process.cwd() }));

    case 'structured':
      return reply(id, { content: [], structuredContent: { answer: 42 } });

    default:
      return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `no tool ${name}` } });
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
    try { handle(JSON.parse(line)); } catch (e) { /* not our problem here */ }
  }
});
