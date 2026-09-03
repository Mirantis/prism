/**
 * create-provider switch tests: vendor (bedrock/azure/bedrock-mantle/openai/
 * openrouter/anthropic) x routing (direct/gateway; anthropic is direct-only).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const {
  mockCreateBedrockProvider,
  mockCreateAzureProvider,
  mockCreateBedrockMantleProvider,
  mockCreateOpenAiProvider,
  mockCreateOpenRouterProvider,
  mockCreateAnthropicProvider,
  mockIsBedrockConfigured,
  mockIsAzureConfigured,
  mockIsBedrockMantleConfigured,
  mockIsOpenAiConfigured,
  mockIsOpenRouterConfigured,
  mockIsAnthropicConfigured,
} = vi.hoisted(() => ({
  mockCreateBedrockProvider: vi.fn(() => 'bedrock-provider'),
  mockCreateAzureProvider: vi.fn(() => 'azure-provider'),
  mockCreateBedrockMantleProvider: vi.fn(() => 'bedrock-mantle-provider'),
  mockCreateOpenAiProvider: vi.fn(() => 'openai-provider'),
  mockCreateOpenRouterProvider: vi.fn(() => 'openrouter-provider'),
  mockCreateAnthropicProvider: vi.fn(() => 'anthropic-provider'),
  mockIsBedrockConfigured: vi.fn(() => true),
  mockIsAzureConfigured: vi.fn(() => true),
  mockIsBedrockMantleConfigured: vi.fn(() => true),
  mockIsOpenAiConfigured: vi.fn(() => true),
  mockIsOpenRouterConfigured: vi.fn(() => true),
  mockIsAnthropicConfigured: vi.fn(() => true),
}));

vi.mock('./bedrock/bedrock-provider', () => ({
  createBedrockProvider: mockCreateBedrockProvider,
  isBedrockConfigured: mockIsBedrockConfigured,
}));
vi.mock('./azure/azure-provider', () => ({
  createAzureProvider: mockCreateAzureProvider,
  isAzureConfigured: mockIsAzureConfigured,
}));
vi.mock('./bedrock-mantle/bedrock-mantle-provider', () => ({
  createBedrockMantleProvider: mockCreateBedrockMantleProvider,
  isBedrockMantleConfigured: mockIsBedrockMantleConfigured,
}));
vi.mock('./openai/openai-provider', () => ({
  createOpenAiProvider: mockCreateOpenAiProvider,
  isOpenAiConfigured: mockIsOpenAiConfigured,
}));
vi.mock('./openrouter/openrouter-provider', () => ({
  createOpenRouterProvider: mockCreateOpenRouterProvider,
  isOpenRouterConfigured: mockIsOpenRouterConfigured,
}));
vi.mock('./anthropic/anthropic-provider', () => ({
  createAnthropicProvider: mockCreateAnthropicProvider,
  isAnthropicConfigured: mockIsAnthropicConfigured,
}));

import { createProvider, isProviderConfigured } from './create-provider';

describe('createProvider', () => {
  const MOUNT = {
    bedrock: 'https://gateway.example.com/llm/bedrock/us-east-1',
    azure: 'https://gateway.example.com/llm/azure/anthropic/v1',
    mantle: 'https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1',
    openai: 'https://gateway.example.com/llm/openai/v1',
    openrouter: 'https://gateway.example.com/llm/openrouter/openai/v1',
  };

  beforeEach(() => {
    config.llmProvider = 'bedrock';
    config.nexusLlmBaseUrl = null;
    config.nexusAzureBaseUrl = null;
    config.nexusBedrockMantleBaseUrl = null;
    config.nexusOpenAiBaseUrl = null;
    config.nexusOpenRouterBaseUrl = null;
    config.azureChatEndpoint = undefined;
    config.bedrockMantleChatEndpoint = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1';
    config.openaiEndpoint = undefined;
    config.openrouterEndpoint = 'https://openrouter.ai/api/v1';
    vi.clearAllMocks();
  });

  it('bedrock + no gateway URL → direct Bedrock (undefined baseURL)', () => {
    expect(createProvider()).toBe('bedrock-provider');
    expect(mockCreateBedrockProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
  });

  it('bedrock + gateway URL → Bedrock with the gateway baseURL', () => {
    config.nexusLlmBaseUrl = MOUNT.bedrock;
    expect(createProvider()).toBe('bedrock-provider');
    expect(mockCreateBedrockProvider).toHaveBeenCalledWith(MOUNT.bedrock);
  });

  it('azure → the resolved azure chat endpoint', () => {
    config.llmProvider = 'azure';
    config.azureChatEndpoint = 'https://my-resource.services.ai.azure.com/anthropic/v1';
    expect(createProvider()).toBe('azure-provider');
    expect(mockCreateAzureProvider).toHaveBeenCalledWith(
      'https://my-resource.services.ai.azure.com/anthropic/v1',
    );
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
  });

  it('azure: an AZURE_FOUNDRY_BASE_URL override reaches the factory, mount set or not', () => {
    // The endpoint config resolved is the one that is used. Passing the mount here
    // instead is the defect this pins: an override could never apply.
    config.llmProvider = 'azure';
    config.nexusAzureBaseUrl = MOUNT.azure;
    config.azureChatEndpoint = 'https://foundry.example/anthropic/v1';
    createProvider();
    expect(mockCreateAzureProvider).toHaveBeenCalledWith('https://foundry.example/anthropic/v1');
  });

  it('bedrock-mantle → the resolved mantle chat endpoint', () => {
    config.llmProvider = 'bedrock-mantle';
    expect(createProvider()).toBe('bedrock-mantle-provider');
    expect(mockCreateBedrockMantleProvider).toHaveBeenCalledWith(
      'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1',
    );
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
  });

  it('bedrock-mantle: a BEDROCK_MANTLE_BASE_URL override reaches the factory, mount set or not', () => {
    config.llmProvider = 'bedrock-mantle';
    config.nexusBedrockMantleBaseUrl = MOUNT.mantle;
    config.bedrockMantleChatEndpoint = 'https://mantle.internal/anthropic/v1';
    createProvider();
    expect(mockCreateBedrockMantleProvider).toHaveBeenCalledWith(
      'https://mantle.internal/anthropic/v1',
    );
  });

  it('openai + nothing configured → the SDK default (undefined baseURL)', () => {
    config.llmProvider = 'openai';
    expect(createProvider()).toBe('openai-provider');
    expect(mockCreateOpenAiProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
    expect(mockCreateBedrockMantleProvider).not.toHaveBeenCalled();
  });

  it('openai: an OPENAI_BASE_URL override reaches the factory, mount set or not', () => {
    config.llmProvider = 'openai';
    config.nexusOpenAiBaseUrl = MOUNT.openai;
    config.openaiEndpoint = 'https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1';
    createProvider();
    expect(mockCreateOpenAiProvider).toHaveBeenCalledWith(
      'https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1',
    );
  });

  it('openrouter → the OpenRouter endpoint, never the openai one', () => {
    // Both speak the same OpenAI-shaped protocol, so the endpoint is the only
    // thing that distinguishes them — and the mount is what the
    // managed-inference gate checks: a policy selecting openrouter answers 403
    // on `/llm/openai/*`.
    config.llmProvider = 'openrouter';
    config.nexusOpenRouterBaseUrl = MOUNT.openrouter;
    config.nexusOpenAiBaseUrl = MOUNT.openai;
    config.openrouterEndpoint = MOUNT.openrouter;
    config.openaiEndpoint = MOUNT.openai;

    expect(createProvider()).toBe('openrouter-provider');
    expect(mockCreateOpenRouterProvider).toHaveBeenCalledWith(MOUNT.openrouter);
    expect(mockCreateOpenAiProvider).not.toHaveBeenCalled();
  });

  it('openrouter: an OPENROUTER_BASE_URL override reaches the factory, mount set or not', () => {
    config.llmProvider = 'openrouter';
    config.nexusOpenRouterBaseUrl = MOUNT.openrouter;
    config.openrouterEndpoint = 'https://proxy.example/openrouter/v1';
    createProvider();
    expect(mockCreateOpenRouterProvider).toHaveBeenCalledWith('https://proxy.example/openrouter/v1');
  });

  it('openai ignores the other vendors’ gateway mounts', () => {
    config.llmProvider = 'openai';
    config.nexusLlmBaseUrl = MOUNT.bedrock;
    config.nexusAzureBaseUrl = MOUNT.azure;
    createProvider();
    expect(mockCreateOpenAiProvider).toHaveBeenCalledWith(undefined);
  });

  it('anthropic → the direct-only factory, no baseURL argument', () => {
    config.llmProvider = 'anthropic';
    expect(createProvider()).toBe('anthropic-provider');
    expect(mockCreateAnthropicProvider).toHaveBeenCalledWith();
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
    expect(mockCreateBedrockMantleProvider).not.toHaveBeenCalled();
    expect(mockCreateOpenAiProvider).not.toHaveBeenCalled();
    expect(mockCreateOpenRouterProvider).not.toHaveBeenCalled();
  });

  it('anthropic stays direct even with every gateway mount set', () => {
    config.llmProvider = 'anthropic';
    config.nexusLlmBaseUrl = MOUNT.bedrock;
    config.nexusAzureBaseUrl = MOUNT.azure;
    config.nexusBedrockMantleBaseUrl = MOUNT.mantle;
    config.nexusOpenAiBaseUrl = MOUNT.openai;
    config.nexusOpenRouterBaseUrl = MOUNT.openrouter;
    expect(createProvider()).toBe('anthropic-provider');
    expect(mockCreateAnthropicProvider).toHaveBeenCalledWith();
  });
});

describe('isProviderConfigured', () => {
  beforeEach(() => {
    config.llmProvider = 'bedrock';
    vi.clearAllMocks();
  });

  it('delegates to isBedrockConfigured for bedrock', () => {
    mockIsBedrockConfigured.mockReturnValue(false);
    expect(isProviderConfigured()).toBe(false);
    expect(mockIsAzureConfigured).not.toHaveBeenCalled();
    expect(mockIsBedrockMantleConfigured).not.toHaveBeenCalled();
  });

  it('delegates to isOpenRouterConfigured for openrouter', () => {
    config.llmProvider = 'openrouter';
    mockIsOpenRouterConfigured.mockReturnValue(false);
    expect(isProviderConfigured()).toBe(false);
    expect(mockIsOpenAiConfigured).not.toHaveBeenCalled();
  });

  it('delegates to isAzureConfigured for azure', () => {
    config.llmProvider = 'azure';
    mockIsAzureConfigured.mockReturnValue(true);
    expect(isProviderConfigured()).toBe(true);
    expect(mockIsBedrockConfigured).not.toHaveBeenCalled();
    expect(mockIsBedrockMantleConfigured).not.toHaveBeenCalled();
  });

  it('delegates to isBedrockMantleConfigured for bedrock-mantle', () => {
    config.llmProvider = 'bedrock-mantle';
    mockIsBedrockMantleConfigured.mockReturnValue(false);
    expect(isProviderConfigured()).toBe(false);
    expect(mockIsBedrockConfigured).not.toHaveBeenCalled();
    expect(mockIsAzureConfigured).not.toHaveBeenCalled();
  });

  it('delegates to isOpenAiConfigured for openai', () => {
    config.llmProvider = 'openai';
    mockIsOpenAiConfigured.mockReturnValue(false);
    expect(isProviderConfigured()).toBe(false);
    expect(mockIsBedrockConfigured).not.toHaveBeenCalled();
    expect(mockIsAzureConfigured).not.toHaveBeenCalled();
    expect(mockIsBedrockMantleConfigured).not.toHaveBeenCalled();
  });

  it('delegates to isAnthropicConfigured for anthropic', () => {
    config.llmProvider = 'anthropic';
    mockIsAnthropicConfigured.mockReturnValue(false);
    expect(isProviderConfigured()).toBe(false);
    expect(mockIsBedrockConfigured).not.toHaveBeenCalled();
    expect(mockIsAzureConfigured).not.toHaveBeenCalled();
    expect(mockIsBedrockMantleConfigured).not.toHaveBeenCalled();
    expect(mockIsOpenAiConfigured).not.toHaveBeenCalled();
  });
});
