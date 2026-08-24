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
    config.openaiBaseUrl = undefined;
    vi.clearAllMocks();
  });

  it('direct routing: no baseURL → the SDK default (api.openai.com)', () => {
    createOpenAiEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test', baseURL: undefined });
  });

  it('direct routing: OPENAI_BASE_URL overrides the endpoint', () => {
    config.openaiBaseUrl = 'https://gw.example/openai/v1';
    createOpenAiEmbeddingProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gw.example/openai/v1' }),
    );
  });

  it('Nexus routing: the mount wins over OPENAI_BASE_URL', () => {
    config.openaiBaseUrl = 'https://gw.example/openai/v1';
    createOpenAiEmbeddingProvider('https://nexus.example/llm/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://nexus.example/llm/openai/v1' }),
    );
  });

  it('Nexus routing without a local key: falls back to a decoy apiKey', () => {
    config.openaiApiKey = undefined;
    createOpenAiEmbeddingProvider('https://nexus.example/llm/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'managed' }));
  });

  it('direct routing without a key passes undefined (SDK env fallback), no decoy', () => {
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
