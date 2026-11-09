// Writes sdk_requests.json: what @ai-sdk/amazon-bedrock sends and returns for a set
// of call options, captured through a fake `fetch`, and aws4fetch signatures at a
// fixed time. The Rust port of the provider is tested against this file.
//
// Run with Node 24: node sdk_requests.mjs <node_modules dir>
// The node_modules dir must hold @ai-sdk/amazon-bedrock and aws4fetch (the versions
// the runtime pins).

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = process.argv[2];
if (!nodeModules) throw new Error('usage: node sdk_requests.mjs <node_modules dir>');
const load = path => import(pathToFileURL(join(nodeModules, path)).href);
const { createAmazonBedrock } = await load('@ai-sdk/amazon-bedrock/dist/index.js');
const { createAmazonBedrockAnthropic } = await load(
  '@ai-sdk/amazon-bedrock/dist/anthropic/index.js',
);
const { AwsV4Signer } = await load('aws4fetch/dist/aws4fetch.esm.mjs');

const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake png bytes', 'binary').toString('base64');
const JPEG = Buffer.from('fake jpeg bytes').toString('base64');
const PDF = Buffer.from('%PDF-1.4 fake pdf').toString('base64');
const DATE = 'Fri, 06 Nov 2026 12:00:00 GMT';

function fakeFetch(recorded, response) {
  return async (url, init) => {
    recorded.push({
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      body: init?.body == null ? null : String(init.body),
    });
    return new Response(
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
      {
        status: response.status ?? 200,
        statusText: response.statusText ?? 'OK',
        headers: response.headers ?? { 'content-type': 'application/json' },
      },
    );
  };
}

function sanitize(headers) {
  const out = { ...headers };
  if (out['user-agent'] != null) out['user-agent'] = '<user-agent>';
  return out;
}

async function record(makeModel, options, response) {
  const recorded = [];
  const model = makeModel(fakeFetch(recorded, response));
  let result;
  let error;
  try {
    result = await model.doGenerate(options);
  } catch (e) {
    error = {
      name: e.name,
      message: e.message,
      statusCode: e.statusCode,
      isRetryable: e.isRetryable,
      responseBody: e.responseBody,
      data: e.data,
    };
  }
  const request = recorded[0];
  return {
    provider: model.provider,
    supportedUrls: Object.fromEntries(
      Object.entries(model.supportedUrls ?? {}).map(([k, v]) => [k, v.map(String)]),
    ),
    request: request && {
      url: request.url,
      method: request.method,
      headers: sanitize(request.headers),
      body: request.body == null ? null : JSON.parse(request.body),
    },
    result: result && JSON.parse(JSON.stringify({ ...result, response: { ...result.response } })),
    error,
  };
}

const converseOk = (content, extra = {}) => ({
  headers: {
    'content-type': 'application/json',
    'x-amzn-requestid': 'req-1',
    date: DATE,
  },
  body: {
    output: { message: { role: 'assistant', content } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    metrics: { latencyMs: 120 },
    ...extra,
  },
});

const fn = (name, description, inputSchema, extra = {}) => ({
  type: 'function',
  name,
  description,
  inputSchema,
  ...extra,
});
const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
});

