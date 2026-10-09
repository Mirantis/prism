/**
 * The gates turn thinking off on Bedrock, Azure and Anthropic. These tests run
 * the real SDKs against a stubbed `fetch` and read the request body, because a
 * `providerOptions` namespace the SDK does not read is ignored without a warning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { config } from '../../config';
import type { LlmProvider } from './llm-provider';
import { createAnthropicProvider } from './anthropic/anthropic-provider';
import { createAzureProvider } from './azure/azure-provider';
import { createBedrockProvider } from './bedrock/bedrock-provider';
import { createBedrockMantleProvider } from './bedrock-mantle/bedrock-mantle-provider';

const MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: 'SUPPRESS' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 9 },
};

let bodies: Array<Record<string, unknown>>;

async function gateBody(provider: LlmProvider, modelId: string) {
  bodies = [];
  await generateText({
    model: provider(modelId),
    prompt: 'Classify.',
    maxOutputTokens: 16,
    providerOptions: provider.classificationProviderOptions ?? {},
    ...(provider.classificationSamplingParams ?? { temperature: 0 }),
  });
  return bodies[0];
}

describe('gate request body', () => {
  beforeEach(() => {
    config.anthropicApiKey = 'test-key';
    config.azureApiKey = 'test-key';
    config.bedrockApiKey = 'test-key';
    bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(MESSAGE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns thinking off and sends no temperature on Anthropic', async () => {
    const body = await gateBody(createAnthropicProvider(), 'claude-haiku-5-5');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('turns thinking off and sends no temperature on Azure', async () => {
    const body = await gateBody(
      createAzureProvider('https://my-resource.services.ai.azure.com/anthropic/v1'),
      'claude-haiku-5-5',
    );
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('turns thinking off and sends no temperature on Bedrock', async () => {
    const body = await gateBody(
      createBedrockProvider('https://gateway.example.com/llm/bedrock/us-east-1'),
      'global.anthropic.claude-haiku-5-5',
    );
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('temperature');
  });

  it('leaves Mantle with temperature 0 and no thinking field', async () => {
    const body = await gateBody(
      createBedrockMantleProvider('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1'),
      'anthropic.claude-haiku-4-5',
    );
    expect(body.temperature).toBe(0);
    expect(body).not.toHaveProperty('thinking');
  });
});
