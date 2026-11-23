import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateText, jsonSchema, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../services/chatgpt-auth.service', () => ({
  CHATGPT_API_RESOURCE: 'https://api.openai.com/v1',
  chatGptAuthService: { isSignedIn: () => true, getAccessToken: async () => 'token' },
}));

import { createChatGptProvider } from './chatgpt-provider';

// A gpt-6.2-sol stream recorded on a ChatGPT subscription, account identifiers replaced.
const RECORDED_STREAM = readFileSync(path.join(__dirname, 'fixtures/tool-call-stream.sse'), 'utf8');

const add = tool({
  description: 'add two numbers',
  inputSchema: jsonSchema<{ a: number; b: number }>({
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  }),
});

function answerWith(body: string, status = 200) {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof globalThis.fetch;
  return requests;
}

describe('ChatGPT subscription requests', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // The API answers 400 "Store must be set to false" and "Stream must be set
  // to true" to a subscription token that asks otherwise.
  it('sends a non-streaming call as a stream with store: false', async () => {
    const requests = answerWith(RECORDED_STREAM);

    await generateText({ model: createChatGptProvider()('gpt-6.2-sol'), prompt: 'hi', tools: { add } });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ store: false, stream: true });
  });

  it('returns the text and tool call the stream carried', async () => {
    answerWith(RECORDED_STREAM);

    const result = await generateText({ model: createChatGptProvider()('gpt-6.2-sol'), prompt: 'hi', tools: { add } });

    expect(result.text).toBe('adding');
    expect(result.toolCalls.map((call) => [call.toolName, call.input])).toEqual([['add', { a: 2, b: 3 }]]);
    expect(result.finishReason).toBe('tool-calls');
    expect(result.usage.totalTokens).toBe(91);
  });
});
