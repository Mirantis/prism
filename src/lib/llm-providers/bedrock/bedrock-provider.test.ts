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
  mockDefaultProvider,
} = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
  const mockGenericModel = vi.fn((modelId: string) => ({ provider: 'generic', modelId }));
  return {
    mockAnthropicModel,
    mockGenericModel,
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

  it('gates tool changes by model and protocol', () => {
    const provider = createBedrockProvider();
    expect(provider.supportsToolChanges('anthropic.claude-opus-4-8')).toBe(true);
    expect(provider.supportsToolChanges('global.anthropic.claude-fable-5-1')).toBe(true);
    expect(provider.supportsToolChanges('us.anthropic.claude-fable-5-1')).toBe(true);
    expect(provider.supportsToolChanges('claude-opus-5')).toBe(false);
    expect(provider.supportsToolChanges('us.amazon.nova-2-lite-v1:0')).toBe(false);
    expect(provider.supportsToolChanges('anthropic.claude-fable-5-10')).toBe(false);
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

  it('gives no Converse model a breakpoint — one that cannot cache rejects the request', () => {
    // A Bedrock model without prompt-cache support answers a request that has a
    // `cachePoint` block with "You invoked an unsupported model or your request
    // did not allow prompt caching", so every turn fails. No source this runtime
    // can read says which Converse model supports one, so none gets a
    // breakpoint and every one of them still runs.
    const provider = createBedrockProvider();

    expect(provider.cachePoint('us.xai.grok-4.6')).toEqual({});
    expect(provider.cachePoint('global.xai.grok-4.6')).toEqual({});
    expect(provider.cachePoint('us.amazon.nova-2-lite-v1:0')).toEqual({});
    expect(provider.cachePoint('moonshotai.kimi-k2.5')).toEqual({});
    expect(provider.cachePoint('meta.llama3-70b-instruct-v1:0')).toEqual({});
  });

  it('reports prompt-cache state for the startup line, on for Claude and off for Converse', () => {
    // What `index.ts` logs. It reads this member off the shared contract and
    // names no vendor, so the answer has to come from here.
    const provider = createBedrockProvider();

    expect(provider.promptCacheState?.('global.anthropic.claude-opus-5')).toBe('on');
    expect(provider.promptCacheState?.('us.xai.grok-4.6')).toBe('off');
    expect(provider.promptCacheState?.('us.amazon.nova-2-lite-v1:0')).toBe('off');
  });
});
