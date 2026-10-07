/**
 * LiteLLM Provider Tests — an operator's own LiteLLM proxy
 *
 * Chat/classification must dispatch to @ai-sdk/anthropic at the resolved
 * endpoint, and the startup check must name the proxy's models when a
 * configured alias is missing or wrong.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../../config';

const { mockCreateAnthropic, mockAnthropicModel, mockWarn } = vi.hoisted(() => {
  const mockAnthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
  return {
    mockAnthropicModel,
    mockCreateAnthropic: vi.fn(() => mockAnthropicModel),
    mockWarn: vi.fn(),
  };
});

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mockCreateAnthropic,
}));
vi.mock('../../../logger', () => ({ logger: { info: vi.fn(), warn: mockWarn } }));

import { createLiteLlmProvider, isLiteLlmConfigured } from './litellm-provider';

const PROXY = 'https://litellm.example.com/v1';
const MOUNT = 'https://gateway.example.com/projects/p/llm/litellm/anthropic/v1';

describe('createLiteLlmProvider', () => {
  beforeEach(() => {
    config.litellmApiKey = 'sk-litellm';
    vi.clearAllMocks();
  });

  it('sends requests to the endpoint it is given, with the LiteLLM key', () => {
    createLiteLlmProvider(PROXY);

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-litellm', baseURL: PROXY });
  });

  it('a gateway endpoint without a local key falls back to a decoy (the gateway injects the real one)', () => {
    config.litellmApiKey = undefined;
    createLiteLlmProvider(MOUNT);

    expect(mockCreateAnthropic).toHaveBeenCalledWith({ apiKey: 'nexus-managed', baseURL: MOUNT });
  });

  it('off the gateway without a key, fails the model call before any request', () => {
    // Given no key, the SDK would send ANTHROPIC_API_KEY to the proxy instead.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-first-party';
    config.litellmApiKey = undefined;
    const provider = createLiteLlmProvider(PROXY);

    expect(() => provider('claude-opus-5-5')).toThrow('LITELLM_API_KEY is not set');
    expect(mockAnthropicModel).not.toHaveBeenCalled();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('passes the alias to the proxy unchanged, Bedrock-shaped or not', () => {
    const provider = createLiteLlmProvider(PROXY);
    provider('anthropic.claude-opus-5');
    expect(mockAnthropicModel).toHaveBeenCalledWith('anthropic.claude-opus-5');
  });

  it('asks for the tool-based JSON path, which translates to any upstream', () => {
    expect(createLiteLlmProvider(PROXY).structuredOutputOptions).toEqual({
      anthropic: { structuredOutputMode: 'jsonTool' },
    });
  });

  it('sends the gates no temperature, which a GPT-5.x upstream rejects', () => {
    expect(createLiteLlmProvider(PROXY).classificationSamplingParams).toEqual({});
  });

  it('marks Anthropic prompt-cache breakpoints', () => {
    expect(createLiteLlmProvider(PROXY).cachePoint('any-alias')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('declares no startup check without an endpoint', () => {
    expect(createLiteLlmProvider(undefined).startupCheck).toBeUndefined();
  });
});

describe('startupCheck', () => {
  const fetchMock = vi.fn();

  // The shape LiteLLM's `GET /v1/models` answers with.
  const modelList = (...ids: string[]) =>
    new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }));

  beforeEach(() => {
    config.litellmApiKey = 'sk-litellm';
    config.litellmModelId = 'claude-opus-5-5';
    config.litellmClassificationModelId = 'claude-haiku-4-5';
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks the proxy for its models with the key the chat calls send', async () => {
    fetchMock.mockResolvedValue(modelList('claude-opus-5-5', 'claude-haiku-4-5'));

    await createLiteLlmProvider(PROXY).startupCheck!();

    expect(fetchMock).toHaveBeenCalledWith(
      `${PROXY}/models`,
      expect.objectContaining({ headers: { 'x-api-key': 'sk-litellm' } }),
    );
  });

  it('off the gateway without a key, names the missing key and asks the proxy nothing', async () => {
    config.litellmApiKey = undefined;

    await createLiteLlmProvider(PROXY).startupCheck!();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      '[Startup] LITELLM_API_KEY is not set; the agent cannot reach the LiteLLM proxy',
    );
  });

  it('is quiet when both aliases are served', async () => {
    fetchMock.mockResolvedValue(modelList('claude-opus-5-5', 'claude-haiku-4-5'));

    await createLiteLlmProvider(PROXY).startupCheck!();

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('names the variable and the served models when the proxy calls the chat model differently', async () => {
    fetchMock.mockResolvedValue(modelList('opus', 'claude-haiku-4-5'));

    await createLiteLlmProvider(PROXY).startupCheck!();

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      {
        variable: 'LITELLM_MODEL_ID',
        model: 'claude-opus-5-5',
        served: ['opus', 'claude-haiku-4-5'],
        servedCount: 2,
      },
      '[Startup] the LiteLLM proxy does not serve claude-opus-5-5; set LITELLM_MODEL_ID to one of the models it serves',
    );
  });

  it('warns about a classification alias the proxy does not serve', async () => {
    config.litellmClassificationModelId = 'claude-haiku-4.5';
    fetchMock.mockResolvedValue(modelList('claude-opus-5-5', 'claude-haiku-4-5'));

    await createLiteLlmProvider(PROXY).startupCheck!();

    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ variable: 'LITELLM_CLASSIFICATION_MODEL_ID', model: 'claude-haiku-4.5' }),
      '[Startup] the LiteLLM proxy does not serve claude-haiku-4.5; set LITELLM_CLASSIFICATION_MODEL_ID to one of the models it serves',
    );
  });

  it('names at most 50 served models, with the full count', async () => {
    config.litellmModelId = 'missing';
    config.litellmClassificationModelId = 'missing';
    const ids = Array.from({ length: 120 }, (_, i) => `model-${i}`);
    fetchMock.mockResolvedValue(modelList(...ids));

    await createLiteLlmProvider(PROXY).startupCheck!();

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({ served: ids.slice(0, 50), servedCount: 120 }),
      expect.any(String),
    );
  });

  it('logs and resolves when the proxy refuses the model list', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"auth"}', { status: 401 }));

    await expect(createLiteLlmProvider(PROXY).startupCheck!()).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'GET /models answered 401' }) },
      '[Startup] could not read the LiteLLM model list; the configured models are unchecked',
    );
  });

  it('logs and resolves when the proxy cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(createLiteLlmProvider(PROXY).startupCheck!()).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

describe('isLiteLlmConfigured', () => {
  beforeEach(() => {
    config.litellmApiKey = 'sk-litellm';
    config.litellmEndpoint = PROXY;
  });

  it('true with a key and the proxy endpoint (direct)', () => {
    expect(isLiteLlmConfigured()).toBe(true);
  });

  it('true on the gateway mount without a key (the gateway holds it)', () => {
    config.litellmApiKey = undefined;
    config.litellmEndpoint = MOUNT;
    expect(isLiteLlmConfigured()).toBe(true);
  });

  it('false off the gateway without a key', () => {
    config.litellmApiKey = undefined;
    expect(isLiteLlmConfigured()).toBe(false);
  });

  it('false without an endpoint', () => {
    config.litellmEndpoint = undefined;
    expect(isLiteLlmConfigured()).toBe(false);
  });
});
