/**
 * Azure Provider Tests — Claude via Microsoft Foundry
 *
 * Chat/classification must dispatch to @ai-sdk/anthropic (Foundry Anthropic
 * Messages endpoint).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../config';

const { mockCreateAnthropic, mockAnthropicModel } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
  return {
    mockAnthropicModel,
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
  };
});

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mockCreateAnthropic,
}));

import { createAzureProvider, isAzureConfigured } from './azure-provider';

describe('createAzureProvider', () => {
  const FOUNDRY = 'https://my-resource.services.ai.azure.com/anthropic/v1';

  beforeEach(() => {
    config.azureApiKey = 'azure-key';
    config.azureResourceName = 'my-resource';
    vi.clearAllMocks();
  });

  it('sends requests to the endpoint it is given', () => {
    createAzureProvider(FOUNDRY);

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'azure-key',
      baseURL: FOUNDRY,
    });
  });

  it('a gateway endpoint without a local key: falls back to a decoy apiKey (the gateway injects the real one)', () => {
    config.azureApiKey = undefined;
    createAzureProvider('https://gateway.example.com/llm/azure/anthropic/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an override on the gateway host also gets the decoy, mount or not', () => {
    config.azureApiKey = undefined;
    createAzureProvider('https://gateway.example.com/projects/p/llm/azure/anthropic/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an endpoint off the gateway host without a key sends no decoy', () => {
    // A decoy would promise a credential injection that nothing performs.
    config.azureApiKey = undefined;
    createAzureProvider(FOUNDRY);

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: undefined }),
    );
  });

  it('chat model IDs (deployment names) dispatch through the anthropic provider', () => {
    const provider = createAzureProvider(FOUNDRY);
    provider('claude-opus-4-8');
    expect(mockAnthropicModel).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('asks for the tool-based JSON path — Foundry rejects native structured output', () => {
    expect(createAzureProvider(FOUNDRY).structuredOutputOptions).toEqual({
      anthropic: { structuredOutputMode: 'jsonTool' },
    });
  });
});

describe('isAzureConfigured', () => {
  beforeEach(() => {
    config.azureModelId = 'claude-opus-4-8';
    config.azureApiKey = 'azure-key';
    config.azureDirectEndpoint = 'https://my-resource.services.ai.azure.com/anthropic/v1';
    config.nexusAzureBaseUrl = null;
  });

  it('true with deployment + key + Foundry endpoint (direct)', () => {
    expect(isAzureConfigured()).toBe(true);
  });

  it('true with deployment + gateway base URL and NO key/resource (gateway holds the key)', () => {
    config.azureDirectEndpoint = undefined;
    config.azureApiKey = undefined;
    config.nexusAzureBaseUrl = 'https://gateway.example.com/llm/azure/anthropic/v1';
    expect(isAzureConfigured()).toBe(true);
  });

  it('false without a chat endpoint (neither Foundry URL nor gateway URL)', () => {
    config.azureDirectEndpoint = undefined;
    config.nexusAzureBaseUrl = null;
    expect(isAzureConfigured()).toBe(false);
  });

  it('false without an api-key', () => {
    config.azureApiKey = undefined;
    expect(isAzureConfigured()).toBe(false);
  });

  it('false without a chat deployment', () => {
    config.azureModelId = '';
    expect(isAzureConfigured()).toBe(false);
  });
});
