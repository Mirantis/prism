/**
 * Bedrock Mantle Provider Tests
 *
 * Chat must dispatch to @ai-sdk/anthropic pointed at the mantle Anthropic
 * surface, with bare model IDs.
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
  createBedrockMantleProvider,
  isBedrockMantleConfigured,
  toBareBedrockModelId,
} from './bedrock-mantle-provider';

describe('createBedrockMantleProvider', () => {
  beforeEach(() => {
    config.bedrockApiKey = 'bedrock-key';
    config.bedrockMantleBaseUrl = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1';
    config.nexusLlmBaseUrl = null;
    vi.clearAllMocks();
  });

  it('direct routing: chat provider gets the mantle Anthropic baseURL', () => {
    createBedrockMantleProvider();

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'bedrock-key',
      baseURL: 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1',
    });
  });

  it('Gateway routing: an explicit baseURL overrides the direct endpoint', () => {
    createBedrockMantleProvider('https://gateway.example/llm/bedrock-mantle/anthropic/us-east-1/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://gateway.example/llm/bedrock-mantle/anthropic/us-east-1/v1',
      }),
    );
  });

  it('Gateway routing without a local key: falls back to a decoy apiKey (gateway injects the real one)', () => {
    config.bedrockApiKey = undefined;
    createBedrockMantleProvider('https://gateway.example/llm/bedrock-mantle/anthropic/us-east-1/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('direct routing without a key passes undefined, no decoy', () => {
    config.bedrockApiKey = undefined;
    createBedrockMantleProvider();

    expect(mockCreateAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('dispatches bare Anthropic model IDs unchanged', () => {
    const provider = createBedrockMantleProvider();
    provider('anthropic.claude-opus-5');
    expect(mockAnthropicModel).toHaveBeenCalledWith('anthropic.claude-opus-5');
  });

  it.each([
    ['us.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['eu.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['apac.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['us-gov.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['global.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
  ])('strips the cross-region inference profile prefix: %s', (configured, bare) => {
    const provider = createBedrockMantleProvider();
    provider(configured);
    expect(mockAnthropicModel).toHaveBeenCalledWith(bare);
  });

  it('leaves an inference-profile ARN alone', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5';
    const provider = createBedrockMantleProvider();
    provider(arn);
    expect(mockAnthropicModel).toHaveBeenCalledWith(arn);
  });

  it('still dispatches a non-Anthropic model ID (mantle 404s it; we only warn)', () => {
    const provider = createBedrockMantleProvider();
    provider('openai.gpt-oss-120b');
    expect(mockAnthropicModel).toHaveBeenCalledWith('openai.gpt-oss-120b');
  });

  it('asks for the tool-based JSON path — mantle rejects native structured output', () => {
    expect(createBedrockMantleProvider().structuredOutputOptions).toEqual({
      anthropic: { structuredOutputMode: 'jsonTool' },
    });
  });
});

describe('toBareBedrockModelId', () => {
  it.each([
    ['us.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['US.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['jp.anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
  ])('%s → %s', (input, expected) => {
    expect(toBareBedrockModelId(input)).toBe(expected);
  });

  it.each([
    'anthropic.claude-opus-5',
    'amazon.titan-embed-text-v2:0',
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5',
  ])('leaves %s unchanged', (input) => {
    expect(toBareBedrockModelId(input)).toBe(input);
  });
});

describe('isBedrockMantleConfigured', () => {
  beforeEach(() => {
    config.bedrockMantleModelId = 'anthropic.claude-opus-5';
    config.bedrockApiKey = 'bedrock-key';
    config.bedrockMantleBaseUrl = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1';
    config.nexusBedrockMantleBaseUrl = null;
  });

  it('true with model + key + endpoint (direct)', () => {
    expect(isBedrockMantleConfigured()).toBe(true);
  });

  it('true with model + gateway base URL and NO key (gateway holds the credential)', () => {
    config.bedrockApiKey = undefined;
    config.nexusBedrockMantleBaseUrl =
      'https://gateway.example/llm/bedrock-mantle/anthropic/us-east-1/v1';
    expect(isBedrockMantleConfigured()).toBe(true);
  });

  it('false without the Bedrock API key — there is no SigV4 path on this surface', () => {
    config.bedrockApiKey = undefined;
    expect(isBedrockMantleConfigured()).toBe(false);
  });

  it('false without a chat endpoint', () => {
    config.bedrockMantleBaseUrl = '';
    expect(isBedrockMantleConfigured()).toBe(false);
  });

  it('false without a chat model', () => {
    config.bedrockMantleModelId = '';
    expect(isBedrockMantleConfigured()).toBe(false);
  });
});
