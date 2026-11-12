// Writes openai_sdk.json: what @ai-sdk/openai (Responses API, embeddings) and
// @ai-sdk/azure (embeddings) send and return for a set of call options, captured
// through a fake `fetch`. The Rust port of both providers is tested against it.
//
// Run: node openai_sdk.mjs <node_modules dir>
// The node_modules dir must hold @ai-sdk/openai and @ai-sdk/azure at the versions
// package-lock.json pins (4.0.99 each), installed as npm lays them out.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = process.argv[2];
if (!nodeModules) throw new Error('usage: node openai_sdk.mjs <node_modules dir>');
const load = (path) => import(pathToFileURL(join(nodeModules, path)).href);
const { createOpenAI, VERSION: OPENAI_VERSION } = await load('@ai-sdk/openai/dist/index.js');
const { createAzure, VERSION: AZURE_VERSION } = await load('@ai-sdk/azure/dist/index.js');
const { asSchema } = await load('@ai-sdk/openai/node_modules/@ai-sdk/provider-utils/dist/index.js');

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = 'JVBERi0xLjQK';
const UA = { 'user-agent': 'ai/7.0.137' };

const schema = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
});

const tool = (name, extra = {}) => ({
  type: 'function',
  name,
  description: `The ${name} tool.`,
  inputSchema: schema({ path: { type: 'string', description: 'A path.' } }),
  ...extra,
});

const LOAD_TOOLS = {
  type: 'provider',
  name: 'load_tools',
  id: 'openai.tool_search',
  args: {
    execution: 'client',
    description: 'Load deferred tools by name or query.',
    parameters: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' } }, query: { type: 'string' } },
      additionalProperties: false,
    },
  },
};

const TOOLS = [
  tool('read_file'),
  tool('remote__search', { providerOptions: { openai: { deferLoading: true } } }),
  tool('strict_tool', { strict: true }),
  LOAD_TOOLS,
];

const OK_RESPONSE = {
  id: 'resp_ok',
  created_at: 1741269019,
  model: 'gpt-test',
  output: [
    {
      type: 'message',
      role: 'assistant',
      id: 'msg_ok',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};

const chatHistory = [
  { role: 'system', content: 'You are a helpful agent.' },
  { role: 'system', content: '# Dynamic\nToday is Monday.' },
  { role: 'user', content: [{ type: 'text', text: 'Read /etc/hosts' }] },
  {
    role: 'assistant',
    content: [
      {
        type: 'reasoning',
        text: 'Thinking about it.',
        providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc_1' } },
      },
      { type: 'text', text: 'Reading it now.', providerOptions: { openai: { itemId: 'msg_1' } } },
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { path: '/etc/hosts' },
        providerOptions: { openai: { itemId: 'fc_1' } },
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call_1',
        toolName: 'read_file',
        output: { type: 'text', value: '127.0.0.1 localhost' },
      },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'It maps localhost.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Thanks.' }] },
];

const userTurn = (text = 'Hello') => [{ role: 'user', content: [{ type: 'text', text }] }];

