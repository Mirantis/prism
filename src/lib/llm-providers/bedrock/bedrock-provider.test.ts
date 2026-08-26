/**
 * Bedrock Provider Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../config';

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

import { createBedrockProvider, isBedrockConfigured } from './bedrock-provider';

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

  it('declares no structured-output options — the SDK default works on bedrock-runtime', () => {
    expect(createBedrockProvider().structuredOutputOptions).toBeUndefined();
  });

  it('gives Anthropic models the Anthropic cacheControl fragment', () => {
    expect(createBedrockProvider().cachePoint('us.anthropic.claude-opus-5')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('gives xAI models the Bedrock cachePoint fragment, which is what Converse reads', () => {
    // The generic branch speaks Converse, and `@ai-sdk/amazon-bedrock` reads
    // `providerOptions.bedrock.cachePoint` / `.amazonBedrock.cachePoint`. An
    // Anthropic-namespaced fragment here is dropped without an error, so the
    // breakpoints never reach the wire and every turn pays full input price.
    const provider = createBedrockProvider();
    expect(provider.cachePoint('us.xai.grok-4.6')).toEqual({
      bedrock: { cachePoint: { type: 'default' } },
    });
    expect(provider.cachePoint('global.xai.grok-4.6')).toEqual({
      bedrock: { cachePoint: { type: 'default' } },
    });
  });

  it('sends no breakpoint for a Converse model whose caching support is undocumented', () => {
    // AWS guarantees a below-minimum checkpoint fails silently only on a model
    // that supports caching at all; an unsupported one plausibly rejects the
    // block outright. Absent is the safe answer — the empty fragment spreads
    // into `providerOptions` as a no-op, exactly as today.
    const provider = createBedrockProvider();
    expect(provider.cachePoint('moonshotai.kimi-k2.5')).toEqual({});
    expect(provider.cachePoint('meta.llama3-70b-instruct-v1:0')).toEqual({});
  });

  it('exposes .embedding() that delegates to the generic provider', () => {
    const provider = createBedrockProvider();
    provider.embedding('amazon.titan-embed-text-v2:0');
    expect(mockGenericEmbeddingFn).toHaveBeenCalledWith('amazon.titan-embed-text-v2:0');
    expect(mockGenericModel).not.toHaveBeenCalled();
    expect(mockAnthropicModel).not.toHaveBeenCalled();
  });
});
