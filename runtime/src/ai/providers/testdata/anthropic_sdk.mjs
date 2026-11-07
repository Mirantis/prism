// Writes anthropic_sdk.json: what @ai-sdk/anthropic sends and returns for a set of
// language model V4 call options, captured through a fake `fetch`. The Rust port
// of the provider is tested against this file.
//
// Run: node anthropic_sdk.mjs <node_modules dir>
// The node_modules dir must hold @ai-sdk/anthropic (the version the runtime pins).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = process.argv[2];
if (!nodeModules) throw new Error('usage: node anthropic_sdk.mjs <node_modules dir>');
const { createAnthropic } = await import(
  pathToFileURL(join(nodeModules, '@ai-sdk/anthropic/dist/index.js')).href
);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = 'JVBERi0xLjQK';
const TEXT = 'aGVsbG8gd29ybGQ=';
const UA = { 'user-agent': 'ai/7.0.137' };
const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const CACHE_1H = { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } };

const tool = (name, extra = {}) => ({
  type: 'function',
  name,
  description: `The ${name} tool.`,
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'A path.' } },
    required: ['path'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  ...extra,
});

const OK_RESPONSE = {
  type: 'message',
  id: 'msg_ok',
  model: 'claude-test',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** Each request case: the model, the provider settings and the call options. */
const requestCases = [
  {
    name: 'chat turn with cached system, tools and history',
    modelId: 'claude-opus-5-5',
    options: {
      maxOutputTokens: 16000,
      headers: UA,
      toolChoice: { type: 'auto' },
      tools: [
        tool('read_file'),
        tool('remote__search', { providerOptions: { anthropic: { deferLoading: true } } }),
        tool('write_file', { providerOptions: CACHE }),
      ],
      prompt: [
        { role: 'system', content: 'You are a helpful agent.', providerOptions: CACHE },
        { role: 'system', content: '# Dynamic\nToday is Monday.' },
        { role: 'user', content: [{ type: 'text', text: 'Read /etc/hosts' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading it now.' },
            { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'read_file', input: { path: '/etc/hosts' } },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'toolu_1',
              toolName: 'read_file',
              output: { type: 'text', value: '127.0.0.1 localhost' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Thanks. Now summarize.' }],
          providerOptions: CACHE,
        },
      ],
    },
  },
  {
    name: 'classification gate with thinking off and a temperature',
    modelId: 'claude-haiku-5-5',
    options: {
      maxOutputTokens: 16,
      temperature: 0,
      headers: UA,
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
      prompt: [
        { role: 'system', content: 'Answer yes or no.' },
        { role: 'user', content: [{ type: 'text', text: 'Is the sky blue?' }] },
      ],
    },
  },
  {
    name: 'temperature on a model that takes it',
    modelId: 'claude-haiku-4-5',
    options: {
      maxOutputTokens: 5,
      temperature: 0,
      topP: 0.5,
      stopSequences: ['\n'],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'native structured output',
    modelId: 'claude-opus-5-5',
    options: {
      maxOutputTokens: 1000,
      responseFormat: {
        type: 'json',
        schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['respond', 'ignore'], description: 'The verdict.' },
            reason: { type: 'string', minLength: 1, maxLength: 200 },
            email: { type: 'string', format: 'email' },
            code: { type: 'string', format: 'idn-email' },
            count: { type: 'integer', minimum: 0, exclusiveMaximum: 10 },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
            nested: {
              oneOf: [{ type: 'string' }, { type: 'object', properties: { a: { type: 'number' } } }],
            },
          },
          required: ['verdict', 'reason'],
          additionalProperties: false,
        },
      },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Classify.' }] }],
    },
  },
  {
    name: 'json tool structured output',
    modelId: 'claude-haiku-5-5',
    options: {
      maxOutputTokens: 100,
      providerOptions: {
        anthropic: { structuredOutputMode: 'jsonTool', thinking: { type: 'disabled' } },
      },
      responseFormat: {
        type: 'json',
        schema: {
          type: 'object',
          properties: { verdict: { type: 'string' } },
          required: ['verdict'],
          additionalProperties: false,
        },
      },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Classify.' }] }],
    },
  },
  {
    name: 'json tool on a model that rejects forced tool use',
    modelId: 'claude-opus-5-5',
    options: {
      providerOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
      responseFormat: { type: 'json', schema: { type: 'object', properties: {} } },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Classify.' }] }],
    },
  },
  {
    name: 'json response format without a schema',
    modelId: 'claude-sonnet-4-5',
    options: {
      responseFormat: { type: 'json' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'JSON please.' }] }],
    },
  },
  {
    name: 'images and documents',
    modelId: 'claude-sonnet-4-6',
    options: {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at these.' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG } },
            { type: 'file', mediaType: 'image', data: { type: 'data', data: PNG } },
            {
              type: 'file',
              mediaType: 'image/jpeg',
              data: { type: 'url', url: 'https://example.com/a.jpg' },
            },
            {
              type: 'file',
              mediaType: 'application/pdf',
              filename: 'report.pdf',
              data: { type: 'data', data: PDF },
            },
            {
              type: 'file',
              mediaType: 'application/pdf',
              data: { type: 'url', url: 'https://example.com/b.pdf' },
              providerOptions: {
                anthropic: { citations: { enabled: true }, title: 'B', context: 'ctx' },
              },
            },
            { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', data: { type: 'data', data: TEXT } },
            { type: 'file', mediaType: 'text/plain', filename: 'inline.txt', data: { type: 'text', text: 'inline text' } },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'reference', reference: { anthropic: 'file_123' } },
            },
            {
              type: 'file',
              mediaType: 'application/pdf',
              data: { type: 'reference', reference: { anthropic: 'file_456' } },
              providerOptions: CACHE,
            },
          ],
          providerOptions: CACHE,
        },
      ],
    },
  },
  {
    name: 'tool results of every output type',
    modelId: 'claude-opus-4-8',
    options: {
      maxOutputTokens: 2000,
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Go.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Thinking it over.', providerOptions: { anthropic: { signature: 'sig_1' } } },
            { type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: 'redacted_1' } } },
            { type: 'reasoning', text: 'no metadata' },
            { type: 'text', text: 'Calling tools.' },
            { type: 'tool-call', toolCallId: 'toolu_a', toolName: 'a', input: { x: 1 } },
            { type: 'tool-call', toolCallId: 'toolu_b', toolName: 'b', input: 'not an object' },
            { type: 'text', text: 'And after.' },
            {
              type: 'tool-call',
              toolCallId: 'toolu_c',
              toolName: 'c',
              input: {},
              providerOptions: { anthropic: { caller: { type: 'direct' } } },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'toolu_a', toolName: 'a', output: { type: 'json', value: { ok: true, n: 1.5 } } },
            { type: 'tool-result', toolCallId: 'toolu_b', toolName: 'b', output: { type: 'error-text', value: 'boom' } },
            { type: 'tool-result', toolCallId: 'toolu_c', toolName: 'c', output: { type: 'error-json', value: { error: 'bad' } } },
            { type: 'tool-approval-response', approvalId: 'ap_1', approved: true },
            { type: 'tool-result', toolCallId: 'toolu_d', toolName: 'd', output: { type: 'execution-denied' } },
            {
              type: 'tool-result',
              toolCallId: 'toolu_e',
              toolName: 'e',
              output: { type: 'execution-denied', reason: 'Not allowed.' },
              providerOptions: CACHE,
            },
            {
              type: 'tool-result',
              toolCallId: 'toolu_f',
              toolName: 'f',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: 'A screenshot:' },
                  { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG } },
                  { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: PDF } },
                  { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://example.com/c.png' } },
                  { type: 'file', mediaType: 'text/csv', data: { type: 'data', data: TEXT } },
                ],
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'toolu_g',
              toolName: 'load_tools',
              output: {
                type: 'content',
                value: [
                  { type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName: 'remote__search' } } },
                  { type: 'custom', providerOptions: { anthropic: { type: 'tool-reference', toolName: 'remote__fetch' } } },
                  { type: 'custom' },
                ],
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'toolu_h',
              toolName: 'h',
              output: { type: 'text', value: 'cached output', providerOptions: CACHE },
            },
          ],
          providerOptions: CACHE_1H,
        },
      ],
    },
  },
  {
    name: 'tool changes in a mid-conversation system message',
    modelId: 'claude-opus-5-5',
    options: {
      maxOutputTokens: 16000,
      tools: [tool('read_file'), tool('remote__search', { providerOptions: { anthropic: { deferLoading: true } } })],
      prompt: [
        {
          role: 'system',
          content: 'Base.',
          providerOptions: {
            anthropic: { cacheControl: { type: 'ephemeral' }, toolChanges: [{ type: 'tool_addition', toolName: 'x' }] },
          },
        },
        { role: 'user', content: [{ type: 'text', text: 'One.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Two.' }] },
        {
          role: 'system',
          content: '',
          providerOptions: { anthropic: { toolChanges: [{ type: 'tool_addition', toolName: 'remote__search' }] } },
        },
        {
          role: 'system',
          content: '',
          providerOptions: { anthropic: { toolChanges: [{ type: 'tool_removal', toolName: 'old_tool' }] } },
        },
        { role: 'user', content: [{ type: 'text', text: 'Three.' }] },
        { role: 'system', content: 'A plain later system message.' },
        { role: 'user', content: [{ type: 'text', text: 'Four.' }] },
      ],
    },
  },
  {
    name: 'a fifth breakpoint and an hour-long one',
    modelId: 'claude-opus-4-8',
    options: {
      tools: [tool('a', { providerOptions: CACHE_1H })],
      prompt: [
        { role: 'system', content: 'S1', providerOptions: CACHE },
        { role: 'system', content: 'S2', providerOptions: CACHE },
        { role: 'user', content: [{ type: 'text', text: 'U1', providerOptions: CACHE }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'A1' }],
          providerOptions: { anthropic: { cache_control: { type: 'ephemeral' } } },
        },
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'R', providerOptions: { anthropic: { signature: 's', cacheControl: { type: 'ephemeral' } } } }],
        },
        { role: 'user', content: [{ type: 'text', text: 'U2' }], providerOptions: CACHE },
      ],
    },
  },
  {
    name: 'an unknown model through a proxy',
    modelId: 'my-proxy-alias',
    settings: { headers: { 'X-Custom': 'yes', 'anthropic-beta': 'Foo-Beta, bar-beta' } },
    options: {
      temperature: 1.5,
      topP: 0.9,
      topK: 40,
      seed: 7,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      headers: { ...UA, 'anthropic-beta': 'req-beta' },
      providerOptions: { anthropic: { anthropicBeta: ['opt-beta'], disableParallelToolUse: true } },
      tools: [tool('a', { strict: true, inputExamples: [{ input: { path: '/x' } }] })],
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Prefilled answer  \n' }] },
      ],
    },
  },
  {
    name: 'claude 3 with temperature and top p',
    modelId: 'claude-3-haiku-20240307',
    options: {
      temperature: -1,
      topP: 0.9,
      maxOutputTokens: 100000,
      tools: [tool('a', { strict: true })],
      toolChoice: { type: 'required' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'tool choice required on a model that rejects forced tool use',
    modelId: 'claude-opus-5-5',
    options: {
      tools: [tool('a'), tool('b')],
      toolChoice: { type: 'required' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'tool choice tool on a model that rejects forced tool use',
    modelId: 'claude-opus-5-5',
    options: {
      tools: [tool('a'), tool('b')],
      toolChoice: { type: 'tool', toolName: 'b' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'tool choice tool',
    modelId: 'claude-sonnet-4-5',
    options: {
      tools: [tool('a'), tool('b')],
      toolChoice: { type: 'tool', toolName: 'b' },
      providerOptions: { anthropic: { disableParallelToolUse: true } },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'tool choice none drops the tools',
    modelId: 'claude-sonnet-4-5',
    options: {
      tools: [tool('a')],
      toolChoice: { type: 'none' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'an empty tool list',
    modelId: 'claude-sonnet-4-5',
    options: {
      tools: [],
      providerOptions: { anthropic: { disableParallelToolUse: true } },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'reasoning high on an adaptive model',
    modelId: 'claude-opus-5',
    options: {
      reasoning: 'high',
      temperature: 0.5,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'reasoning xhigh on a budget model',
    modelId: 'claude-sonnet-4-5',
    options: {
      reasoning: 'xhigh',
      maxOutputTokens: 1000,
      temperature: 0.5,
      topK: 3,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'reasoning none on a model that cannot turn thinking off',
    modelId: 'claude-opus-5-5',
    options: {
      reasoning: 'none',
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'thinking disabled on a model that cannot turn it off',
    modelId: 'claude-sonnet-5-5',
    options: {
      providerOptions: { anthropic: { thinking: { type: 'disabled' }, effort: 'max' } },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'thinking enabled without a budget',
    modelId: 'claude-sonnet-4-5',
    options: {
      maxOutputTokens: 63500,
      providerOptions: {
        anthropic: {
          thinking: { type: 'enabled' },
          metadata: { userId: 'u_1' },
          cacheControl: { type: 'ephemeral' },
          serviceTier: 'auto',
          speed: 'fast',
          inferenceGeo: 'us',
          taskBudget: { type: 'tokens', total: 30000, remaining: 100 },
          sendReasoning: false,
        },
      },
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'x', providerOptions: { anthropic: { signature: 's' } } }, { type: 'text', text: 'y' }] },
        { role: 'user', content: [{ type: 'text', text: 'Again' }] },
      ],
    },
  },
  {
    name: 'adaptive thinking with a binding and haiku effort',
    modelId: 'claude-haiku-5-5',
    options: {
      providerOptions: {
        anthropic: {
          thinking: { type: 'disabled' },
          effort: 'xhigh',
        },
      },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
  {
    name: 'a custom provider name reads its own options key',
    modelId: 'claude-sonnet-4-5',
    settings: { name: 'gateway.messages' },
    options: {
      providerOptions: {
        anthropic: { disableParallelToolUse: false },
        gateway: { disableParallelToolUse: true, thinking: { type: 'disabled' } },
      },
      tools: [tool('a')],
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    },
  },
];

const RESPONSE_REQUEST = {
  maxOutputTokens: 100,
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
};

/** Each response case: what the API answered and the call that got it. */
const responseCases = [
  {
    name: 'text with cache usage',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 200,
    responseHeaders: { 'request-id': 'req_1', 'anthropic-ratelimit-requests-limit': '50' },
    body: {
      model: 'claude-opus-5-5',
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello there.', citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
        output_tokens: 5,
        service_tier: 'standard',
        inference_geo: 'not_available',
      },
    },
  },
  {
    name: 'thinking, text and tool calls',
    modelId: 'claude-opus-5-5',
    options: { ...RESPONSE_REQUEST, tools: [tool('read_file')] },
    status: 200,
    body: {
      id: 'msg_02',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [
        { type: 'thinking', thinking: 'Let me think.', signature: 'sig_abc' },
        { type: 'redacted_thinking', data: 'enc_data' },
        { type: 'text', text: 'I will read it.' },
        { type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: '/etc/hosts', n: 1.5, z: 2 } },
        { type: 'tool_use', id: 'toolu_02', name: 'read_file', input: {}, caller: { type: 'direct' } },
        {
          type: 'tool_use',
          id: 'toolu_03',
          name: 'read_file',
          input: { path: 'a' },
          caller: { type: 'code_execution_20250825', tool_id: 'srvtoolu_1' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 50,
        output_tokens: 30,
        output_tokens_details: { thinking_tokens: 10, other: 1 },
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 0,
      },
    },
  },
  {
    name: 'a json tool answer',
    modelId: 'claude-haiku-5-5',
    options: {
      providerOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
      responseFormat: { type: 'json', schema: { type: 'object', properties: { verdict: { type: 'string' } } } },
      prompt: RESPONSE_REQUEST.prompt,
    },
    status: 200,
    body: {
      id: 'msg_03',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [
        { type: 'text', text: 'Here you go.' },
        { type: 'tool_use', id: 'toolu_j', name: 'json', input: { verdict: 'respond' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  },
  {
    name: 'max tokens with stop details',
    modelId: 'claude-sonnet-4-5',
    options: RESPONSE_REQUEST,
    status: 200,
    body: {
      id: 'msg_04',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Cut off' }],
      stop_reason: 'max_tokens',
      stop_sequence: null,
      stop_details: { type: 'max_tokens', category: null, explanation: 'Too long' },
      usage: { input_tokens: 5, output_tokens: 100 },
      container: null,
      context_management: null,
    },
  },
  {
    name: 'a stop sequence and a refusal',
    modelId: 'claude-sonnet-4-5',
    options: RESPONSE_REQUEST,
    status: 200,
    body: {
      type: 'message',
      content: [],
      stop_reason: 'refusal',
      stop_sequence: '###',
      usage: {
        input_tokens: 5,
        output_tokens: 0,
        iterations: [
          { type: 'compaction', input_tokens: 100, output_tokens: 10 },
          { type: 'message', input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 5, model: 'claude-x' },
          { type: 'advisor_message', input_tokens: 999, output_tokens: 999 },
        ],
      },
    },
  },
  {
    name: 'citations of a document',
    modelId: 'claude-sonnet-4-5',
    options: {
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'application/pdf',
              filename: 'doc.pdf',
              data: { type: 'data', data: PDF },
              providerOptions: { anthropic: { citations: { enabled: true } } },
            },
            { type: 'text', text: 'Cite it.' },
          ],
        },
      ],
    },
    status: 200,
    body: {
      type: 'message',
      id: 'msg_05',
      model: 'claude-sonnet-4-5',
      content: [
        {
          type: 'text',
          text: 'It says hello.',
          citations: [
            {
              type: 'page_location',
              cited_text: 'hello',
              document_index: 0,
              document_title: null,
              start_page_number: 1,
              end_page_number: 2,
            },
            {
              type: 'char_location',
              cited_text: 'hel',
              document_index: 0,
              document_title: 'Titled',
              start_char_index: 0,
              end_char_index: 3,
            },
            {
              type: 'page_location',
              cited_text: 'missing',
              document_index: 5,
              document_title: null,
              start_page_number: 1,
              end_page_number: 1,
            },
          ],
        },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  },
  {
    name: 'overloaded',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 529,
    statusText: 'Site Overloaded',
    responseHeaders: { 'retry-after': '3' },
    body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  },
  {
    name: 'a bad request',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 400,
    statusText: 'Bad Request',
    body: {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages: roles must alternate' },
      request_id: 'req_x',
    },
  },
  {
    name: 'a rate limit',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 429,
    statusText: 'Too Many Requests',
    body: { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } },
  },
  {
    name: 'an html error page',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 502,
    statusText: 'Bad Gateway',
    rawBody: '<html><body>Bad gateway</body></html>',
  },
  {
    name: 'an error with an empty body',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 403,
    statusText: 'Forbidden',
    rawBody: '  ',
  },
  {
    name: 'an error that is json of another shape',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 404,
    statusText: 'Not Found',
    body: { message: 'The model does not exist' },
  },
  {
    name: 'a success that is not json',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 200,
    rawBody: 'not json',
  },
  {
    name: 'a success of an unknown shape',
    modelId: 'claude-opus-5-5',
    options: RESPONSE_REQUEST,
    status: 200,
    body: { type: 'message', content: [{ type: 'brand_new_block' }], usage: { input_tokens: 1, output_tokens: 1 } },
  },
];

/** File parts give a URL object, as the SDK hands a provider. */
function toSdkOptions(options) {
  const copy = structuredClone(options);
  const visitParts = (parts) => {
    for (const part of parts ?? []) {
      if (part?.type === 'file' && part.data?.type === 'url') part.data.url = new URL(part.data.url);
      if (part?.type === 'tool-result' && part.output?.type === 'content') visitParts(part.output.value);
    }
  };
  for (const message of copy.prompt) {
    if (Array.isArray(message.content)) visitParts(message.content);
  }
  return copy;
}

function stripRuntimeAgent(headers) {
  const result = { ...headers };
  if (result['user-agent'] != null) {
    result['user-agent'] = result['user-agent'].replace(/ node\.js\/\S+$/, '');
  }
  return result;
}

function provider(settings, fetch) {
  let next = 0;
  return createAnthropic({
    apiKey: 'sk-test',
    baseURL: 'https://api.example.com/v1',
    generateId: () => `id-${next++}`,
    ...settings,
    fetch,
  });
}

const requests = [];
for (const testCase of requestCases) {
  let captured;
  const fetch = async (url, init) => {
    captured = { url, headers: stripRuntimeAgent(init.headers), body: init.body };
    return new Response(JSON.stringify(OK_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const model = provider(testCase.settings, fetch).languageModel(testCase.modelId);
  const result = await model.doGenerate(toSdkOptions(testCase.options));
  requests.push({
    name: testCase.name,
    modelId: testCase.modelId,
    settings: testCase.settings ?? {},
    options: testCase.options,
    url: captured.url,
    headers: captured.headers,
    body: captured.body,
    warnings: result.warnings,
  });
}

const responses = [];
for (const testCase of responseCases) {
  const text = testCase.rawBody ?? JSON.stringify(testCase.body);
  const fetch = async () =>
    new Response(text, {
      status: testCase.status,
      statusText: testCase.statusText ?? 'OK',
      headers: { 'content-type': 'application/json', ...(testCase.responseHeaders ?? {}) },
    });
  const model = provider({}, fetch).languageModel(testCase.modelId);
  const entry = {
    name: testCase.name,
    modelId: testCase.modelId,
    options: testCase.options,
    status: testCase.status,
    statusText: testCase.statusText ?? 'OK',
    responseHeaders: { 'content-type': 'application/json', ...(testCase.responseHeaders ?? {}) },
    responseBody: text,
  };
  try {
    const result = await model.doGenerate(toSdkOptions(testCase.options));
    entry.result = JSON.parse(
      JSON.stringify({
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
        providerMetadata: result.providerMetadata,
        warnings: result.warnings,
        response: result.response,
      }),
    );
  } catch (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode,
      isRetryable: error.isRetryable,
      responseBody: error.responseBody,
      responseHeaders: error.responseHeaders,
      data: error.data,
      url: error.url,
    };
  }
  responses.push(entry);
}

writeFileSync(
  join(here, 'anthropic_sdk.json'),
  `${JSON.stringify({ sdkVersion: '4.0.78', requests, responses }, null, 2)}\n`,
);
console.log(`wrote ${requests.length} requests and ${responses.length} responses`);
