// Writes openai_stream_sdk.json: the parts @ai-sdk/openai's Responses model streams
// (`doStream` with raw chunks) for a set of server-sent event bodies, captured
// through a fake `fetch`. The Rust port of the stream is tested against it.
//
// Run: node openai_stream_sdk.mjs <node_modules dir>
// The node_modules dir must hold @ai-sdk/openai at the version package-lock.json
// pins (4.0.99), installed as npm lays it out.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = process.argv[2];
if (!nodeModules) throw new Error('usage: node openai_stream_sdk.mjs <node_modules dir>');
const { createOpenAI } = await import(pathToFileURL(join(nodeModules, '@ai-sdk/openai/dist/index.js')).href);

// Responses recorded on a ChatGPT subscription, shared with the ChatGPT provider's tests.
const FIXTURES = join(here, '../../../lib/llm_providers/chatgpt/fixtures');
const recorded = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const sse = (...events) => events.map((event) => `event: ${event.type ?? 'x'}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const created = { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', created_at: 1795441004, model: 'gpt-test', output: [], extra: 1 } };
const inProgress = { type: 'response.in_progress', sequence_number: 1, response: { id: 'resp_1', created_at: 1795441004, model: 'gpt-test' } };
const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 16 };
const completed = (extra = {}) => ({ type: 'response.completed', sequence_number: 90, response: { id: 'resp_1', usage, service_tier: 'default', reasoning: { context: 'all_turns' }, ...extra } });
const message = (id, phase) => ({ type: 'message', id, role: 'assistant', status: 'in_progress', content: [], ...(phase ? { phase } : {}) });
const added = (index, item) => ({ type: 'response.output_item.added', output_index: index, item });
const done = (index, item) => ({ type: 'response.output_item.done', output_index: index, item });
const delta = (itemId, text, extra = {}) => ({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, delta: text, ...extra });
const fn = (id, callId, name, args, status) => ({ type: 'function_call', id, call_id: callId, name, arguments: args, ...(status ? { status } : {}) });

const ADD = {
  type: 'function',
  name: 'add',
  description: 'add two numbers',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
};
const LOAD_TOOLS = {
  type: 'provider',
  name: 'load_tools',
  id: 'openai.tool_search',
  args: { execution: 'client', description: 'Load deferred tools.', parameters: { type: 'object' } },
};
const prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
const noStore = { openai: { store: false } };

const reasoningSummaries = sse(
  created,
  inProgress,
  added(0, { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-start' }),
  { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0, summary_index: 0 },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'First ' },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'thought.' },
  { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', output_index: 0, summary_index: 0 },
  { type: 'response.reasoning_summary_part.added', item_id: 'rs_1', output_index: 0, summary_index: 1 },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 1, delta: 'Second.' },
  { type: 'response.reasoning_summary_part.done', item_id: 'rs_1', output_index: 0, summary_index: 1 },
  done(0, { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-final' }),
  added(1, message('msg_1', 'final_answer')),
  delta('msg_1', 'Done.', { output_index: 1 }),
  done(1, { ...message('msg_1'), status: 'completed' }),
  completed(),
);

/** Each case: an event-stream body (or a recorded fixture) and the call options. */
const cases = [
  { name: 'recorded tool call', fixture: 'tool-call-stream.sse', options: { tools: [ADD], providerOptions: noStore } },
  { name: 'recorded reasoning and tool call', fixture: 'reasoning-tool-call-stream.sse', options: { tools: [ADD], providerOptions: noStore } },
  { name: 'recorded answer', fixture: 'reasoning-answer-stream.sse', options: { tools: [ADD], providerOptions: noStore } },
  { name: 'reasoning summaries without store', body: reasoningSummaries, options: { providerOptions: noStore } },
  { name: 'reasoning summaries with store', body: reasoningSummaries, options: { providerOptions: { openai: { store: true } } } },
  {
    name: 'annotations, logprobs and incomplete',
    body: sse(
      created,
      added(0, message('msg_1', 'commentary')),
      delta('msg_1', 'See ', { logprobs: [{ token: 'See', logprob: -0.1, top_logprobs: [{ token: 'See', logprob: -0.1, extra: 1 }], bytes: [1] }] }),
      { type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, annotation: { type: 'url_citation', start_index: 0, end_index: 3, url: 'https://example.com', title: 'Example', extra: 1 } },
      { type: 'response.output_text.annotation.added', item_id: 'msg_1', output_index: 0, annotation: { type: 'file_path', file_id: 'file_1', index: 2 } },
      delta('msg_1', 'this.', { logprobs: null }),
      done(0, { ...message('msg_1'), status: 'incomplete' }),
      { type: 'response.incomplete', sequence_number: 9, response: { id: 'resp_1', incomplete_details: { reason: 'max_output_tokens' }, usage } },
    ),
    options: { providerOptions: { openai: { logprobs: true } } },
  },
  {
    name: 'parallel wrapper',
    body: sse(
      created,
      added(0, fn('fc_1', 'call_1', 'parallel', '')),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"tool_uses":[' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"recipient_name":"functions.add","parameters":{"a":1,"b":2}}]}' },
      done(0, fn('fc_1', 'call_1', 'parallel', '{"tool_uses":[{"recipient_name":"functions.add","parameters":{"a":1,"b":2}}]}', 'completed')),
      added(1, { ...fn('fc_2', 'call_2', 'add', ''), namespace: 'math' }),
      { type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 1, delta: '{}' },
      done(1, { ...fn('fc_2', 'call_2', 'add', '{}', 'completed'), namespace: 'math', async: true, caller: { type: 'program', caller_id: 'prog_1' } }),
      completed(),
    ),
    options: { tools: [ADD] },
  },
  {
    name: 'client tool search',
    body: sse(
      created,
      added(0, { type: 'tool_search_call', id: 'ts_1', execution: 'client', call_id: 'call_ts', status: 'in_progress', arguments: null }),
      done(0, { type: 'tool_search_call', id: 'ts_1', execution: 'client', call_id: 'call_ts', status: 'completed', arguments: { names: ['add'] } }),
      added(1, { type: 'tool_search_call', id: 'ts_2', execution: 'client', call_id: null, status: 'in_progress', arguments: null }),
      done(1, { type: 'tool_search_call', id: 'ts_2', execution: 'client', call_id: null, status: 'completed', arguments: { query: 'math' } }),
      done(4, { type: 'tool_search_call', id: 'ts_3', execution: 'client', call_id: 'call_ts3', status: 'completed', arguments: null }),
      done(2, { type: 'tool_search_output', id: 'tso_1', execution: 'client', call_id: null, status: 'completed', tools: [{ type: 'function', name: 'add' }] }),
      done(3, { type: 'compaction', id: 'cmp_1', encrypted_content: 'enc-compaction' }),
      completed(),
    ),
    options: { tools: [ADD, LOAD_TOOLS] },
  },
  {
    name: 'error after output',
    body: sse(created, added(0, message('msg_1')), delta('msg_1', 'partial'), { type: 'error', sequence_number: 5, code: 'server_error', message: 'The server had an error.', param: null }),
    options: {},
  },
  {
    name: 'nested error after output',
    body: sse(created, added(0, message('msg_1')), delta('msg_1', 'partial'), { type: 'error', sequence_number: 5, error: { type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Too long.', param: null } }),
    options: {},
  },
  {
    name: 'failed after output',
    body: sse(
      created,
      added(0, message('msg_1')),
      delta('msg_1', 'partial'),
      { type: 'response.failed', sequence_number: 6, response: { error: { code: 'rate_limit_exceeded', message: 'Slow down.' }, usage, service_tier: 'flex' } },
    ),
    options: {},
  },
  {
    name: 'error before output',
    body: sse(created, inProgress, { type: 'error', sequence_number: 2, code: 'insufficient_quota', message: 'No quota.', param: null }),
    options: {},
  },
  {
    name: 'failed before output',
    body: sse(created, { type: 'response.failed', sequence_number: 1, response: { error: { code: '503', message: 'Unavailable.' } } }),
    options: {},
  },
  { name: 'truncated', body: sse(created, added(0, message('msg_1')), delta('msg_1', 'partial')), options: {} },
  {
    name: 'malformed and unknown chunks',
    body:
      sse(created, added(0, message('msg_1')), delta('msg_1', 'a'), { type: 'response.content_part.added', item_id: 'msg_1' }, { type: 'response.output_text.delta', item_id: 'msg_1' }) +
      'data: {not json\n\n' +
      'data: [DONE]\n\n' +
      sse({ type: 'response.output_item.added', output_index: 1, item: { type: 'unknown_item', id: 'x' } }, completed()),
    options: {},
  },
  {
    name: 'chat completions chunk',
    body: `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ delta: { content: 'hi' } }] })}\n\n`,
    options: {},
  },
];

function serializeError(error) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    ...(error.statusCode !== undefined && { statusCode: error.statusCode }),
    ...(error.isRetryable !== undefined && { isRetryable: error.isRetryable }),
    ...(error.url !== undefined && { url: error.url }),
    ...(error.responseBody !== undefined && { responseBody: error.responseBody }),
    ...(error.data !== undefined && { data: error.data }),
  };
}

// The JSON of the nth event's data, the nth raw part's source.
function rawValueOf(body, parts) {
  const index = parts.filter((part) => part.type === 'raw').length;
  const data = body
    .split('\n\n')
    .map((event) => event.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data) => data != null && data !== '[DONE]')[index];
  try {
    return JSON.stringify(JSON.parse(data));
  } catch {
    return undefined;
  }
}

const out = [];
for (const testCase of cases) {
  const body = testCase.fixture ? recorded(testCase.fixture) : testCase.body;
  let sent;
  const fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' } });
  };
  const model = createOpenAI({ apiKey: 'sk-test', baseURL: 'https://api.example.com/v1', fetch })('gpt-6.2-sol');
  const entry = { name: testCase.name, ...(testCase.fixture ? { fixture: testCase.fixture } : { body }), options: testCase.options };
  try {
    const result = await model.doStream({ prompt, includeRawChunks: true, ...testCase.options });
    const parts = [];
    for await (const part of result.stream) {
      // A raw part holds the event's data as parsed JSON, which the body already has.
      if (part.type === 'raw') parts.push({ type: 'raw', isEventData: rawValueOf(body, parts) === JSON.stringify(part.rawValue) });
      else parts.push(part.type === 'error' ? { ...part, error: serializeError(part.error) } : part);
    }
    Object.assign(entry, { parts, request: result.request, responseHeaders: result.response.headers });
  } catch (error) {
    entry.thrown = serializeError(error);
  }
  entry.sent = sent;
  out.push(JSON.parse(JSON.stringify(entry)));
}

writeFileSync(join(here, 'openai_stream_sdk.json'), `${JSON.stringify(out, null, 2)}\n`);