const converseCases = [
  {
    name: 'text',
    modelId: 'us.moonshotai.kimi-k3',
    options: {
      prompt: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
      maxOutputTokens: 1000,
      temperature: 0.3,
      headers: { 'user-agent': 'ai/7.0.137', 'x-extra': 'one' },
    },
    response: converseOk([{ text: 'Hi there' }]),
  },
  {
    name: 'tools',
    modelId: 'us.moonshotai.kimi-k3',
    options: {
      prompt: [
        { role: 'system', content: 'Use tools.' },
        { role: 'user', content: [{ type: 'text', text: 'Look at the screen.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'computer_screen',
              input: { zoom: 2 },
            },
            {
              type: 'tool-call',
              toolCallId: 'call-2',
              toolName: 'shell_exec',
              input: 'not an object',
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'computer_screen',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: '{"success":true}' },
                  {
                    type: 'file',
                    mediaType: 'image/jpeg',
                    data: { type: 'data', data: JPEG },
                  },
                ],
              },
            },
            {
              type: 'tool-result',
              toolCallId: 'call-2',
              toolName: 'shell_exec',
              output: { type: 'json', value: { exitCode: 0, out: 'ok' } },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-3',
              toolName: 'shell_exec',
              output: { type: 'error-text', value: 'boom' },
            },
            {
              type: 'tool-result',
              toolCallId: 'call-4',
              toolName: 'shell_exec',
              output: { type: 'execution-denied' },
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'And now?' }] },
      ],
      tools: [
        fn('computer_screen', 'Inspect the screen.', obj({ zoom: { type: 'number' } })),
        fn('shell_exec', '', obj({ command: { type: 'string' } }, ['command'])),
        fn('strict_tool', 'Strict.', obj({ a: { type: 'string' } }, ['a']), { strict: true }),
      ],
      toolChoice: { type: 'auto' },
    },
    response: converseOk(
      [
        { text: 'Running it.' },
        { toolUse: { toolUseId: 'tooluse_1', name: 'shell_exec', input: { command: 'ls' } } },
      ],
      {
        stopReason: 'tool_use',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 220,
          cacheReadInputTokens: 50,
          cacheWriteInputTokens: 50,
          cacheDetails: [{ inputTokens: 50, ttl: '5m' }],
        },
      },
    ),
  },
  {
    name: 'tool-choice-tool',
    modelId: 'meta.llama3-70b-instruct-v1:0',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Weather?' }] }],
      tools: [
        fn('weather', 'Weather.', obj({ city: { type: 'string' } })),
        fn('other', 'Other.', obj()),
        { type: 'provider', id: 'openai.web_search', name: 'web_search', args: {} },
      ],
      toolChoice: { type: 'tool', toolName: 'weather' },
    },
    response: converseOk([{ toolUse: { toolUseId: 't1', name: 'weather', input: {} } }], {
      stopReason: 'tool_use',
    }),
  },
  {
    name: 'tool-choice-required-and-none',
    modelId: 'meta.llama3-70b-instruct-v1:0',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Go' }] }],
      tools: [fn('weather', 'Weather.', obj())],
      toolChoice: { type: 'none' },
    },
    response: converseOk([{ text: 'ok' }]),
  },
  {
    name: 'tool-choice-required',
    modelId: 'meta.llama3-70b-instruct-v1:0',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Go' }] }],
      tools: [fn('weather', 'Weather.', obj())],
      toolChoice: { type: 'required' },
    },
    response: converseOk([{ text: 'ok' }]),
  },
  {
    name: 'json-response-format',
    modelId: 'us.moonshotai.kimi-k3',
    options: {
      prompt: [
        { role: 'system', content: 'Classify.' },
        { role: 'user', content: [{ type: 'text', text: 'Is this spam?' }] },
      ],
      maxOutputTokens: 16,
      temperature: 0,
      responseFormat: {
        type: 'json',
        schema: obj({ spam: { type: 'boolean' } }, ['spam']),
      },
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
    },
    response: converseOk(
      [{ toolUse: { toolUseId: 'tooluse_j', name: 'json', input: { spam: false } } }],
      { stopReason: 'tool_use' },
    ),
  },
  {
    name: 'cache-points',
    modelId: 'us.amazon.nova-pro-v1:0',
    options: {
      prompt: [
        {
          role: 'system',
          content: 'Stable prefix.',
          providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
        },
        { role: 'system', content: 'Second system.' },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'First',
              providerOptions: { amazonBedrock: { cachePoint: { type: 'default', ttl: '1h' } } },
            },
            { type: 'text', text: 'Second' },
          ],
          providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Answer' }],
          providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
        },
        { role: 'user', content: [{ type: 'text', text: 'Next' }] },
      ],
      providerOptions: {
        bedrock: {
          additionalModelRequestFields: { top_k: 5 },
          requestMetadata: { team: 'a' },
          serviceTier: 'flex',
          extraField: { passed: true },
        },
      },
    },
    response: converseOk([{ text: 'cached' }], {
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, cacheReadInputTokens: 100 },
      serviceTier: { type: 'flex' },
      performanceConfig: { latency: 'standard' },
      trace: { guardrail: {} },
    }),
  },
  {
    name: 'documents',
    modelId: 'us.amazon.nova-pro-v1:0',
    options: {
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read these.' },
            {
              type: 'file',
              mediaType: 'application/pdf',
              filename: 'Quarterly Report (Q3) — final!.pdf',
              data: { type: 'data', data: PDF },
              providerOptions: { bedrock: { citations: { enabled: true } } },
            },
            {
              type: 'file',
              mediaType: 'text/plain',
              data: { type: 'text', text: 'plain notes' },
            },
            {
              type: 'file',
              mediaType: 'text/markdown',
              filename: 'notes.md',
              data: { type: 'data', data: Buffer.from('# hi').toString('base64') },
            },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PNG } },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'url', url: new URL('s3://bucket/key.png') },
            },
          ],
        },
      ],
    },
    response: converseOk([
      {
        citationsContent: {
          content: [{ text: 'Cited one. ' }, { text: 'Cited two.' }, {}],
        },
      },
    ]),
  },
  {
    name: 'tool-content-without-tools',
    modelId: 'us.moonshotai.kimi-k3',
    options: {
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'x',
              output: { type: 'text', value: 'r' },
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Summarize' }] },
      ],
      toolChoice: { type: 'none' },
    },
    response: converseOk([{ text: 'Summary' }]),
  },
  {
    name: 'mistral',
    modelId: 'mistral.mistral-large-2402-v1:0',
    options: {
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tooluse_bpe71yCfRu2b5i-nKGDr5g',
              toolName: 'my.tool name',
              input: {},
            },
            { type: 'tool-call', toolCallId: 'abcDEF123', toolName: '...', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tooluse_bpe71yCfRu2b5i-nKGDr5g',
              toolName: 'my.tool name',
              output: { type: 'text', value: 'r' },
            },
            {
              type: 'tool-result',
              toolCallId: 'abcDEF123',
              toolName: '...',
              output: { type: 'text', value: 'r2' },
            },
          ],
        },
      ],
      tools: [fn('mytoolname', 'x', obj())],
    },
    response: converseOk(
      [{ toolUse: { toolUseId: 'tooluse_abc-def_ghi', name: 'mytoolname', input: {} } }],
      { stopReason: 'tool_use' },
    ),
  },
  {
    name: 'reasoning',
    modelId: 'us.deepseek.r1-v1:0',
    options: {
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Think' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: ' signed thought ',
              providerOptions: { bedrock: { signature: 'sig-1' } },
            },
            {
              type: 'reasoning',
              text: '',
              providerOptions: { amazonBedrock: { redactedData: 'red-1' } },
            },
            {
              type: 'reasoning',
              text: '',
              providerOptions: { bedrock: { redactedContent: 'enc-1' } },
            },
            { type: 'reasoning', text: 'unsigned' },
            { type: 'text', text: '   ' },
            { type: 'text', text: 'Answer ' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'More' }] },
        { role: 'assistant', content: [{ type: 'text', text: '  prefill  ' }] },
      ],
    },
    response: converseOk([
      { reasoningContent: { reasoningText: { text: 'thinking', signature: 'sig-2' } } },
      { reasoningContent: { reasoningText: { text: 'plain thinking' } } },
      { reasoningContent: { redactedReasoning: { data: 'red-2' } } },
      { reasoningContent: { redactedContent: 'enc-2' } },
      { text: 'Final' },
    ]),
  },
  {
    name: 'sampling-gpt-oss',
    modelId: 'openai.gpt-oss-120b-1:0',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      temperature: 1.5,
      topP: 0.9,
      topK: 40,
      stopSequences: ['END'],
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      seed: 7,
    },
    response: converseOk([{ text: 'ok' }], { stopReason: 'max_tokens' }),
  },
  {
    name: 'sampling-gpt',
    modelId: 'us.openai.gpt-5.6-luna',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      temperature: -0.5,
      topP: 0.9,
      stopSequences: ['END'],
    },
    response: converseOk([{ text: 'ok' }], { stopReason: 'guardrail_intervened' }),
  },
  {
    name: 'error-json',
    modelId: 'us.moonshotai.kimi-k3',
    options: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    response: {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' },
      body: { message: 'Invalid model', type: 'ValidationException' },
    },
  },
  {
    name: 'error-empty',
    modelId: 'us.moonshotai.kimi-k3',
    options: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    response: {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' },
      body: '',
    },
  },
  {
    name: 'error-not-json',
    modelId: 'us.moonshotai.kimi-k3',
    options: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    response: {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' },
      body: 'slow down',
    },
  },
  {
    name: 'invalid-response',
    modelId: 'us.moonshotai.kimi-k3',
    options: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    response: { headers: { 'content-type': 'application/json' }, body: { output: {} } },
  },
];

