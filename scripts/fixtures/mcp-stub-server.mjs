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
];

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const text = (id, body) => reply(id, { content: [{ type: 'text', text: body }] });

const handle = (message) => {
  const { id, method, params } = message;
  if (id === undefined) return;                      // a notification

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'stub', version: '0.0.0' },
    });
  }

  if (method === 'tools/list') return reply(id, { tools: TOOLS });

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
