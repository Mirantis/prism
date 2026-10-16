import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
if (process.env.FIXTURE_PID_FILE) appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`);
const args = process.argv.slice(3);
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
if (args[0] === 'auth') {
  if (scenario === 'logged-out') { send({ loggedIn: false, authMethod: 'none' }); process.exit(0); }
  if (scenario === 'auth-crash') process.exit(5);
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_BEDROCK) process.exit(3);
  send({ loggedIn: true, authMethod: ['api_key', 'oauth_token', 'third_party'].includes(scenario) ? scenario : 'claude.ai', subscriptionType: scenario === 'unsubscribed' ? null : 'max' });
  process.exit(0);
}
if (scenario === 'exit') process.exit(7);
if (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--strict-mcp-config')) process.exit(2);
const control = (id, method, params = {}) => send({ type: 'control_request', request_id: id, request: {
  subtype: 'mcp_message', server_name: 'prism', message: { jsonrpc: '2.0', id, method, params },
} });
const text = (delta) => send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } });
// Recorded from Claude Code 2.1.301: a call opens with its input usage and closes with its output.
const callStart = (input) => send({ type: 'stream_event', event: { type: 'message_start', message: {
  usage: { input_tokens: input, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 1 } } } });
const callEnd = (output) => send({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: output } } });
// The result frame totals the whole turn; the provider must not report it as one step's usage.
const finish = () => send({ type: 'result', subtype: 'success', is_error: false, structured_output: scenario === 'json' ? { verdict: 'ok' } : undefined,
  usage: { input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
  }
  if (frame.type === 'user') {
    if (scenario === 'hang') continue;
    if (scenario === 'failed') { send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Subscription limit reached'] }); continue; }
    if (scenario === 'tool' || scenario === 'tool-error' || scenario === 'tool-added') { control('init', 'initialize', { protocolVersion: '2025-03-26' }); continue; }
    callStart(12); text('Hello '); text('from Claude'); callEnd(4); finish();
  }
  const response = frame.response?.response?.mcp_response;
  if (response?.id === 'init') {
    if (!response.result.capabilities.tools) process.exit(4);
    control('list', 'tools/list');
  }
  if (response?.id === 'list') {
    if (!response.result.tools.some((tool) => tool.name === 'echo')) process.exit(5);
    callStart(30); control('call', 'tools/call', { name: 'echo', arguments: { value: 'test' } }); callEnd(5);
  }
  if (response?.id === 'call') {
    if (scenario === 'tool-error' ? !response.result.isError : response.result.content[0].text !== 'result:test') process.exit(6);
    const texts = response.result.content.map((item) => item.text ?? '');
    if (scenario === 'tool-added' && !(texts.some((t) => t.includes('MARKER')) && texts.some((t) => t.includes('report.pdf')))) process.exit(8);
    callStart(40); text('Tool result received'); callEnd(4); finish();
  }
}
