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
  const MANTLE = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1';
  const MOUNT = 'https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1';

  beforeEach(() => {
    config.bedrockApiKey = 'bedrock-key';
    config.nexusLlmBaseUrl = null;
    vi.clearAllMocks();
  });

  it('sends requests to the endpoint it is given', () => {
    createBedrockMantleProvider(MANTLE);

    expect(mockCreateAnthropic).toHaveBeenCalledWith({
      apiKey: 'bedrock-key',
      baseURL: MANTLE,
    });
  });

  it('a gateway endpoint without a local key: falls back to a decoy apiKey (the gateway injects the real one)', () => {
    config.bedrockApiKey = undefined;
    createBedrockMantleProvider(MOUNT);

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an override on the gateway host also gets the decoy, mount or not', () => {
    config.bedrockApiKey = undefined;
    createBedrockMantleProvider('https://gateway.example.com/projects/p/llm/mantle/anthropic/v1');

    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'nexus-managed' }),
    );
  });

  it('an endpoint off the gateway host without a key sends no decoy', () => {
    // A decoy would promise a credential injection that nothing performs.
    config.bedrockApiKey = undefined;
    createBedrockMantleProvider(MANTLE);

    expect(mockCreateAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('dispatches bare Anthropic model IDs unchanged', () => {
    const provider = createBedrockMantleProvider(MANTLE);
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
    const provider = createBedrockMantleProvider(MANTLE);
    provider(configured);
    expect(mockAnthropicModel).toHaveBeenCalledWith(bare);
  });

  it('leaves an inference-profile ARN alone', () => {
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5';
    const provider = createBedrockMantleProvider(MANTLE);
    provider(arn);
    expect(mockAnthropicModel).toHaveBeenCalledWith(arn);
  });

  it('still dispatches a non-Anthropic model ID (mantle 404s it; we only warn)', () => {
    const provider = createBedrockMantleProvider(MANTLE);
    provider('openai.gpt-oss-120b');
    expect(mockAnthropicModel).toHaveBeenCalledWith('openai.gpt-oss-120b');
  });

  it('asks for the tool-based JSON path — mantle rejects native structured output', () => {
    expect(createBedrockMantleProvider(MANTLE).structuredOutputOptions).toEqual({
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
    config.bedrockMantleDirectEndpoint = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1';
    config.nexusBedrockMantleBaseUrl = null;
  });

  it('true with model + key + endpoint (direct)', () => {
    expect(isBedrockMantleConfigured()).toBe(true);
  });

  it('true with model + gateway base URL and NO key (gateway holds the credential)', () => {
    config.bedrockApiKey = undefined;
    config.nexusBedrockMantleBaseUrl =
      'https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1';
    expect(isBedrockMantleConfigured()).toBe(true);
  });

  it('false without the Bedrock API key — there is no SigV4 path on this surface', () => {
    config.bedrockApiKey = undefined;
    expect(isBedrockMantleConfigured()).toBe(false);
  });

  it('false without a chat endpoint', () => {
    config.bedrockMantleDirectEndpoint = '';
    expect(isBedrockMantleConfigured()).toBe(false);
  });

  it('false without a chat model', () => {
    config.bedrockMantleModelId = '';
    expect(isBedrockMantleConfigured()).toBe(false);
  });
});