const anthropicOk = (content, extra = {}) => ({
  headers: {
    'content-type': 'application/json',
    'x-amzn-requestid': 'req-a',
    date: DATE,
  },
  body: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
    ...extra,
  },
});

const anthropicCases = [
  {
    name: 'anthropic-text',
    modelId: 'global.anthropic.claude-opus-5-5',
    options: {
      prompt: [
        {
          role: 'system',
          content: 'You are Prism.',
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
      maxOutputTokens: 16000,
      headers: { 'user-agent': 'ai/7.0.137' },
    },
    response: anthropicOk([{ type: 'text', text: 'Hi' }]),
  },
  {
    name: 'anthropic-tools',
    modelId: 'us.anthropic.claude-opus-4-7',
    options: {
      prompt: [
        { role: 'system', content: 'Use tools.' },
        { role: 'user', content: [{ type: 'text', text: 'Run ls' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'toolu_1', toolName: 'shell_exec', input: { command: 'ls' } }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'toolu_1',
              toolName: 'shell_exec',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: 'a.txt' },
                  { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: JPEG } },
                ],
              },
            },
          ],
        },
      ],
      tools: [
        fn('shell_exec', 'Run a command.', obj({ command: { type: 'string' } }, ['command'])),
        fn('memory_search', 'Search.', obj({ q: { type: 'string' } }), {
          providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
        }),
      ],
      toolChoice: { type: 'tool', toolName: 'shell_exec' },
      maxOutputTokens: 1000,
    },
    response: anthropicOk(
      [{ type: 'tool_use', id: 'toolu_2', name: 'shell_exec', input: { command: 'pwd' } }],
      {
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 7,
        },
      },
    ),
  },
  {
    name: 'anthropic-gate',
    modelId: 'global.anthropic.claude-haiku-5-5',
    options: {
      prompt: [
        { role: 'system', content: 'Answer yes or no.' },
        { role: 'user', content: [{ type: 'text', text: 'Is it?' }] },
      ],
      maxOutputTokens: 16,
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
    },
    response: anthropicOk([{ type: 'text', text: 'yes' }]),
  },
  {
    name: 'anthropic-json',
    modelId: 'global.anthropic.claude-haiku-5-5',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Classify' }] }],
      maxOutputTokens: 64,
      responseFormat: { type: 'json', schema: obj({ ok: { type: 'boolean' } }, ['ok']) },
      providerOptions: { anthropic: { thinking: { type: 'disabled' } } },
    },
    response: anthropicOk(
      [{ type: 'tool_use', id: 'toolu_j', name: 'json', input: { ok: true } }],
      { stop_reason: 'tool_use' },
    ),
  },
  {
    name: 'anthropic-deferred',
    modelId: 'global.anthropic.claude-opus-5-5',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [
        fn('shell_exec', 'Run.', obj()),
        fn('mcp__deferred', 'Deferred.', obj(), {
          providerOptions: { anthropic: { deferLoading: true } },
        }),
      ],
      maxOutputTokens: 100,
    },
    response: anthropicOk([{ type: 'text', text: 'ok' }]),
  },
  {
    name: 'anthropic-arn',
    modelId:
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      maxOutputTokens: 100,
    },
    response: anthropicOk([{ type: 'text', text: 'ok' }]),
  },
  {
    name: 'anthropic-error',
    modelId: 'global.anthropic.claude-opus-5-5',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      maxOutputTokens: 100,
    },
    response: {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' },
      body: { message: 'messages: text content blocks must be non-empty' },
    },
  },
  {
    name: 'anthropic-error-not-json',
    modelId: 'global.anthropic.claude-opus-5-5',
    options: {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      maxOutputTokens: 100,
    },
    response: {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'content-type': 'text/plain' },
      body: 'Too many tokens, please wait before trying again.',
    },
  },
];

