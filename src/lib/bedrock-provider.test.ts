/**
 * Bedrock Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../config';

const {
  mockCreateBedrockAnthropic,
  mockCreateAmazonBedrock,
  mockAnthropicModel,
  mockGenericModel,
  mockGenericEmbeddingFn,
  mockDefaultProvider,
} = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
  const mockGenericEmbeddingFn = vi.fn((modelId: string) => ({ kind: 'embedding', modelId }));
  const mockGenericModel = Object.assign(
    vi.fn((modelId: string) => ({ provider: 'generic', modelId })),
    { embedding: mockGenericEmbeddingFn },
  );
  return {
    mockAnthropicModel,
    mockGenericModel,
    mockGenericEmbeddingFn,
    mockCreateBedrockAnthropic: vi.fn(() => mockAnthropicModel),
    mockCreateAmazonBedrock: vi.fn(() => mockGenericModel),
    mockDefaultProvider: vi.fn(() => async () => ({
      accessKeyId: 'chain-key',
      secretAccessKey: 'chain-secret',
      sessionToken: 'chain-token',
    })),
  };
});

vi.mock('@ai-sdk/amazon-bedrock/anthropic', () => ({
  createBedrockAnthropic: mockCreateBedrockAnthropic,
}));

vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: mockCreateAmazonBedrock,
}));

vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: mockDefaultProvider,
}));

import { createBedrockProvider, isAnthropicModelId, isBedrockConfigured } from './bedrock-provider';

describe('isBedrockConfigured', () => {
  beforeEach(() => {
    config.awsRegion = 'us-east-1';
    config.bedrockModelId = 'anthropic.claude-3-sonnet';
  });

  it('returns true when both awsRegion and bedrockModelId are set', () => {
    expect(isBedrockConfigured()).toBe(true);
  });

  it('returns false when awsRegion is empty', () => {
    config.awsRegion = '';
    expect(isBedrockConfigured()).toBe(false);
  });

  it('returns false when bedrockModelId is empty', () => {
    config.bedrockModelId = '';
    expect(isBedrockConfigured()).toBe(false);
  });
});

describe('createBedrockProvider', () => {
  beforeEach(() => {
    config.awsRegion = 'us-west-2';
    config.awsAccessKeyId = undefined;
    config.awsSecretAccessKey = undefined;
    config.awsSessionToken = undefined;
    mockCreateBedrockAnthropic.mockClear();
    mockCreateAmazonBedrock.mockClear();
    mockAnthropicModel.mockClear();
    mockGenericModel.mockClear();
    mockDefaultProvider.mockClear();
  });

  it('uses explicit keys when awsAccessKeyId and awsSecretAccessKey are set', () => {
    config.awsAccessKeyId = 'explicit-key';
    config.awsSecretAccessKey = 'explicit-secret';

    createBedrockProvider();

    expect(mockCreateBedrockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        accessKeyId: 'explicit-key',
        secretAccessKey: 'explicit-secret',
      })
    );
  });

  it('passes sessionToken when available (temporary credentials)', () => {
    config.awsAccessKeyId = 'explicit-key';
    config.awsSecretAccessKey = 'explicit-secret';
    config.awsSessionToken = 'session-token-123';

    createBedrockProvider();

    expect(mockCreateBedrockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        accessKeyId: 'explicit-key',
        secretAccessKey: 'explicit-secret',
        sessionToken: 'session-token-123',
      })
    );
  });

  it('normalizes empty sessionToken to undefined', () => {
    config.awsAccessKeyId = 'explicit-key';
    config.awsSecretAccessKey = 'explicit-secret';
    config.awsSessionToken = '';

    createBedrockProvider();

    expect(mockCreateBedrockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionToken: undefined,
      })
    );
  });

  it('falls back to default credential chain when explicit keys are missing', () => {
    createBedrockProvider();

    expect(mockDefaultProvider).toHaveBeenCalled();
    expect(mockCreateBedrockAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        credentialProvider: expect.any(Function),
      })
    );
  });

  it('routes Anthropic model IDs through the Anthropic-native provider', () => {
    const provider = createBedrockProvider();
    provider('us.anthropic.claude-opus-4-7');
    expect(mockAnthropicModel).toHaveBeenCalledWith('us.anthropic.claude-opus-4-7');
    expect(mockGenericModel).not.toHaveBeenCalled();
  });

  it('routes non-Anthropic model IDs through the generic Converse provider', () => {
    const provider = createBedrockProvider();
    provider('moonshotai.kimi-k2.5');
    expect(mockGenericModel).toHaveBeenCalledWith('moonshotai.kimi-k2.5');
    expect(mockAnthropicModel).not.toHaveBeenCalled();
  });

  it('exposes .embedding() that delegates to the generic provider', () => {
    const provider = createBedrockProvider();
    provider.embedding('amazon.titan-embed-text-v2:0');
    expect(mockGenericEmbeddingFn).toHaveBeenCalledWith('amazon.titan-embed-text-v2:0');
    expect(mockGenericModel).not.toHaveBeenCalled();
    expect(mockAnthropicModel).not.toHaveBeenCalled();
  });
});

describe('isAnthropicModelId', () => {
  it('matches bare and region-prefixed Anthropic IDs', () => {
    expect(isAnthropicModelId('anthropic.claude-3-sonnet')).toBe(true);
    expect(isAnthropicModelId('us.anthropic.claude-opus-4-7')).toBe(true);
    expect(isAnthropicModelId('eu.anthropic.claude-3-haiku')).toBe(true);
    expect(isAnthropicModelId('apac.anthropic.claude-sonnet-4-6-20250929-v1:0')).toBe(true);
  });

  it('matches Anthropic IDs embedded in an ARN', () => {
    expect(
      isAnthropicModelId(
        'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-4-7',
      ),
    ).toBe(true);
  });

  it('does not match other vendors', () => {
    expect(isAnthropicModelId('moonshotai.kimi-k2.5')).toBe(false);
    expect(isAnthropicModelId('moonshot.kimi-k2-thinking')).toBe(false);
    expect(isAnthropicModelId('meta.llama3-70b-instruct-v1:0')).toBe(false);
    expect(isAnthropicModelId('mistral.mistral-large-2402-v1:0')).toBe(false);
  });
});
