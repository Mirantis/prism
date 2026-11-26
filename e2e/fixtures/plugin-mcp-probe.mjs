// The demo plugin's stdio MCP server: one tool that answers a marker, the first
// argument reversed or `PLUGIN_MCP_TOOL_OK`. The scenario's `.mcp.json` holds the
// argument reversed, so the marker it asserts comes from a call to the tool.
//
// Hand-rolled JSON-RPC rather than the MCP SDK: the plugin is copied to a temp
// dir with no `node_modules` above it, so an import would not resolve. A client
// needs three methods.
const marker = process.argv[2] ? [...process.argv[2]].reverse().join('') : 'PLUGIN_MCP_TOOL_OK';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const handle = (message) => {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-probe', version: '1.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'plugin_mcp_probe',
            description: 'Returns a marker that only this server knows.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
  } else if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: marker }] },
    });
  } else if (message.id !== undefined) {
    // A notification has no id and wants no reply.
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