/** Each request case: the model, the provider settings and the call options. */
const requestCases = [
  {
    name: 'chat turn with tools, history and a 12-hour cache',
    modelId: 'gpt-5.6-sol',
    options: {
      maxOutputTokens: 16000,
      headers: UA,
      toolChoice: { type: 'auto' },
      tools: TOOLS,
      providerOptions: { openai: { promptCacheOptions: { ttl: '12h' } } },
      prompt: chatHistory,
    },
  },
  {
    name: 'a request that writes no cache entry',
    modelId: 'gpt-5.6-sol',
    options: {
      maxOutputTokens: 16000,
      headers: UA,
      providerOptions: { openai: { promptCacheOptions: { mode: 'explicit' }, unknownKey: 1 } },
      prompt: userTurn(),
    },
  },
  {
    name: 'a classification gate with reasoning off',
    modelId: 'gpt-5.6-luna',
    options: {
      maxOutputTokens: 16,
      headers: UA,
      providerOptions: { openai: { reasoningEffort: 'none' } },
      prompt: [{ role: 'system', content: 'Answer yes or no.' }, ...userTurn('Is it raining?')],
    },
  },
  {
    name: 'a temperature with reasoning off on a model that takes it',
    modelId: 'gpt-5.6-luna',
    options: {
      maxOutputTokens: 16,
      temperature: 0,
      topP: 0.5,
      providerOptions: { openai: { reasoningEffort: 'none' } },
      prompt: userTurn(),
    },
  },
  {
    name: 'sampling params on a reasoning model',
    modelId: 'gpt-5.6-sol',
    options: { temperature: 0.5, topP: 0.9, prompt: userTurn() },
  },
  {
    name: 'unsupported settings on a non-reasoning model',
    modelId: 'gpt-4.1',
    options: {
      temperature: 0.2,
      topP: 0.3,
      topK: 3,
      seed: 1,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ['STOP'],
      providerOptions: {
        openai: { reasoningEffort: 'low', reasoningSummary: 'auto', serviceTier: 'flex' },
      },
      prompt: [{ role: 'system', content: 'Be brief.' }, ...userTurn()],
    },
  },
  {
    name: 'an OpenRouter model id with reasoning off',
    modelId: 'openai/gpt-5.6-sol',
    options: {
      maxOutputTokens: 16,
      providerOptions: { openai: { reasoningEffort: 'none' } },
      prompt: [{ role: 'system', content: 'Answer yes or no.' }, ...userTurn()],
    },
  },
  {
    name: 'structured output with a schema',
    modelId: 'gpt-5.6-luna',
    options: {
      responseFormat: {
        type: 'json',
        name: 'verdict',
        description: 'The verdict.',
        schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {
            decision: { type: 'string', enum: ['respond', 'ignore'] },
            code: { type: 'string', pattern: '^(?!x)[a-z]+$' },
            plain: { type: 'string', pattern: '^[a-z(?=]+$' },
            tags: { type: 'object', propertyNames: { type: 'string', minLength: 1 }, additionalProperties: { type: 'number' } },
            node: { allOf: [{ $ref: '#/$defs/node' }], description: 'A node.' },
          },
          required: ['decision', 'code', 'plain', 'tags', 'node'],
          additionalProperties: false,
          $defs: { node: { type: 'object', properties: { next: { allOf: [{ $ref: '#/$defs/node' }] } } } },
        },
      },
      providerOptions: { openai: { reasoningEffort: 'none' } },
      prompt: userTurn('Decide.'),
    },
  },
  {
    name: 'structured output with a root reference',
    modelId: 'gpt-5.6-luna',
    options: {
      responseFormat: {
        type: 'json',
        schema: {
          allOf: [{ $ref: '#/definitions/root' }],
          definitions: { root: { type: 'object', properties: { a: { type: 'string' } } } },
        },
      },
      providerOptions: { openai: { strictJsonSchema: false, textVerbosity: 'low' } },
      prompt: userTurn('Decide.'),
    },
  },
  {
    name: 'structured output without a schema',
    modelId: 'gpt-5.6-luna',
    options: { responseFormat: { type: 'json' }, prompt: userTurn('Decide.') },
  },
  {
    name: 'tool choice required',
    modelId: 'gpt-5.6-sol',
    options: { tools: [tool('read_file')], toolChoice: { type: 'required' }, prompt: userTurn() },
  },
  {
    name: 'tool choice none keeps the tools',
    modelId: 'gpt-5.6-sol',
    options: { tools: TOOLS, toolChoice: { type: 'none' }, prompt: userTurn() },
  },
  {
    name: 'tool choice of one function tool',
    modelId: 'gpt-5.6-sol',
    options: { tools: TOOLS, toolChoice: { type: 'tool', toolName: 'read_file' }, prompt: userTurn() },
  },
  {
    name: 'tool choice of the tool search tool',
    modelId: 'gpt-5.6-sol',
    options: { tools: TOOLS, toolChoice: { type: 'tool', toolName: 'load_tools' }, prompt: userTurn() },
  },
  {
    name: 'an empty tool list sends no tools',
    modelId: 'gpt-5.6-sol',
    options: { tools: [], toolChoice: { type: 'auto' }, prompt: userTurn() },
  },
  {
    name: 'a tool schema that needs normalizing',
    modelId: 'gpt-5.6-sol',
    options: {
      tools: [
        {
          type: 'function',
          name: 'odd',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', pattern: '(?<!a)b' },
              map: { type: 'object', propertyNames: { type: 'string' } },
              list: { type: 'array', items: [{ type: 'string', pattern: 'x(?=y)' }, true] },
            },
          },
        },
      ],
      prompt: userTurn(),
    },
  },
  {
    name: 'a deferred tool load replayed from history',
    modelId: 'gpt-5.6-sol',
    options: {
      tools: TOOLS,
      prompt: [
        ...userTurn('Search the web.'),
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tsc_abc',
              toolName: 'load_tools',
              input: { arguments: { query: 'search' }, call_id: 'tsc_abc' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tsc_abc',
              toolName: 'load_tools',
              output: {
                type: 'json',
                value: {
                  tools: [
                    {
                      type: 'function',
                      name: 'remote__search',
                      description: 'Search.',
                      parameters: { type: 'object', properties: {} },
                      strict: false,
                      defer_loading: true,
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tsc_def',
              toolName: 'load_tools',
              input: '{"arguments":{"names":["remote__search"]},"call_id":"tsc_def"}',
              providerOptions: { openai: { itemId: 'tsc_item' } },
            },
            {
              type: 'tool-call',
              toolCallId: 'call_2',
              toolName: 'remote__search',
              input: { q: 'rust' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tsc_def',
              toolName: 'load_tools',
              output: { type: 'json', value: { tools: [] } },
            },
            {
              type: 'tool-result',
              toolCallId: 'call_2',
              toolName: 'remote__search',
              output: { type: 'json', value: { hits: 3 } },
            },
          ],
        },
      ],
    },
  },
  {
    name: 'user files',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look.' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG }, providerOptions: { openai: { imageDetail: 'low' } } },
            { type: 'file', mediaType: 'image', data: { type: 'data', data: PNG } },
            { type: 'file', mediaType: 'image/jpeg', data: { type: 'url', url: 'https://example.com/a.jpg' } },
            { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: PDF }, filename: 'report.pdf' },
            { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: PDF } },
            { type: 'file', mediaType: 'application/pdf', data: { type: 'url', url: 'https://example.com/a.pdf' } },
            { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'file-abc123' } },
            { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { openai: 'file-ref1' } } },
          ],
        },
      ],
    },
  },
  {
    name: 'a file of an unsupported media type',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        {
          role: 'user',
          content: [{ type: 'file', mediaType: 'text/plain', data: { type: 'data', data: 'aGVsbG8=' } }],
        },
      ],
    },
  },
  {
    name: 'a text file part',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        { role: 'user', content: [{ type: 'file', mediaType: 'text/plain', data: { type: 'text', text: 'hi' } }] },
      ],
    },
  },
  {
    name: 'an image whose type cannot be detected',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        { role: 'user', content: [{ type: 'file', mediaType: 'image', data: { type: 'data', data: 'aGVsbG8gd29ybGQ=' } }] },
      ],
    },
  },
  {
    name: 'tool result outputs',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        ...userTurn(),
        {
          role: 'assistant',
          content: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({
            type: 'tool-call',
            toolCallId: `call_${id}`,
            toolName: 'read_file',
            input: id === 'g' ? {} : { path: id },
          })),
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'call_a', toolName: 'read_file', output: { type: 'error-text', value: 'boom' } },
            { type: 'tool-result', toolCallId: 'call_b', toolName: 'read_file', output: { type: 'error-json', value: { code: 1 } } },
            { type: 'tool-result', toolCallId: 'call_c', toolName: 'read_file', output: { type: 'execution-denied', reason: 'No.' } },
            { type: 'tool-result', toolCallId: 'call_d', toolName: 'read_file', output: { type: 'execution-denied' } },
            { type: 'tool-result', toolCallId: 'call_e', toolName: 'read_file', output: { type: 'json', value: [1, 'two', null] } },
            {
              type: 'tool-result',
              toolCallId: 'call_f',
              toolName: 'read_file',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: 'A screenshot:' },
                  { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG } },
                  { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: PDF }, filename: 'a.pdf' },
                  { type: 'file', mediaType: 'image/png', data: { type: 'url', url: 'https://example.com/s.png' }, providerOptions: { openai: { imageDetail: 'high' } } },
                  { type: 'file', mediaType: 'application/pdf', data: { type: 'url', url: 'https://example.com/s.pdf' } },
                  { type: 'file', mediaType: 'image/png', data: { type: 'reference', reference: { openai: 'file-img' } } },
                  { type: 'file', mediaType: 'text/plain', data: { type: 'text', text: 'x' } },
                  { type: 'custom', providerOptions: { openai: { a: 1 } } },
                ],
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'call_g',
              toolName: 'read_file',
              output: { type: 'text', value: 'cached', providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } },
            },
          ],
        },
      ],
    },
  },
  {
    name: 'prompt cache breakpoints on messages',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        { role: 'system', content: 'Stable.', providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hi', providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG }, providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } },
          ],
        },
      ],
    },
  },
  {
    name: 'reasoning without stored responses',
    modelId: 'gpt-5.6-sol',
    options: {
      providerOptions: { openai: { store: false } },
      prompt: [
        ...userTurn(),
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'One.', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc_a' } } },
            { type: 'reasoning', text: 'Two.', providerOptions: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc_b' } } },
            { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_1' } } },
            { type: 'reasoning', text: '', providerOptions: { openai: { itemId: 'rs_2' } } },
            { type: 'reasoning', text: 'Loose.', providerOptions: { openai: { reasoningEncryptedContent: 'enc_c' } } },
            { type: 'reasoning', text: 'Foreign.' },
            { type: 'text', text: 'Answer.', providerOptions: { openai: { itemId: 'msg_1', phase: 'final_answer' } } },
            { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: 'x' }, providerOptions: { openai: { itemId: 'fc_1' } } },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read_file', output: { type: 'text', value: 'x' } }],
        },
      ],
    },
  },
  {
    name: 'stored items on a reasoning model',
    modelId: 'gpt-5.6-sol',
    options: {
      prompt: [
        ...userTurn(),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before reasoning.', providerOptions: { openai: { itemId: 'msg_0' } } },
            { type: 'reasoning', text: 'A.', providerOptions: { openai: { itemId: 'rs_1' } } },
            { type: 'reasoning', text: 'B.', providerOptions: { openai: { itemId: 'rs_1' } } },
            { type: 'text', text: 'After.', providerOptions: { openai: { itemId: 'msg_1' } } },
            { type: 'text', text: 'After again.', providerOptions: { openai: { itemId: 'msg_1' } } },
            { type: 'reasoning', text: 'Loose.', providerOptions: { openai: { reasoningEncryptedContent: 'enc_c' } } },
            { type: 'tool-result', toolCallId: 'call_x', toolName: 'read_file', output: { type: 'json', value: {} } },
            { type: 'tool-result', toolCallId: 'call_y', toolName: 'read_file', output: { type: 'execution-denied' } },
          ],
        },
        ...userTurn('Next.'),
      ],
    },
  },
  {
    name: 'stored text on a non-reasoning model',
    modelId: 'gpt-4.1',
    options: {
      prompt: [
        ...userTurn(),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'One.', providerOptions: { openai: { itemId: 'msg_1', phase: 'commentary' } } },
            { type: 'text', text: 'Two.', providerOptions: { openai: { itemId: 'msg_1' } } },
            { type: 'text', text: 'Three.', providerOptions: { openai: { phase: 'commentary' } } },
          ],
        },
        ...userTurn('Next.'),
      ],
    },
  },
  {
    name: 'a reasoning call option',
    modelId: 'gpt-5.6-sol',
    options: { reasoning: 'medium', prompt: userTurn() },
  },
  {
    name: 'a provider-default reasoning call option',
    modelId: 'gpt-5.6-sol',
    options: { reasoning: 'provider-default', prompt: userTurn() },
  },
  {
    name: 'an effort the model does not support',
    modelId: 'gpt-6-sol',
    options: { providerOptions: { openai: { reasoningEffort: 'minimal' } }, prompt: userTurn() },
  },
  {
    name: 'a reasoning summary set explicitly',
    modelId: 'gpt-5.6-sol',
    options: { providerOptions: { openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } }, prompt: userTurn() },
  },
  {
    name: 'invalid provider options',
    modelId: 'gpt-5.6-sol',
    options: { providerOptions: { openai: { promptCacheOptions: { ttl: '1h' } } }, prompt: userTurn() },
  },
  {
    name: 'the remaining request options',
    modelId: 'gpt-5.6-sol',
    options: {
      providerOptions: {
        openai: {
          parallelToolCalls: false,
          user: 'u1',
          metadata: { k: 'v' },
          promptCacheKey: 'key',
          safetyIdentifier: 'sid',
          maxToolCalls: 3,
          instructions: 'Be kind.',
          truncation: 'auto',
          serviceTier: 'priority',
          include: ['file_search_call.results'],
        },
      },
      prompt: userTurn(),
    },
  },
  {
    name: 'system messages removed',
    modelId: 'gpt-5.6-sol',
    options: {
      providerOptions: { openai: { systemMessageMode: 'remove' } },
      prompt: [{ role: 'system', content: 'Gone.' }, ...userTurn()],
    },
  },
];

