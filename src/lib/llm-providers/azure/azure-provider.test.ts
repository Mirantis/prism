/**
 * Azure Provider Tests — Claude via Microsoft Foundry
 *
 * Chat/classification must dispatch to @ai-sdk/anthropic (Foundry Anthropic
 * Messages endpoint); embeddings to @ai-sdk/azure (Azure OpenAI).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../config';

const { mockCreateAnthropic, mockAnthropicModel, mockCreateAzure, mockOpenaiEmbeddingFn } =
  vi.hoisted(() => {
    const mockAnthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
    const mockOpenaiEmbeddingFn = vi.fn((modelId: string) => ({ kind: 'embedding', modelId }));
    const mockOpenaiProvider = Object.assign(
      vi.fn((modelId: string) => ({ provider: 'azure-openai', modelId })),
      { embedding: mockOpenaiEmbeddingFn },
    );
    return {
      mockAnthropicModel,
      mockOpenaiEmbeddingFn,
      mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
      mockCreateAzure: vi.fn(() => mockOpenaiProvider),
    };
  });

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mockCreateAnthropic,
}));
vi.mock('@ai-sdk/azure', () => ({
  createAzure: mockCreateAzure,
}));

import { createAzureProvider, isAzureConfigured } from './azure-provider';

describe('createAzureProvider', () => {
  beforeEach(() => {
    config.azureApiKey = 'azure-key';
    config.azureResourceName = 'my-resource';
    config.azureFoundryBaseUrl = 'https://my-resource.services.ai.azure.com/anthropic/v1';
    config.azureApiVersion = undefined;
    config.nexusAzureOpenAiBaseUrl = null;
    vi.clearAllMocks();
  });

  it('direct routing: chat provider gets the Foundry Anthropic baseURL', () => {
    createAzureProvider();

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'azure-key',
      baseURL: 'https://my-resource.services.ai.azure.com/anthropic/v1',
    });
  });

  it('Nexus routing: an explicit baseURL overrides the Foundry endpoint', () => {
    createAzureProvider('https://nexus.example/llm/azure/anthropic/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://nexus.example/llm/azure/anthropic/v1' }),
    );
  });

  it('Nexus routing without a local key: falls back to a decoy apiKey (gateway injects the real one)', () => {
    config.azureApiKey = undefined;
    createAzureProvider('https://nexus.example/llm/azure/anthropic/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('Nexus routing: embeddings ride the gateway openai mount (no resourceName)', () => {
    config.azureApiKey = undefined;
    config.nexusAzureOpenAiBaseUrl = 'https://nexus.example/llm/azure/openai/v1';
    createAzureProvider('https://nexus.example/llm/azure/anthropic/v1');

    const opts = mockCreateAzure.mock.calls[0][0];
    expect(opts).toMatchObject({
      apiKey: 'nexus-managed',
      baseURL: 'https://nexus.example/llm/azure/openai/v1',
    });
    expect(opts).not.toHaveProperty('resourceName');
  });

  it('direct routing without a key passes undefined (SDK env fallback), no decoy', () => {
    config.azureApiKey = undefined;
    createAzureProvider();

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: undefined }),
    );
  });

  it('chat model IDs (deployment names) dispatch through the anthropic provider', () => {
    const provider = createAzureProvider();
    provider('claude-opus-4-8');
    expect(mockAnthropicModel).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('embeddings dispatch through the Azure OpenAI provider (resourceName)', () => {
    const provider = createAzureProvider();
    provider.embedding('text-embed-3-deployment');

    expect(mockCreateAzure).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'azure-key', resourceName: 'my-resource' }),
    );
    expect(mockOpenaiEmbeddingFn).toHaveBeenCalledWith('text-embed-3-deployment');
    expect(mockAnthropicModel).not.toHaveBeenCalled();
  });

  it('forwards apiVersion to the embeddings provider when set', () => {
    config.azureApiVersion = '2024-10-21';
    createAzureProvider();
    expect(mockCreateAzure).toHaveBeenCalledWith(
      expect.objectContaining({ apiVersion: '2024-10-21' }),
    );
  });
});

describe('isAzureConfigured', () => {
  beforeEach(() => {
    config.azureModelId = 'claude-opus-4-8';
    config.azureApiKey = 'azure-key';
    config.azureFoundryBaseUrl = 'https://my-resource.services.ai.azure.com/anthropic/v1';
    config.nexusAzureBaseUrl = null;
    config.azureEmbeddingModelId = '';
  });

  it('true with deployment + key + Foundry endpoint (direct)', () => {
    expect(isAzureConfigured()).toBe(true);
  });

  it('true with deployment + nexus base URL and NO key/resource (gateway holds the key)', () => {
    config.azureFoundryBaseUrl = undefined;
    config.azureApiKey = undefined;
    config.nexusAzureBaseUrl = 'https://nexus.example/llm/azure/anthropic/v1';
    expect(isAzureConfigured()).toBe(true);
  });

  it('does not require embedding config (embeddings fail-open)', () => {
    config.azureEmbeddingModelId = '';
    expect(isAzureConfigured()).toBe(true);
  });

  it('false without a chat endpoint (neither Foundry URL nor nexus URL)', () => {
    config.azureFoundryBaseUrl = undefined;
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
