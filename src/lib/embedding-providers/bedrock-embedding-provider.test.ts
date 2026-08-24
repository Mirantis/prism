/**
 * Bedrock embedding provider tests — Titan on bedrock-runtime, with the
 * dimensions fragment under the `bedrock` key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const { mockCreateAmazonBedrock, mockGenericProvider, mockDefaultProvider } = vi.hoisted(() => {
  const mockGenericProvider = {
    embedding: vi.fn((modelId: string) => ({ kind: 'embedding', modelId })),
  };
  return {
    mockGenericProvider,
    mockCreateAmazonBedrock: vi.fn(() => mockGenericProvider),
    mockDefaultProvider: vi.fn(() => async () => ({
      accessKeyId: 'chain-key',
      secretAccessKey: 'chain-secret',
      sessionToken: 'chain-token',
    })),
  };
});

vi.mock('@ai-sdk/amazon-bedrock', () => ({ createAmazonBedrock: mockCreateAmazonBedrock }));
vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: mockDefaultProvider }));

import { createBedrockEmbeddingProvider } from './bedrock-embedding-provider';

describe('createBedrockEmbeddingProvider', () => {
  beforeEach(() => {
    config.awsRegion = 'us-west-2';
    config.awsAccessKeyId = 'explicit-key';
    config.awsSecretAccessKey = 'explicit-secret';
    config.awsSessionToken = undefined;
    vi.clearAllMocks();
  });

  it('builds the generic provider with the resolved credentials', () => {
    createBedrockEmbeddingProvider();

    expect(mockCreateAmazonBedrock).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        accessKeyId: 'explicit-key',
        secretAccessKey: 'explicit-secret',
      }),
    );
  });

  it('attaches no credentials when routed through Nexus (the gateway signs)', () => {
    createBedrockEmbeddingProvider('https://nexus.example/llm/bedrock/us-east-1');

    expect(mockCreateAmazonBedrock).toHaveBeenCalledWith({
      region: 'us-west-2',
      baseURL: 'https://nexus.example/llm/bedrock/us-east-1',
    });
  });

  it('delegates model lookup to the generic provider', () => {
    createBedrockEmbeddingProvider().model('amazon.titan-embed-text-v2:0');

    expect(mockGenericProvider.embedding).toHaveBeenCalledWith('amazon.titan-embed-text-v2:0');
  });

  it('declares the dimensions fragment under the bedrock key', () => {
    expect(createBedrockEmbeddingProvider().providerOptions).toEqual({
      bedrock: { dimensions: 1024 },
    });
  });
});