const usage = { input_tokens: 100, output_tokens: 20 };
const message = (text, extra = {}) => ({
  type: 'message',
  role: 'assistant',
  id: 'msg_1',
  content: [{ type: 'output_text', text, annotations: [] }],
  ...extra,
});
const RESPONSE_REQUEST = {
  tools: [tool('read_file'), tool('write_file'), LOAD_TOOLS],
  prompt: userTurn(),
};

const responseCases = [
  {
    name: 'text with cached and reasoning tokens',
    modelId: 'gpt-5.6-sol',
    status: 200,
    responseHeaders: { 'x-request-id': 'req_1' },
    body: {
      id: 'resp_1',
      object: 'response',
      created_at: 1741269019.5,
      model: 'gpt-5.6-sol-2026-01-01',
      status: 'completed',
      service_tier: 'default',
      output: [message('Hello there.', { phase: 'final_answer', status: 'completed' })],
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1000, extra: 1 },
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 30 },
        total_tokens: 1240,
      },
    },
  },
  {
    name: 'reasoning and a function call',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_2',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc', summary: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"/x"}', status: 'completed' },
      ],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 8 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } },
    },
  },
  {
    name: 'reasoning with two summaries',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_3',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'First.' }, { type: 'summary_text', text: 'Second.' }] },
        message('Done.'),
      ],
      usage,
    },
  },
  {
    name: 'a parallel wrapper call',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_4',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        {
          type: 'function_call',
          id: 'fc_p',
          call_id: 'call_p',
          name: 'parallel',
          arguments: JSON.stringify({
            tool_uses: [
              { recipient_name: 'functions.read_file', parameters: { path: '/a' } },
              { recipient_name: 'functions.write_file', parameters: { path: '/b' } },
            ],
          }),
        },
      ],
      usage,
    },
  },
  {
    name: 'a parallel wrapper naming an undeclared tool',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_5',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        {
          type: 'function_call',
          id: 'fc_p',
          call_id: 'call_p',
          name: 'parallel',
          arguments: JSON.stringify({ tool_uses: [{ recipient_name: 'functions.nope', parameters: {} }] }),
          namespace: 'ns',
          caller: { type: 'program', caller_id: 'prog_1' },
        },
      ],
      usage,
    },
  },
  {
    name: 'a client tool search call',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_6',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        { type: 'tool_search_call', id: 'ts_1', execution: 'client', call_id: 'call_ts', status: 'completed', arguments: { query: 'web' } },
      ],
      usage,
    },
  },
  {
    name: 'a hosted tool search and its output',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_7',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        { type: 'tool_search_call', id: 'ts_1', execution: 'server', call_id: null, status: 'completed', arguments: { query: 'web' } },
        { type: 'tool_search_output', id: 'tso_1', execution: 'server', call_id: null, status: 'completed', tools: [{ type: 'function', name: 'remote__search' }] },
        message('Found it.'),
      ],
      usage,
    },
  },
  {
    name: 'an output cut at the token limit',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_8',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [message('Partial')],
      usage,
    },
  },
  {
    name: 'a content filter',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_9',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      incomplete_details: { reason: 'content_filter' },
      output: [],
      usage,
    },
  },
  {
    name: 'an incomplete response with a function call',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_10',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      incomplete_details: { reason: 'something_else' },
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{}' }],
      usage,
    },
  },
  {
    name: 'an unknown incomplete reason',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_10b',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      incomplete_details: { reason: 'something_else' },
      output: [message('x')],
      usage,
    },
  },
  {
    name: 'annotations',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_11',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          content: [
            {
              type: 'output_text',
              text: 'See sources.',
              annotations: [
                { type: 'url_citation', title: 'Example', url: 'https://example.com', start_index: 0, end_index: 3 },
                { type: 'file_citation', file_id: 'file-1', filename: 'a.txt', index: 2 },
                { type: 'container_file_citation', container_id: 'c1', file_id: 'file-2', filename: 'b.txt', start_index: 1, end_index: 2 },
                { type: 'file_path', file_id: 'file-3', index: 4 },
              ],
            },
          ],
        },
      ],
      usage,
    },
  },
  {
    name: 'only file path annotations',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_11b',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_1',
          content: [{ type: 'output_text', text: 'A file.', annotations: [{ type: 'file_path', file_id: 'file-3', index: 4 }] }],
        },
      ],
      usage,
    },
  },
  {
    name: 'reasoning context in the response',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_12',
      created_at: 1741269020,
      model: 'gpt-5.6-sol',
      reasoning: { context: 'ctx_1', effort: 'low' },
      output: [message('x')],
      usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: null, output_tokens_details: null },
    },
  },
  {
    name: 'an error in a 200 body',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: {
      id: 'resp_13',
      error: { message: 'The model failed.', type: 'server_error', code: 'server_error' },
    },
  },
  {
    name: 'no output with a reason',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: { id: 'resp_14', created_at: 1741269020, incomplete_details: { reason: 'max_output_tokens' } },
  },
  {
    name: 'no output without a reason',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: { id: 'resp_15', created_at: 1741269020 },
  },
  {
    name: 'a 400 error',
    modelId: 'gpt-5.6-sol',
    status: 400,
    statusText: 'Bad Request',
    body: { error: { message: "Invalid value: 'x'.", type: 'invalid_request_error', param: 'input', code: 'invalid_value' } },
  },
  {
    name: 'a 429 with an empty body',
    modelId: 'gpt-5.6-sol',
    status: 429,
    statusText: 'Too Many Requests',
    rawBody: '',
    responseHeaders: { 'retry-after': '2' },
  },
  {
    name: 'a 500 that is not json',
    modelId: 'gpt-5.6-sol',
    status: 500,
    statusText: 'Internal Server Error',
    rawBody: 'upstream failed',
  },
  {
    name: 'an error body of another shape',
    modelId: 'gpt-5.6-sol',
    status: 403,
    statusText: 'Forbidden',
    body: { type: 'about:blank', detail: 'denied' },
  },
  {
    name: 'a success that is not json',
    modelId: 'gpt-5.6-sol',
    status: 200,
    rawBody: 'not json',
  },
  {
    name: 'a success of an unknown shape',
    modelId: 'gpt-5.6-sol',
    status: 200,
    body: { id: 'resp_16', created_at: 1741269020, output: [{ type: 'brand_new_item', id: 'x' }], usage },
  },
];

