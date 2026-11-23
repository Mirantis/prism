import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
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

// Two steps of one gpt-6.2-sol turn: reasoning and a tool call, then the answer.
const REASONING_STEP = readFileSync(path.join(__dirname, 'fixtures/reasoning-tool-call-stream.sse'), 'utf8');
const ANSWER_STEP = readFileSync(path.join(__dirname, 'fixtures/reasoning-answer-stream.sse'), 'utf8');

function answerWith(...bodies: string[]) {
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const body = bodies[Math.min(requests.length, bodies.length) - 1];
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
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

  it('fails a stream that closes before the response finished', async () => {
    const truncated = RECORDED_STREAM.slice(0, RECORDED_STREAM.indexOf('event: response.completed'));
    answerWith(truncated);

    await expect(
      generateText({ model: createChatGptProvider()('gpt-6.2-sol'), prompt: 'hi', tools: { add }, maxRetries: 0 }),
    ).rejects.toThrow(/before the response finished/);
  });

  it('retries a retryable error that arrives after output started', async () => {
    const afterText = RECORDED_STREAM.indexOf('event: response.output_text.done');
    const failed = `${RECORDED_STREAM.slice(0, afterText)}event: error\ndata: ${JSON.stringify({
      type: 'error',
      code: 'server_error',
      message: 'The server had an error while processing your request.',
      param: null,
      sequence_number: 6,
    })}\n\n`;
    const requests = answerWith(failed, RECORDED_STREAM);

    const result = await generateText({ model: createChatGptProvider()('gpt-6.2-sol'), prompt: 'hi', tools: { add } });

    expect(requests).toHaveLength(2);
    expect(result.text).toBe('adding');
  });

  // With store off, the API keeps no reasoning between steps: the next step
  // sends it back encrypted, or the model reasons without it.
  it("sends a step's encrypted reasoning back with the next step", async () => {
    const requests = answerWith(REASONING_STEP, ANSWER_STEP);
    const addAndRun = tool({ ...add, execute: async ({ a, b }: { a: number; b: number }) => String(a + b) });

    await generateText({
      model: createChatGptProvider()('gpt-6.2-sol'),
      prompt: 'hi',
      tools: { add: addAndRun },
      stopWhen: stepCountIs(2),
    });

    expect(requests).toHaveLength(2);
    expect(requests[1].input).toContainEqual(
      expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-reasoning-example' }),
    );
  });
});
