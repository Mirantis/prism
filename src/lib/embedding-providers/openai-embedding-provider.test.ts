/**
 * OpenAI embedding provider tests — text-embedding-3 on the same surface and
 * key as the openai chat provider, with the dimensions fragment under the
 * `openai` key.
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

import { createOpenAiEmbeddingProvider } from './openai-embedding-provider';

describe('createOpenAiEmbeddingProvider', () => {
  beforeEach(() => {
    config.openaiApiKey = 'sk-test';
    vi.clearAllMocks();
  });

  it('no endpoint → the SDK default (api.openai.com)', () => {
    createOpenAiEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test', baseURL: undefined });
  });

  it('sends requests to the endpoint it is given', () => {
    // OPENAI_BASE_URL is one variable for the whole OpenAI surface, so the
    // embedding leg follows the override the chat leg follows.
    createOpenAiEmbeddingProvider('https://openai.example/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openai.example/v1' }),
    );
  });

  it('a gateway endpoint without a local key: falls back to a decoy apiKey', () => {
    config.openaiApiKey = undefined;
    createOpenAiEmbeddingProvider('https://gateway.example.com/llm/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'managed' }));
  });

  it('an endpoint off the gateway host without a key sends no decoy', () => {
    // A decoy would promise a credential injection that nothing performs.
    config.openaiApiKey = undefined;
    createOpenAiEmbeddingProvider('https://openai.example/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('no endpoint and no key passes undefined (SDK env fallback), no decoy', () => {
    config.openaiApiKey = undefined;
    createOpenAiEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('a __nexus_cred sentinel key reaches the SDK verbatim', () => {
    config.openaiApiKey = '__nexus_cred:00000000-0000-0000-0000-000000000000__';
    createOpenAiEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '__nexus_cred:00000000-0000-0000-0000-000000000000__' }),
    );
  });

  it('delegates model lookup to the openai provider', () => {
    createOpenAiEmbeddingProvider().model('text-embedding-3-small');
    expect(mockOpenAiProvider.embedding).toHaveBeenCalledWith('text-embedding-3-small');
  });

  it('declares the dimensions fragment under the openai key', () => {
    expect(createOpenAiEmbeddingProvider().providerOptions).toEqual({
      openai: { dimensions: 1024 },
    });
  });
});