function stripRuntimeAgent(headers) {
  const result = { ...headers };
  if (result['user-agent'] != null) {
    result['user-agent'] = result['user-agent'].replace(/ node\.js\/\S+$/, '');
  }
  return result;
}

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

function errorFields(error) {
  return {
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

const json = (value) => JSON.parse(JSON.stringify(value));

function openai(fetch) {
  return createOpenAI({ apiKey: 'sk-test', baseURL: 'https://api.example.com/v1', fetch });
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
  const model = openai(fetch).languageModel(testCase.modelId);
  const entry = { name: testCase.name, modelId: testCase.modelId, options: testCase.options };
  try {
    const result = await model.doGenerate(toSdkOptions(testCase.options));
    Object.assign(entry, {
      url: captured.url,
      headers: captured.headers,
      body: captured.body,
      warnings: result.warnings,
    });
  } catch (error) {
    entry.error = errorFields(error);
  }
  requests.push(json(entry));
}

const responses = [];
for (const testCase of responseCases) {
  const text = testCase.rawBody ?? JSON.stringify(testCase.body);
  const responseHeaders = { 'content-type': 'application/json', ...(testCase.responseHeaders ?? {}) };
  const fetch = async () =>
    new Response(text, {
      status: testCase.status,
      statusText: testCase.statusText ?? 'OK',
      headers: responseHeaders,
    });
  const model = openai(fetch).languageModel(testCase.modelId);
  const entry = {
    name: testCase.name,
    modelId: testCase.modelId,
    options: RESPONSE_REQUEST,
    status: testCase.status,
    statusText: testCase.statusText ?? 'OK',
    responseHeaders,
    responseBody: text,
  };
  try {
    const result = await model.doGenerate(toSdkOptions(RESPONSE_REQUEST));
    entry.result = json({
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage,
      providerMetadata: result.providerMetadata,
      warnings: result.warnings,
      response: result.response,
    });
  } catch (error) {
    entry.error = json(errorFields(error));
  }
  responses.push(entry);
}

const EMBEDDING_OK = {
  object: 'list',
  data: [
    { object: 'embedding', index: 0, embedding: [0.1, -0.25] },
    { object: 'embedding', index: 1, embedding: [1, 0] },
  ],
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: 7, total_tokens: 7 },
};

const embeddingCases = [
  {
    name: 'openai embeddings with the dimension target',
    provider: 'openai',
    settings: { apiKey: 'sk-test', baseURL: 'https://api.example.com/v1' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a', 'b'], headers: UA, providerOptions: { openai: { dimensions: 1024 } } },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'openai embeddings without usage',
    provider: 'openai',
    settings: { apiKey: 'sk-test', baseURL: 'https://api.example.com/v1/' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'], dimensions: 8, providerOptions: { openai: { user: 'u1' } } },
    status: 200,
    body: { data: [{ embedding: [0.5] }] },
  },
  {
    name: 'openai embeddings refused',
    provider: 'openai',
    settings: { apiKey: 'sk-test', baseURL: 'https://api.example.com/v1' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 401,
    statusText: 'Unauthorized',
    body: { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
  },
  {
    name: 'azure embeddings on a resource',
    provider: 'azure',
    settings: { apiKey: 'az-key', resourceName: 'my-res' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a', 'b'], headers: UA, providerOptions: { openai: { dimensions: 1024 } } },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings with an api version',
    provider: 'azure',
    settings: { apiKey: 'az-key', resourceName: 'my-res', apiVersion: '2024-10-21' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings through a gateway',
    provider: 'azure',
    settings: { apiKey: 'managed', baseURL: 'https://gateway.example.com/llm/azure/openai/v1' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings on an azure base url',
    provider: 'azure',
    settings: { apiKey: 'az-key', baseURL: 'https://my-res.openai.azure.com/openai/' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings on a versioned azure base url',
    provider: 'azure',
    settings: { apiKey: 'az-key', baseURL: 'https://my-res.openai.azure.com/openai/v1' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings on a foundry project',
    provider: 'azure',
    settings: { apiKey: 'az-key', baseURL: 'https://my-res.services.ai.azure.com/api/projects/p1' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings with an invalid resource name',
    provider: 'azure',
    settings: { apiKey: 'az-key', resourceName: 'bad/name' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 200,
    body: EMBEDDING_OK,
  },
  {
    name: 'azure embeddings refused',
    provider: 'azure',
    settings: { apiKey: 'az-key', resourceName: 'my-res' },
    modelId: 'text-embedding-3-small',
    options: { values: ['a'] },
    status: 404,
    statusText: 'Not Found',
    body: { error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } },
  },
];

const embeddings = [];
for (const testCase of embeddingCases) {
  let captured;
  const text = JSON.stringify(testCase.body);
  const fetch = async (url, init) => {
    captured = { url, headers: stripRuntimeAgent(init.headers), body: init.body };
    return new Response(text, {
      status: testCase.status,
      statusText: testCase.statusText ?? 'OK',
      headers: { 'content-type': 'application/json' },
    });
  };
  const provider =
    testCase.provider === 'openai'
      ? createOpenAI({ ...testCase.settings, fetch })
      : createAzure({ ...testCase.settings, fetch });
  const model = provider.embedding(testCase.modelId);
  const entry = {
    name: testCase.name,
    provider: testCase.provider,
    settings: testCase.settings,
    modelId: testCase.modelId,
    options: testCase.options,
    status: testCase.status,
    statusText: testCase.statusText ?? 'OK',
    responseBody: text,
    modelProvider: model.provider,
    maxEmbeddingsPerCall: model.maxEmbeddingsPerCall,
  };
  try {
    const result = await model.doEmbed(testCase.options);
    Object.assign(entry, { result: json(result) });
  } catch (error) {
    entry.error = json(errorFields(error));
  }
  if (captured) Object.assign(entry, { url: captured.url, headers: captured.headers, body: captured.body });
  embeddings.push(entry);
}

const toolSearch = createOpenAI({ apiKey: 'sk-test' }).tools.toolSearch({
  execution: 'client',
  description: 'Load deferred tools.',
  parameters: { type: 'object' },
});

writeFileSync(
  join(here, 'openai_sdk.json'),
  `${JSON.stringify(
    {
      sdkVersions: { openai: OPENAI_VERSION, azure: AZURE_VERSION },
      toolSearch: {
        type: toolSearch.type,
        id: toolSearch.id,
        args: toolSearch.args,
        inputSchema: await asSchema(toolSearch.inputSchema).jsonSchema,
      },
      requests,
      responses,
      embeddings,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `wrote ${requests.length} requests, ${responses.length} responses and ${embeddings.length} embedding calls`,
);
