/**
 * OpenRouter Provider Tests
 *
 * OpenRouter rides the same OpenAI-compatible SDK surface as the openai
 * provider, so what is worth asserting is what differs: the mount it is
 * pointed at, the absence of a direct path, and that it still hands back a
 * provider with the OpenAI surface's gate knobs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../config';

const { mockCreateOpenAI, mockOpenAiModel, mockEmbeddingFn } = vi.hoisted(() => {
  const mockEmbeddingFn = vi.fn((modelId: string) => ({ kind: 'embedding', modelId }));
  const mockOpenAiModel = Object.assign(
    vi.fn((modelId: string) => ({ provider: 'openai', modelId })),
    { embedding: mockEmbeddingFn },
  );
  return {
    mockOpenAiModel,
    mockEmbeddingFn,
    mockCreateOpenAI: vi.fn(() => mockOpenAiModel),
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

import { createOpenRouterProvider, isOpenRouterConfigured } from './openrouter-provider';

describe('createOpenRouterProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('points the client at the OpenRouter mount it is given', () => {
    createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gateway.example/llm/openrouter/openai/v1' }),
    );
  });

  it('sends a decoy key — the gateway injects the real OpenRouter credential', () => {
    // Even with an OpenAI key in the environment: it is a credential for a
    // different vendor, and this mount never wants it.
    config.openaiApiKey = 'sk-test';
    createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('dispatches vendor-qualified chat model IDs through the client', () => {
    const provider = createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    provider('anthropic/claude-sonnet-5');
    expect(mockOpenAiModel).toHaveBeenCalledWith('anthropic/claude-sonnet-5');
  });

  it('dispatches embeddings through .embedding on the same client', () => {
    const provider = createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    provider.embedding('openai/text-embedding-3-small');
    expect(mockEmbeddingFn).toHaveBeenCalledWith('openai/text-embedding-3-small');
    expect(mockOpenAiModel).not.toHaveBeenCalled();
  });

  it('carries the OpenAI surface’s gate knobs', () => {
    // The defaults are `openai/*` models, so the same GPT-5.x constraints
    // apply: reasoning off, a 16-token floor, and no explicit temperature.
    const provider = createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    expect(provider.classificationProviderOptions).toEqual({
      openai: { reasoningEffort: 'none' },
    });
    expect(provider.classificationMinOutputTokens).toBe(16);
    expect(provider.classificationSamplingParams).toEqual({});
    expect(provider.cachePoint).toEqual({});
  });
});

describe('isOpenRouterConfigured', () => {
  beforeEach(() => {
    config.openrouterModelId = 'openai/gpt-5.6-sol';
    config.nexusOpenRouterBaseUrl = 'https://gateway.example/llm/openrouter/openai/v1';
  });

  it('true with a model id and the OpenRouter mount', () => {
    expect(isOpenRouterConfigured()).toBe(true);
  });

  it('false without the mount — there is no direct OpenRouter path', () => {
    // The gateway holds the credential; a sandbox has none, and reaching
    // openrouter.ai directly would be unmetered spend.
    config.nexusOpenRouterBaseUrl = null;
    expect(isOpenRouterConfigured()).toBe(false);
  });

  it('false without a chat model id', () => {
    config.openrouterModelId = '';
    expect(isOpenRouterConfigured()).toBe(false);
  });
});
