/**
 * OpenAI Provider Tests — the official OpenAI API
 *
 * Chat and classification dispatch through the same @ai-sdk/openai client,
 * direct or through the Mirantis Agent Platform openai mount.
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

import { createOpenAiProvider, missingOpenAiSettings } from './openai-provider';
import { OPENAI_DEFERRED_TOOLS } from '../deferred-tools';
import { cacheRequestOptions, cacheTtlMs } from '../llm-provider';

describe('createOpenAiProvider', () => {
  beforeEach(() => {
    config.openaiApiKey = 'sk-test';
    vi.clearAllMocks();
  });

  it('no endpoint → the SDK default (api.openai.com)', () => {
    createOpenAiProvider();
    expect(mockCreateOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test', baseURL: undefined });
  });

  it('sends requests to the endpoint it is given', () => {
    createOpenAiProvider('https://openai.example/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openai.example/v1' }),
    );
  });

  it('a gateway endpoint without a local key: falls back to a decoy apiKey (the gateway injects the real one)', () => {
    config.openaiApiKey = undefined;
    createOpenAiProvider('https://gateway.example.com/llm/openai/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an override on the gateway host also gets the decoy, mount or not', () => {
    // The endpoint an operator names on the gateway host is still served by the
    // gateway, which holds the vendor credential.
    config.openaiApiKey = undefined;
    createOpenAiProvider('https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an endpoint off the gateway host without a key sends no decoy', () => {
    // The decoy means "the gateway injects the real key". An endpoint the gateway
    // does not serve gets no such promise, so the SDK reports the missing key.
    config.openaiApiKey = undefined;
    createOpenAiProvider('https://openai.example/v1');
    expect(mockCreateOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('no endpoint and no key passes undefined (SDK env fallback), no decoy', () => {
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

  it('declares the empty cache-point fragment — OpenAI caching is automatic', () => {
    expect(createOpenAiProvider().cachePoint('gpt-5.6')).toEqual({});
  });

  it('asks for a 12-hour entry under 1h and sends nothing at the default', () => {
    const provider = createOpenAiProvider();
    expect(cacheRequestOptions(provider, 'gpt-5.6-sol', '5m')).toEqual({});
    expect(cacheRequestOptions(provider, 'gpt-5.6-sol', '5m', false)).toEqual({});
    expect(cacheRequestOptions(provider, 'gpt-5.6-sol', '1h')).toEqual({
      openai: { promptCacheOptions: { ttl: '12h' } },
    });
    // Explicit mode with no breakpoint writes nothing: a live gpt-5.6-sol request
    // reported cache_write_tokens 0 where the same prompt in implicit mode wrote 6,022.
    expect(cacheRequestOptions(provider, 'gpt-5.6-sol', '1h', false)).toEqual({
      openai: { promptCacheOptions: { mode: 'explicit' } },
    });
    expect(cacheTtlMs(provider, 'gpt-5.6-sol', '5m')).toBe(30 * 60 * 1000);
    expect(cacheTtlMs(provider, 'gpt-5.6-sol', '1h')).toBe(12 * 60 * 60 * 1000);
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

describe('deferred tools', () => {
  // An id that names no GPT version defers; a refusal sends the request again in full.
  it.each(['gpt-5.6-sol', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-7', 'gpt-oss-120b', 'o3'])('defers tools on %s', (modelId) => {
    expect(createOpenAiProvider().deferredTools?.(modelId)).toBe(OPENAI_DEFERRED_TOOLS);
  });

  // gpt-5.5 rejects a client tool search; gpt-5.4 takes one only without stored responses.
  it.each(['gpt-5.5', 'gpt-5.4', 'gpt-5', 'gpt-4.1', 'gpt-4o'])('defers no tool on %s', (modelId) => {
    expect(createOpenAiProvider().deferredTools?.(modelId)).toBeUndefined();
  });
});

describe('missingOpenAiSettings', () => {
  beforeEach(() => {
    config.openaiApiKey = 'sk-test';
    config.nexusOpenAiBaseUrl = null;
  });

  it('none with a key (direct)', () => {
    expect(missingOpenAiSettings()).toEqual([]);
  });

  it('none on the gateway mount without a key (the gateway holds the key)', () => {
    config.openaiApiKey = undefined;
    config.nexusOpenAiBaseUrl = 'https://gateway.example.com/llm/openai/v1';
    expect(missingOpenAiSettings()).toEqual([]);
  });

  it('names the key when there is no gateway mount', () => {
    config.openaiApiKey = undefined;
    expect(missingOpenAiSettings()).toEqual(['OPENAI_API_KEY']);
  });
});
