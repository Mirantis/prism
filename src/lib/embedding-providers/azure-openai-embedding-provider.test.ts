/**
 * Azure OpenAI embedding provider tests — a text-embedding-3 deployment on
 * the Foundry resource, with the dimensions fragment under the `openai` key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const { mockCreateAzure, mockAzureProvider } = vi.hoisted(() => {
  const mockAzureProvider = {
    embedding: vi.fn((modelId: string) => ({ kind: 'embedding', modelId })),
  };
  return {
    mockAzureProvider,
    mockCreateAzure: vi.fn(() => mockAzureProvider),
  };
});

vi.mock('@ai-sdk/azure', () => ({ createAzure: mockCreateAzure }));

import { createAzureOpenAiEmbeddingProvider } from './azure-openai-embedding-provider';

describe('createAzureOpenAiEmbeddingProvider', () => {
  beforeEach(() => {
    config.azureApiKey = 'azure-key';
    config.azureResourceName = 'my-resource';
    config.azureApiVersion = undefined;
    vi.clearAllMocks();
  });

  it('direct routing: derives the endpoint from the resource name', () => {
    createAzureOpenAiEmbeddingProvider();

    const opts = mockCreateAzure.mock.calls[0][0];
    expect(opts).toMatchObject({ apiKey: 'azure-key', resourceName: 'my-resource' });
    expect(opts).not.toHaveProperty('baseURL');
  });

  it('forwards apiVersion when set', () => {
    config.azureApiVersion = '2024-10-21';
    createAzureOpenAiEmbeddingProvider();

    expect(mockCreateAzure).toHaveBeenCalledWith(
      expect.objectContaining({ apiVersion: '2024-10-21' }),
    );
  });

  it('Nexus routing: rides the gateway openai mount (no resourceName)', () => {
    config.azureApiKey = undefined;
    createAzureOpenAiEmbeddingProvider('https://nexus.example/llm/azure/openai/v1');

    const opts = mockCreateAzure.mock.calls[0][0];
    expect(opts).toMatchObject({
      apiKey: 'managed',
      baseURL: 'https://nexus.example/llm/azure/openai/v1',
    });
    expect(opts).not.toHaveProperty('resourceName');
  });

  it('Nexus routing keeps a local key when one is set', () => {
    createAzureOpenAiEmbeddingProvider('https://nexus.example/llm/azure/openai/v1');

    expect(mockCreateAzure).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'azure-key' }));
  });

  it('delegates model lookup to the azure provider', () => {
    createAzureOpenAiEmbeddingProvider().model('text-embed-3-deployment');

    expect(mockAzureProvider.embedding).toHaveBeenCalledWith('text-embed-3-deployment');
  });

  it('declares the dimensions fragment under the openai key', () => {
    expect(createAzureOpenAiEmbeddingProvider().providerOptions).toEqual({
      openai: { dimensions: 1024 },
    });
  });
});
