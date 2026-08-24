/**
 * Shared bedrock-runtime plumbing — credential resolution and the Anthropic
 * model-id predicate. Both AWS vendors depend on these, so they are tested
 * here rather than in either vendor's spec.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const { mockDefaultProvider } = vi.hoisted(() => {
  return {
    mockDefaultProvider: vi.fn(() => async () => ({
      accessKeyId: 'chain-key',
      secretAccessKey: 'chain-secret',
      sessionToken: 'chain-token',
    })),
  };
});

vi.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: mockDefaultProvider }));

import { createSharedBedrockOptions, isAnthropicModelId } from './bedrock-shared';

describe('createSharedBedrockOptions', () => {
  beforeEach(() => {
    config.awsRegion = 'us-west-2';
    config.awsAccessKeyId = undefined;
    config.awsSecretAccessKey = undefined;
    config.awsSessionToken = undefined;
    vi.clearAllMocks();
  });

  it('uses explicit keys when both are set', () => {
    config.awsAccessKeyId = 'explicit-key';
    config.awsSecretAccessKey = 'explicit-secret';
    config.awsSessionToken = 'session-token-123';

    expect(createSharedBedrockOptions()).toEqual({
      region: 'us-west-2',
      accessKeyId: 'explicit-key',
      secretAccessKey: 'explicit-secret',
      sessionToken: 'session-token-123',
    });
  });

  it('normalizes an empty sessionToken to undefined', () => {
    config.awsAccessKeyId = 'explicit-key';
    config.awsSecretAccessKey = 'explicit-secret';
    config.awsSessionToken = '';

    expect(createSharedBedrockOptions()).toMatchObject({ sessionToken: undefined });
  });

  it('falls back to the default credential chain when keys are missing', () => {
    const options = createSharedBedrockOptions();

    expect(mockDefaultProvider).toHaveBeenCalled();
    expect(options).toMatchObject({
      region: 'us-west-2',
      credentialProvider: expect.any(Function),
    });
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