const fixtures = { converse: [], anthropic: [], embedding: [], sigv4: [] };

for (const c of converseCases) {
  const out = await record(
    fetch =>
      createAmazonBedrock({ region: 'us-east-1', apiKey: 'test-key', fetch })(c.modelId),
    c.options,
    c.response,
  );
  fixtures.converse.push({ ...c, ...out, options: JSON.parse(JSON.stringify(c.options)) });
}

for (const c of anthropicCases) {
  const out = await record(
    fetch =>
      createAmazonBedrockAnthropic({ region: 'us-east-1', apiKey: 'test-key', fetch })(
        c.modelId,
      ),
    c.options,
    c.response,
  );
  fixtures.anthropic.push({ ...c, ...out });
}

// Embeddings
const embeddingCases = [
  {
    name: 'titan',
    modelId: 'amazon.titan-embed-text-v2:0',
    options: { values: ['hello world'], providerOptions: { bedrock: { dimensions: 1024 } } },
    response: {
      headers: { 'content-type': 'application/json' },
      body: { embedding: [0.1, -0.2, 0.5], inputTextTokenCount: 3 },
    },
  },
  {
    name: 'titan-no-options',
    modelId: 'amazon.titan-embed-text-v2:0',
    options: { values: ['x'] },
    response: {
      headers: { 'content-type': 'application/json' },
      body: { embedding: [1, 2], inputTextTokenCount: 1 },
    },
  },
  {
    name: 'cohere',
    modelId: 'us.cohere.embed-v4:0',
    options: { values: ['a', 'b'], dimensions: 512 },
    response: {
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-input-token-count': '4' },
      body: { embeddings: { float: [[0.1], [0.2]] } },
    },
  },
  {
    name: 'cohere-v3',
    modelId: 'cohere.embed-english-v3',
    options: { values: ['a'], providerOptions: { bedrock: { inputType: 'search_document' } } },
    response: {
      headers: { 'content-type': 'application/json' },
      body: { embeddings: [[0.3, 0.4]] },
    },
  },
  {
    name: 'nova',
    modelId: 'amazon.nova-2-multimodal-embeddings-v1:0',
    options: { values: ['a'] },
    response: {
      headers: { 'content-type': 'application/json' },
      body: { embeddings: [{ embeddingType: 'TEXT', embedding: [0.5] }], inputTokenCount: 2 },
    },
  },
  {
    name: 'titan-error',
    modelId: 'amazon.titan-embed-text-v2:0',
    options: { values: ['x'] },
    response: {
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'application/json' },
      body: { message: 'Access denied' },
    },
  },
];
for (const c of embeddingCases) {
  const recorded = [];
  const model = createAmazonBedrock({
    region: 'us-east-1',
    apiKey: 'test-key',
    fetch: fakeFetch(recorded, c.response),
  }).embedding(c.modelId);
  let result;
  let error;
  try {
    result = await model.doEmbed(c.options);
  } catch (e) {
    error = { name: e.name, message: e.message, statusCode: e.statusCode, isRetryable: e.isRetryable };
  }
  fixtures.embedding.push({
    ...c,
    maxEmbeddingsPerCall: model.maxEmbeddingsPerCall,
    request: {
      url: recorded[0].url,
      headers: sanitize(recorded[0].headers),
      body: JSON.parse(recorded[0].body),
    },
    result,
    error,
  });
}

