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

import {
  createBedrockProvider,
  hasPromptCacheBreakpoint,
  isBedrockConfigured,
} from './bedrock-provider';

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
    config.bedrockConversePromptCache = false;
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

  it('gives no Converse model a breakpoint by default — one that cannot cache rejects the request', () => {
    // A Bedrock model without prompt-cache support answers a request that has a
    // `cachePoint` block with "You invoked an unsupported model or your request
    // did not allow prompt caching", so every turn fails. AWS publishes no
    // per-model capability this code can read, so the breakpoint is withheld
    // until an operator opts their model in.
    const provider = createBedrockProvider();

    expect(provider.cachePoint('us.xai.grok-4.6')).toEqual({});
    expect(provider.cachePoint('global.xai.grok-4.6')).toEqual({});
    expect(provider.cachePoint('us.amazon.nova-2-lite-v1:0')).toEqual({});
    expect(provider.cachePoint('moonshotai.kimi-k2.5')).toEqual({});
    expect(provider.cachePoint('meta.llama3-70b-instruct-v1:0')).toEqual({});
  });

  it('gives a Converse model the Bedrock cachePoint fragment when the operator opts in', () => {
    // `@ai-sdk/amazon-bedrock` reads `providerOptions.bedrock.cachePoint` /
    // `.amazonBedrock.cachePoint`. An Anthropic-namespaced fragment on this
    // branch is dropped without an error, so the breakpoint has to be the
    // Bedrock one to reach the wire at all.
    config.bedrockConversePromptCache = true;
    const provider = createBedrockProvider();

    expect(provider.cachePoint('us.xai.grok-4.6')).toEqual({
      bedrock: { cachePoint: { type: 'default' } },
    });
    expect(provider.cachePoint('us.amazon.nova-2-lite-v1:0')).toEqual({
      bedrock: { cachePoint: { type: 'default' } },
    });
  });

  it('leaves Claude on its own breakpoint when the Converse opt-in is on', () => {
    // The opt-in must not reach the Anthropic branch in either direction: that
    // is the surface where the cache reads actually land.
    config.bedrockConversePromptCache = true;

    expect(createBedrockProvider().cachePoint('us.anthropic.claude-opus-5')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });
});

describe('hasPromptCacheBreakpoint', () => {
  beforeEach(() => {
    config.bedrockConversePromptCache = false;
  });

  it('is true for Claude, whatever the Converse opt-in says', () => {
    expect(hasPromptCacheBreakpoint('global.anthropic.claude-opus-5')).toBe(true);
    config.bedrockConversePromptCache = true;
    expect(hasPromptCacheBreakpoint('global.anthropic.claude-opus-5')).toBe(true);
  });

  it('is false for a Converse model by default and true once opted in', () => {
    expect(hasPromptCacheBreakpoint('us.xai.grok-4.6')).toBe(false);
    config.bedrockConversePromptCache = true;
    expect(hasPromptCacheBreakpoint('us.xai.grok-4.6')).toBe(true);
  });
});
