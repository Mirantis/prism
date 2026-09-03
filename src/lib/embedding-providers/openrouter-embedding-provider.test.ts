/**
 * OpenRouter embedding provider tests — the OpenAI SDK at openrouter.ai, with
 * the dimensions fragment under the `openai` key (the SDK serving the call,
 * not the vendor's name).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const { mockCreateOpenAI, mockOpenAiProvider } = vi.hoisted(() => {
  const mockOpenAiProvider = {
    embedding: vi.fn((modelId: string) => ({ kind: 'embedding', modelId })),
  };
  return {
    mockOpenAiProvider,
    mockCreateOpenAI: vi.fn(() => mockOpenAiProvider),
  };
});

vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mockCreateOpenAI }));

import { createOpenRouterEmbeddingProvider } from './openrouter-embedding-provider';

describe('createOpenRouterEmbeddingProvider', () => {
  const OPENROUTER_DIRECT = 'https://openrouter.ai/api/v1';

  beforeEach(() => {
    config.openrouterApiKey = 'sk-or-test';
    vi.clearAllMocks();
  });

  it('sends requests to the endpoint it is given', () => {
    // OPENROUTER_BASE_URL is one variable for the whole surface, so the embedding
    // leg follows the override the chat leg follows; config resolves
    // openrouter.ai when nothing else applies.
    createOpenRouterEmbeddingProvider(OPENROUTER_DIRECT);
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-or-test',
      baseURL: OPENROUTER_DIRECT,
    });
  });

  it('a gateway endpoint without a local key falls back to a decoy', () => {
    config.openrouterApiKey = undefined;
    createOpenRouterEmbeddingProvider('https://gateway.example.com/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'managed',
      baseURL: 'https://gateway.example.com/llm/openrouter/openai/v1',
    });
  });

  it('an endpoint off the gateway host without a key sends no decoy', () => {
    // A decoy would promise a credential injection that nothing performs.
    config.openrouterApiKey = undefined;
    createOpenRouterEmbeddingProvider('https://proxy.example/openrouter/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('delegates model lookup to the openai provider', () => {
    createOpenRouterEmbeddingProvider(OPENROUTER_DIRECT).model('openai/text-embedding-3-small');
    expect(mockOpenAiProvider.embedding).toHaveBeenCalledWith('openai/text-embedding-3-small');
  });

  it('declares the dimensions fragment under the openai key — the serving SDK', () => {
    expect(createOpenRouterEmbeddingProvider(OPENROUTER_DIRECT).providerOptions).toEqual({
      openai: { dimensions: 1024 },
    });
  });
});
