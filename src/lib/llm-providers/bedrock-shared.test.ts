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

import { createSharedBedrockOptions } from './bedrock-shared';

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
