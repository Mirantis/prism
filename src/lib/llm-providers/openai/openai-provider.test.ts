/**
 * OpenAI Provider Tests — the official OpenAI API
 *
 * One surface: chat, classification and embeddings all dispatch through the
 * same @ai-sdk/openai client, direct or through the Lens Agents openai mount.
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

import { createOpenAiProvider, isOpenAiConfigured } from './openai-provider';

describe('createOpenAiProvider', () => {
  beforeEach(() => {
    config.openaiApiKey = 'sk-test';
    config.openaiBaseUrl = undefined;
    vi.clearAllMocks();
  });

  it('direct routing: no baseURL → the SDK default (api.openai.com)', () => {
    createOpenAiProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test', baseURL: undefined });
  });

  it('direct routing: OPENAI_BASE_URL overrides the endpoint', () => {
    config.openaiBaseUrl = 'https://gw.example/openai/v1';
    createOpenAiProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gw.example/openai/v1' }),
    );
  });

  it('Gateway routing: the mount wins over OPENAI_BASE_URL', () => {
    config.openaiBaseUrl = 'https://gw.example/openai/v1';
    createOpenAiProvider('https://gateway.example/llm/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gateway.example/llm/openai/v1' }),
    );
  });

  it('Gateway routing without a local key: falls back to a decoy apiKey (gateway injects the real one)', () => {
    config.openaiApiKey = undefined;
    createOpenAiProvider('https://gateway.example/llm/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('direct routing without a key passes undefined (SDK env fallback), no decoy', () => {
    config.openaiApiKey = undefined;
    createOpenAiProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('a __nexus_cred sentinel key reaches the SDK verbatim', () => {
    config.openaiApiKey = '__nexus_cred:00000000-0000-0000-0000-000000000000__';
    createOpenAiProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '__nexus_cred:00000000-0000-0000-0000-000000000000__' }),
    );
  });

  it('chat model IDs dispatch through the openai client', () => {
    const provider = createOpenAiProvider();
    provider('gpt-5.6-sol');
    expect(mockOpenAiModel).toHaveBeenCalledWith('gpt-5.6-sol');
  });

  it('embeddings dispatch through .embedding on the same client', () => {
    const provider = createOpenAiProvider();
    provider.embedding('text-embedding-3-small');
    expect(mockEmbeddingFn).toHaveBeenCalledWith('text-embedding-3-small');
    expect(mockOpenAiModel).not.toHaveBeenCalled();
  });

  it('declares the empty cache-point fragment — OpenAI caching is automatic', () => {
    expect(createOpenAiProvider().cachePoint).toEqual({});
  });

  it('declares no structuredOutputOptions — the SDK native path works', () => {
    expect(createOpenAiProvider().structuredOutputOptions).toBeUndefined();
  });

  it('pins classification calls to reasoningEffort none', () => {
    expect(createOpenAiProvider().classificationProviderOptions).toEqual({
      openai: { reasoningEffort: 'none' },
    });
  });

  it('declares the Responses API output-token floor for gate calls', () => {
    expect(createOpenAiProvider().classificationMinOutputTokens).toBe(16);
  });

  it('declares empty gate sampling params — GPT-5.x rejects or strips temperature', () => {
    expect(createOpenAiProvider().classificationSamplingParams).toEqual({});
  });
});

describe('isOpenAiConfigured', () => {
  beforeEach(() => {
    config.openaiModelId = 'gpt-5.6-sol';
    config.openaiApiKey = 'sk-test';
    config.nexusOpenAiBaseUrl = null;
    config.openaiEmbeddingModelId = '';
  });

  it('true with key + model (direct)', () => {
    expect(isOpenAiConfigured()).toBe(true);
  });

  it('true with model + gateway mount and NO key (gateway holds the key)', () => {
    config.openaiApiKey = undefined;
    config.nexusOpenAiBaseUrl = 'https://gateway.example/llm/openai/v1';
    expect(isOpenAiConfigured()).toBe(true);
  });

  it('does not require embedding config (embeddings fail-open)', () => {
    config.openaiEmbeddingModelId = '';
    expect(isOpenAiConfigured()).toBe(true);
  });

  it('false without a key when there is no gateway mount', () => {
    config.openaiApiKey = undefined;
    expect(isOpenAiConfigured()).toBe(false);
  });

  it('false without a chat model id', () => {
    config.openaiModelId = '';
    expect(isOpenAiConfigured()).toBe(false);
  });
});
