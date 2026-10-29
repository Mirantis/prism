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

import { createBedrockProvider } from './bedrock-provider';
import { ANTHROPIC_TOOL_CHANGES } from '../tool-changes';

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
    provider('global.anthropic.claude-opus-5-5');
    expect(mockAnthropicModel).toHaveBeenCalledWith('global.anthropic.claude-opus-5-5');
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

  it('sends the gates no temperature, which Haiku 5.5 rejects', () => {
    expect(createBedrockProvider().classificationSamplingParams).toEqual({});
  });

  it('gives Anthropic models the Anthropic cacheControl fragment', () => {
    expect(createBedrockProvider().cachePoint('global.anthropic.claude-opus-5-5')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('asks a Claude model for the cache lifetime it is given', () => {
    const provider = createBedrockProvider();
    const oneHour = { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } };
    const fiveMinutes = { anthropic: { cacheControl: { type: 'ephemeral' } } };

    expect(provider.cachePoint('global.anthropic.claude-opus-5-5', '1h')).toEqual(oneHour);
    expect(provider.cachePoint('us.anthropic.claude-haiku-4-5-20251001-v1:0', '1h')).toEqual(oneHour);
    expect(provider.cachePoint('global.anthropic.claude-opus-5-5', '5m')).toEqual(fiveMinutes);
    expect(provider.cachePoint('us.xai.grok-4.6', '1h')).toEqual({});
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

    expect(provider.promptCacheState?.('global.anthropic.claude-opus-5-5')).toBe('on');
    expect(provider.promptCacheState?.('us.xai.grok-4.6')).toBe('off');
    expect(provider.promptCacheState?.('us.amazon.nova-2-lite-v1:0')).toBe('off');
  });

  it.each([
    'global.anthropic.claude-opus-5-5',
    'us.anthropic.claude-opus-5-5',
    'anthropic.claude-opus-5-5',
    'global.anthropic.claude-opus-4-8',
    'us.anthropic.claude-sonnet-5-5',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5',
  ])('takes mid-conversation tool changes on %s', (modelId) => {
    expect(createBedrockProvider().toolChanges?.(modelId)).toBe(ANTHROPIC_TOOL_CHANGES);
  });

  it.each([
    // Answers a turn that has a change with a refusal.
    'global.anthropic.claude-opus-5',
    // Rejects the change: "tool_addition/tool_removal is not supported on this model".
    'global.anthropic.claude-sonnet-5',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.xai.grok-4.6',
    // An application inference profile does not name its model.
    'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6',
  ])('sends no tool change to %s', (modelId) => {
    expect(createBedrockProvider().toolChanges?.(modelId)).toBeUndefined();
  });
});
