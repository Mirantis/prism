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
  beforeEach(() => {
    config.openrouterApiKey = 'sk-or-test';
    config.openrouterBaseUrl = undefined;
    vi.clearAllMocks();
  });

  it('direct routing: no baseURL → openrouter.ai, not the SDK default', () => {
    createOpenRouterEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-or-test',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });

  it('direct routing: OPENROUTER_BASE_URL overrides the endpoint', () => {
    config.openrouterBaseUrl = 'https://gw.example/openrouter/v1';
    createOpenRouterEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gw.example/openrouter/v1' }),
    );
  });

  it('gateway routing: the mount wins, and a missing key falls back to a decoy', () => {
    config.openrouterApiKey = undefined;
    createOpenRouterEmbeddingProvider('https://nexus.example/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'managed',
      baseURL: 'https://nexus.example/llm/openrouter/openai/v1',
    });
  });

  it('delegates model lookup to the openai provider', () => {
    createOpenRouterEmbeddingProvider().model('openai/text-embedding-3-small');
    expect(mockOpenAiProvider.embedding).toHaveBeenCalledWith('openai/text-embedding-3-small');
  });

  it('declares the dimensions fragment under the openai key — the serving SDK', () => {
    expect(createOpenRouterEmbeddingProvider().providerOptions).toEqual({
      openai: { dimensions: 1024 },
    });
  });
});
