/**
 * Azure Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../config';

const { mockCreateAzure, mockAzureModel, mockEmbeddingFn } = vi.hoisted(() => {
  const mockEmbeddingFn = vi.fn((modelId: string) => ({ kind: 'embedding', modelId }));
  const mockAzureModel = Object.assign(
    vi.fn((modelId: string) => ({ provider: 'azure', modelId })),
    { embedding: mockEmbeddingFn },
  );
  return {
    mockEmbeddingFn,
    mockAzureModel,
    mockCreateAzure: vi.fn(() => mockAzureModel),
  };
});

vi.mock('@ai-sdk/azure', () => ({
  createAzure: mockCreateAzure,
}));

import { createAzureProvider, isAzureConfigured } from './azure-provider';

describe('createAzureProvider', () => {
  beforeEach(() => {
    config.azureApiKey = 'azure-key';
    config.azureResourceName = 'my-resource';
    config.azureApiVersion = undefined;
    mockCreateAzure.mockClear();
    mockAzureModel.mockClear();
    mockEmbeddingFn.mockClear();
  });

  it('direct routing: passes resourceName + apiKey, no baseURL', () => {
    createAzureProvider();

    expect(mockCreateAzure).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'azure-key', resourceName: 'my-resource' }),
    );
    expect(mockCreateAzure.mock.calls[0][0]).not.toHaveProperty('baseURL');
  });

  it('Nexus routing: passes baseURL and omits resourceName', () => {
    createAzureProvider('https://nexus.example/llm/azure');

    const opts = mockCreateAzure.mock.calls[0][0];
    expect(opts).toMatchObject({ apiKey: 'azure-key', baseURL: 'https://nexus.example/llm/azure' });
    expect(opts).not.toHaveProperty('resourceName');
  });

  it('forwards apiVersion when set, undefined otherwise', () => {
    config.azureApiVersion = '2024-10-21';
    createAzureProvider();
    expect(mockCreateAzure.mock.calls[0][0]).toMatchObject({ apiVersion: '2024-10-21' });
  });

  it('dispatches chat model IDs (deployment names) through the provider', () => {
    const provider = createAzureProvider();
    provider('gpt-4o-deployment');
    expect(mockAzureModel).toHaveBeenCalledWith('gpt-4o-deployment');
  });

  it('exposes .embedding() that delegates to the provider', () => {
    const provider = createAzureProvider();
    provider.embedding('text-embed-3-deployment');
    expect(mockEmbeddingFn).toHaveBeenCalledWith('text-embed-3-deployment');
    expect(mockAzureModel).not.toHaveBeenCalled();
  });
});

describe('isAzureConfigured', () => {
  beforeEach(() => {
    config.azureModelId = 'gpt-4o-deployment';
    config.azureApiKey = 'azure-key';
    config.azureResourceName = 'my-resource';
    config.nexusAzureBaseUrl = null;
  });

  it('true with deployment + key + resourceName (direct)', () => {
    expect(isAzureConfigured()).toBe(true);
  });

  it('true with deployment + key + nexus base URL (no resourceName)', () => {
    config.azureResourceName = undefined;
    config.nexusAzureBaseUrl = 'https://nexus.example/llm/azure';
    expect(isAzureConfigured()).toBe(true);
  });

  it('false without an endpoint (neither resourceName nor nexus URL)', () => {
    config.azureResourceName = undefined;
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
