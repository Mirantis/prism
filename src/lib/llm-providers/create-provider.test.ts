/**
 * create-provider switch tests: vendor (bedrock/azure/bedrock-mantle/openai)
 * x routing (direct/nexus).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const {
  mockCreateBedrockProvider,
  mockCreateAzureProvider,
  mockCreateBedrockMantleProvider,
  mockCreateOpenAiProvider,
  mockIsBedrockConfigured,
  mockIsAzureConfigured,
  mockIsBedrockMantleConfigured,
  mockIsOpenAiConfigured,
} = vi.hoisted(() => ({
  mockCreateBedrockProvider: vi.fn(() => 'bedrock-provider'),
  mockCreateAzureProvider: vi.fn(() => 'azure-provider'),
  mockCreateBedrockMantleProvider: vi.fn(() => 'bedrock-mantle-provider'),
  mockCreateOpenAiProvider: vi.fn(() => 'openai-provider'),
  mockIsBedrockConfigured: vi.fn(() => true),
  mockIsAzureConfigured: vi.fn(() => true),
  mockIsBedrockMantleConfigured: vi.fn(() => true),
  mockIsOpenAiConfigured: vi.fn(() => true),
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

import { createProvider, isProviderConfigured } from './create-provider';

describe('createProvider', () => {
  beforeEach(() => {
    config.llmProvider = 'bedrock';
    config.nexusLlmBaseUrl = null;
    config.nexusAzureBaseUrl = null;
    config.nexusBedrockMantleBaseUrl = null;
    config.nexusOpenAiBaseUrl = null;
    vi.clearAllMocks();
  });

  it('bedrock + no nexus URL → direct Bedrock (undefined baseURL)', () => {
    expect(createProvider()).toBe('bedrock-provider');
    expect(mockCreateBedrockProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
  });

  it('bedrock + nexus URL → Bedrock with the Nexus baseURL', () => {
    config.nexusLlmBaseUrl = 'https://nexus.example/llm/bedrock/us-east-1';
    expect(createProvider()).toBe('bedrock-provider');
    expect(mockCreateBedrockProvider).toHaveBeenCalledWith('https://nexus.example/llm/bedrock/us-east-1');
  });

  it('azure + no nexus URL → direct Azure (undefined baseURL)', () => {
    config.llmProvider = 'azure';
    expect(createProvider()).toBe('azure-provider');
    expect(mockCreateAzureProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
  });

  it('azure + nexus Azure URL → Nexus-routed Azure', () => {
    config.llmProvider = 'azure';
    config.nexusAzureBaseUrl = 'https://nexus.example/llm/azure/anthropic/v1';
    expect(createProvider()).toBe('azure-provider');
    expect(mockCreateAzureProvider).toHaveBeenCalledWith('https://nexus.example/llm/azure/anthropic/v1');
  });

  it('bedrock-mantle + no nexus URL → direct mantle (undefined baseURL)', () => {
    config.llmProvider = 'bedrock-mantle';
    expect(createProvider()).toBe('bedrock-mantle-provider');
    expect(mockCreateBedrockMantleProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
  });

  it('bedrock-mantle + nexus mantle URL → Nexus-routed mantle', () => {
    config.llmProvider = 'bedrock-mantle';
    config.nexusBedrockMantleBaseUrl =
      'https://nexus.example/llm/bedrock-mantle/anthropic/us-east-1/v1';
    expect(createProvider()).toBe('bedrock-mantle-provider');
    expect(mockCreateBedrockMantleProvider).toHaveBeenCalledWith(
      'https://nexus.example/llm/bedrock-mantle/anthropic/us-east-1/v1',
    );
  });

  it('bedrock-mantle ignores the bedrock-runtime Nexus mount for chat', () => {
    config.llmProvider = 'bedrock-mantle';
    config.nexusLlmBaseUrl = 'https://nexus.example/llm/bedrock/us-east-1';
    createProvider();
    expect(mockCreateBedrockMantleProvider).toHaveBeenCalledWith(undefined);
  });

  it('openai + no nexus URL → direct OpenAI (undefined baseURL)', () => {
    config.llmProvider = 'openai';
    expect(createProvider()).toBe('openai-provider');
    expect(mockCreateOpenAiProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateBedrockProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureProvider).not.toHaveBeenCalled();
    expect(mockCreateBedrockMantleProvider).not.toHaveBeenCalled();
  });

  it('openai + nexus openai URL → Nexus-routed OpenAI', () => {
    config.llmProvider = 'openai';
    config.nexusOpenAiBaseUrl = 'https://nexus.example/llm/openai/v1';
    expect(createProvider()).toBe('openai-provider');
    expect(mockCreateOpenAiProvider).toHaveBeenCalledWith('https://nexus.example/llm/openai/v1');
  });

  it('openai ignores the other vendors’ Nexus mounts', () => {
    config.llmProvider = 'openai';
    config.nexusLlmBaseUrl = 'https://nexus.example/llm/bedrock/us-east-1';
    config.nexusAzureBaseUrl = 'https://nexus.example/llm/azure/anthropic/v1';
    createProvider();
    expect(mockCreateOpenAiProvider).toHaveBeenCalledWith(undefined);
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
});
