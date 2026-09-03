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

const { mockCreateOpenAI, mockOpenAiModel } = vi.hoisted(() => {
  const mockOpenAiModel = vi.fn((modelId: string) => ({ provider: 'openai', modelId }));
  return {
    mockOpenAiModel,
    mockCreateOpenAI: vi.fn(() => mockOpenAiModel),
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mockCreateOpenAI,
}));

import { createOpenRouterProvider, isOpenRouterConfigured } from './openrouter-provider';

describe('createOpenRouterProvider', () => {
  const OPENROUTER_DIRECT = 'https://openrouter.ai/api/v1';

  beforeEach(() => {
    config.openrouterApiKey = 'sk-or-test';
    vi.clearAllMocks();
  });

  it('sends requests to the endpoint it is given', () => {
    // Config resolves openrouter.ai when nothing else applies, because the SDK's
    // own default is api.openai.com, where a `vendor/model` id does not resolve.
    createOpenRouterProvider(OPENROUTER_DIRECT);
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-or-test',
      baseURL: OPENROUTER_DIRECT,
    });
  });

  it('a __nexus_cred sentinel key reaches the SDK verbatim', () => {
    config.openrouterApiKey = '__nexus_cred:00000000-0000-0000-0000-000000000000__';
    createOpenRouterProvider(OPENROUTER_DIRECT);
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '__nexus_cred:00000000-0000-0000-0000-000000000000__' }),
    );
  });

  it('a gateway endpoint without a local key: falls back to a decoy apiKey', () => {
    // The gateway holds the OpenRouter credential and injects it outbound; an
    // OpenAI key in the environment is a different vendor's and is never sent.
    config.openrouterApiKey = undefined;
    config.openaiApiKey = 'sk-test';
    createOpenRouterProvider('https://gateway.example.com/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an override on the gateway host also gets the decoy, mount or not', () => {
    config.openrouterApiKey = undefined;
    createOpenRouterProvider('https://gateway.example.com/projects/p/llm/openrouter/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an endpoint off the gateway host without a key sends no decoy', () => {
    // A decoy would promise a credential injection that nothing performs.
    config.openrouterApiKey = undefined;
    createOpenRouterProvider('https://proxy.example/openrouter/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('dispatches vendor-qualified chat model IDs through the client', () => {
    const provider = createOpenRouterProvider(OPENROUTER_DIRECT);
    provider('anthropic/claude-sonnet-5');
    expect(mockOpenAiModel).toHaveBeenCalledWith('anthropic/claude-sonnet-5');
  });

  it('carries the OpenAI surface’s gate declarations', () => {
    // The defaults are `openai/*` models, so the same GPT-5.x constraints
    // apply: reasoning off, a 16-token floor, and no explicit temperature.
    const provider = createOpenRouterProvider(OPENROUTER_DIRECT);
    expect(provider.classificationProviderOptions).toEqual({
      openai: { reasoningEffort: 'none' },
    });
    expect(provider.classificationMinOutputTokens).toBe(16);
    expect(provider.classificationSamplingParams).toEqual({});
    expect(provider.cachePoint('openai/gpt-5.6')).toEqual({});
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
    config.nexusOpenRouterBaseUrl = 'https://gateway.example.com/llm/openrouter/openai/v1';
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
