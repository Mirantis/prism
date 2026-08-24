/**
 * OpenRouter Provider Tests
 *
 * OpenRouter rides the same OpenAI-compatible SDK surface as the openai
 * provider, so what is worth asserting is what differs: which endpoint it
 * lands on in each mode, which credential it sends, and that it still hands
 * back a provider with the OpenAI surface's gate knobs.
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
    config.openrouterApiKey = 'sk-or-test';
    config.openrouterBaseUrl = undefined;
    vi.clearAllMocks();
  });

  it('direct routing: no mount → openrouter.ai, not the SDK default', () => {
    // The SDK's own default is api.openai.com, where a `vendor/model` id does
    // not resolve — so the direct endpoint has to be spelled out.
    createOpenRouterProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-or-test',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });

  it('direct routing: OPENROUTER_BASE_URL overrides the endpoint', () => {
    config.openrouterBaseUrl = 'https://proxy.example/openrouter/v1';
    createOpenRouterProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://proxy.example/openrouter/v1' }),
    );
  });

  it('a __nexus_cred sentinel key reaches the SDK verbatim', () => {
    config.openrouterApiKey = '__nexus_cred:00000000-0000-0000-0000-000000000000__';
    createOpenRouterProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '__nexus_cred:00000000-0000-0000-0000-000000000000__' }),
    );
  });

  it('gateway routing: the mount wins over the direct endpoint', () => {
    config.openrouterBaseUrl = 'https://proxy.example/openrouter/v1';
    createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gateway.example/llm/openrouter/openai/v1' }),
    );
  });

  it('gateway routing without a local key: falls back to a decoy apiKey', () => {
    // The gateway holds the OpenRouter credential and injects it outbound; an
    // OpenAI key in the environment is a different vendor's and is never sent.
    config.openrouterApiKey = undefined;
    config.openaiApiKey = 'sk-test';
    createOpenRouterProvider('https://gateway.example/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('dispatches vendor-qualified chat model IDs through the client', () => {
    const provider = createOpenRouterProvider();
    provider('anthropic/claude-sonnet-5');
    expect(mockOpenAiModel).toHaveBeenCalledWith('anthropic/claude-sonnet-5');
  });

  it('dispatches embeddings through .embedding on the same client', () => {
    const provider = createOpenRouterProvider();
    provider.embedding('openai/text-embedding-3-small');
    expect(mockEmbeddingFn).toHaveBeenCalledWith('openai/text-embedding-3-small');
    expect(mockOpenAiModel).not.toHaveBeenCalled();
  });

  it('carries the OpenAI surface’s gate knobs', () => {
    // The defaults are `openai/*` models, so the same GPT-5.x constraints
    // apply: reasoning off, a 16-token floor, and no explicit temperature.
    const provider = createOpenRouterProvider();
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
    config.openrouterApiKey = 'sk-or-test';
    config.nexusOpenRouterBaseUrl = null;
    config.openrouterEmbeddingModelId = '';
  });

  it('true with key + model (direct)', () => {
    expect(isOpenRouterConfigured()).toBe(true);
  });

  it('true with model + gateway mount and NO key (gateway holds the key)', () => {
    config.openrouterApiKey = undefined;
    config.nexusOpenRouterBaseUrl = 'https://gateway.example/llm/openrouter/openai/v1';
    expect(isOpenRouterConfigured()).toBe(true);
  });

  it('does not require embedding config (OpenRouter ships no default one)', () => {
    expect(config.openrouterEmbeddingModelId).toBe('');
    expect(isOpenRouterConfigured()).toBe(true);
  });

  it('false without a key when there is no gateway mount', () => {
    config.openrouterApiKey = undefined;
    expect(isOpenRouterConfigured()).toBe(false);
  });

  it('false without a chat model id', () => {
    config.openrouterModelId = '';
    expect(isOpenRouterConfigured()).toBe(false);
  });
});