// SigV4: the signer with a fixed time, as createSigV4FetchFunction calls it.
const sigv4Cases = [
  {
    name: 'converse-post',
    url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.moonshotai.kimi-k3/converse',
    headers: { 'content-type': 'application/json', 'user-agent': 'ai/7.0.137 ai-sdk-amazon-bedrock/5.0.113' },
    body: '{"messages":[{"role":"user","content":[{"text":"Hi"}]}]}',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    datetime: '20261106T120000Z',
  },
  {
    name: 'invoke-arn-with-session',
    url:
      'https://bedrock-runtime.eu-central-1.amazonaws.com/model/' +
      encodeURIComponent('arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-opus-4-7') +
      '/invoke',
    headers: {
      'content-type': 'application/json',
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'user-agent': 'x',
      'x-custom': '  spaced   value  ',
    },
    body: '{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":[]}',
    region: 'eu-central-1',
    accessKeyId: 'ASIAEXAMPLE',
    secretAccessKey: 'secret/with+chars',
    sessionToken: 'session-token-value',
    datetime: '20260101T000000Z',
  },
  {
    name: 'model-id-with-colon-and-query',
    url: 'https://gateway.example.com:8443/llm/bedrock/us-east-1/model/amazon.titan-embed-text-v2%3A0/invoke?b=2&a=1&a=0',
    headers: { 'content-type': 'application/json' },
    body: '{"inputText":"hello ü"}',
    region: 'us-east-1',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    datetime: '20261106T235959Z',
  },
];
for (const c of sigv4Cases) {
  const signer = new AwsV4Signer({
    url: c.url,
    method: 'POST',
    headers: Object.entries(c.headers),
    body: c.body,
    region: c.region,
    accessKeyId: c.accessKeyId,
    secretAccessKey: c.secretAccessKey,
    sessionToken: c.sessionToken,
    service: 'bedrock',
    datetime: c.datetime,
  });
  const signed = await signer.sign();
  fixtures.sigv4.push({
    ...c,
    canonicalString: await signer.canonicalString(),
    signedHeaders: Object.fromEntries([...signed.headers.entries()]),
  });
}

writeFileSync(join(here, 'sdk_requests.json'), JSON.stringify(fixtures, null, 2) + '\n');
console.log(
  'converse',
  fixtures.converse.length,
  'anthropic',
  fixtures.anthropic.length,
  'embedding',
  fixtures.embedding.length,
  'sigv4',
  fixtures.sigv4.length,
);
