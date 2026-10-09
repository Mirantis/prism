/**
 * Anthropic Provider Tests — the first-party Anthropic API
 *
 * Chat/classification must dispatch to @ai-sdk/anthropic at its default
 * endpoint (api.anthropic.com), direct-only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../../config';

const { mockCreateAnthropic, mockAnthropicModel } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
  return {
    mockAnthropicModel,
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
  };
});

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mockCreateAnthropic,
}));

import {
  createAnthropicProvider,
  missingAnthropicSettings,
  toFirstPartyModelId,
} from './anthropic-provider';

describe('createAnthropicProvider', () => {
  beforeEach(() => {
    config.anthropicApiKey = 'sk-ant-test';
    config.anthropicBaseUrl = undefined;
    vi.clearAllMocks();
  });

  it('no baseURL → the SDK default (api.anthropic.com)', () => {
    createAnthropicProvider();
    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-test', baseURL: undefined });
  });

  it('ANTHROPIC_BASE_URL overrides the endpoint', () => {
    config.anthropicBaseUrl = 'https://gw.example/anthropic/v1';
    createAnthropicProvider();
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gw.example/anthropic/v1' }),
    );
  });

  it('a __nexus_cred sentinel key reaches the SDK verbatim', () => {
    config.anthropicApiKey = '__nexus_cred:00000000-0000-0000-0000-000000000000__';
    createAnthropicProvider();
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '__nexus_cred:00000000-0000-0000-0000-000000000000__' }),
    );
  });

  it('chat model IDs dispatch through the anthropic client', () => {
    const provider = createAnthropicProvider();
    provider('claude-opus-5');
    expect(mockAnthropicModel).toHaveBeenCalledWith('claude-opus-5');
  });

  it.each([
    ['us.anthropic.claude-opus-5', 'claude-opus-5'],
    ['anthropic.claude-opus-5', 'claude-opus-5'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
  ])('maps a stored Bedrock spelling to the first-party id: %s', (configured, bare) => {
    const provider = createAnthropicProvider();
    provider(configured);
    expect(mockAnthropicModel).toHaveBeenCalledWith(bare);
  });

  it('declares the Anthropic ephemeral cache-point fragment', () => {
    expect(createAnthropicProvider().cachePoint('claude-opus-5')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('declares no structuredOutputOptions — api.anthropic.com takes the native path', () => {
    expect(createAnthropicProvider().structuredOutputOptions).toBeUndefined();
  });

  it('turns gate thinking off, sends no temperature and declares no token floor', () => {
    const provider = createAnthropicProvider();
    expect(provider.classificationProviderOptions).toEqual({
      anthropic: { thinking: { type: 'disabled' } },
    });
    expect(provider.classificationMinOutputTokens).toBeUndefined();
    expect(provider.classificationSamplingParams).toEqual({});
  });
});

describe('toFirstPartyModelId', () => {
  it.each([
    ['us.anthropic.claude-opus-5', 'claude-opus-5'],
    ['EU.anthropic.claude-sonnet-5', 'claude-sonnet-5'],
    ['global.anthropic.claude-haiku-4-5', 'claude-haiku-4-5'],
    ['anthropic.claude-opus-5', 'claude-opus-5'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5-20251001'],
  ])('%s → %s', (input, expected) => {
    expect(toFirstPartyModelId(input)).toBe(expected);
  });

  it.each([
    'claude-opus-5',
    'claude-haiku-4-5-20251001',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5',
  ])('leaves %s unchanged', (input) => {
    expect(toFirstPartyModelId(input)).toBe(input);
  });
});

describe('missingAnthropicSettings', () => {
  beforeEach(() => {
    config.anthropicApiKey = 'sk-ant-test';
  });

  it('none with a key', () => {
    expect(missingAnthropicSettings()).toEqual([]);
  });

  it('names the key — direct-only', () => {
    config.anthropicApiKey = undefined;
    expect(missingAnthropicSettings()).toEqual(['ANTHROPIC_API_KEY']);
  });
});
