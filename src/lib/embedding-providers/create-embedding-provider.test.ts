/**
 * create-embedding-provider switch tests: vendor (bedrock/azure-openai/openai/
 * none) × routing (direct/nexus). Each vendor must ride its *own* Nexus mount,
 * decoupled from the chat mount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../../config';

const {
  mockCreateBedrockEmbeddingProvider,
  mockCreateAzureOpenAiEmbeddingProvider,
  mockCreateOpenAiEmbeddingProvider,
  mockCreateOpenRouterEmbeddingProvider,
} = vi.hoisted(() => ({
  mockCreateBedrockEmbeddingProvider: vi.fn(() => 'bedrock-embedding-provider'),
  mockCreateAzureOpenAiEmbeddingProvider: vi.fn(() => 'azure-openai-embedding-provider'),
  mockCreateOpenAiEmbeddingProvider: vi.fn(() => 'openai-embedding-provider'),
  mockCreateOpenRouterEmbeddingProvider: vi.fn(() => 'openrouter-embedding-provider'),
}));

vi.mock('./bedrock-embedding-provider', () => ({
  createBedrockEmbeddingProvider: mockCreateBedrockEmbeddingProvider,
}));
vi.mock('./azure-openai-embedding-provider', () => ({
  createAzureOpenAiEmbeddingProvider: mockCreateAzureOpenAiEmbeddingProvider,
}));
vi.mock('./openai-embedding-provider', () => ({
  createOpenAiEmbeddingProvider: mockCreateOpenAiEmbeddingProvider,
}));
vi.mock('./openrouter-embedding-provider', () => ({
  createOpenRouterEmbeddingProvider: mockCreateOpenRouterEmbeddingProvider,
}));

import { createEmbeddingProvider } from './create-embedding-provider';

describe('createEmbeddingProvider', () => {
  beforeEach(() => {
    config.embeddingProvider = 'bedrock';
    config.nexusLlmBaseUrl = null;
    config.nexusAzureOpenAiBaseUrl = null;
    config.nexusOpenAiBaseUrl = null;
    config.nexusOpenRouterBaseUrl = null;
    vi.clearAllMocks();
  });

  it('bedrock + no nexus URL → direct Titan (undefined baseURL)', () => {
    expect(createEmbeddingProvider()).toBe('bedrock-embedding-provider');
    expect(mockCreateBedrockEmbeddingProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateAzureOpenAiEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockCreateOpenAiEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('bedrock + nexus URL → Titan over the bedrock-runtime mount', () => {
    config.nexusLlmBaseUrl = 'https://nexus.example/llm/bedrock/us-east-1';
    expect(createEmbeddingProvider()).toBe('bedrock-embedding-provider');
    expect(mockCreateBedrockEmbeddingProvider).toHaveBeenCalledWith(
      'https://nexus.example/llm/bedrock/us-east-1',
    );
  });

  it('azure-openai + no nexus URL → direct Azure OpenAI (undefined baseURL)', () => {
    config.embeddingProvider = 'azure-openai';
    expect(createEmbeddingProvider()).toBe('azure-openai-embedding-provider');
    expect(mockCreateAzureOpenAiEmbeddingProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateBedrockEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('azure-openai + nexus URL → the gateway azure openai mount', () => {
    config.embeddingProvider = 'azure-openai';
    config.nexusAzureOpenAiBaseUrl = 'https://nexus.example/llm/azure/openai/v1';
    expect(createEmbeddingProvider()).toBe('azure-openai-embedding-provider');
    expect(mockCreateAzureOpenAiEmbeddingProvider).toHaveBeenCalledWith(
      'https://nexus.example/llm/azure/openai/v1',
    );
  });

  it('openai + no nexus URL → direct OpenAI (undefined baseURL)', () => {
    config.embeddingProvider = 'openai';
    expect(createEmbeddingProvider()).toBe('openai-embedding-provider');
    expect(mockCreateOpenAiEmbeddingProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateBedrockEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureOpenAiEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('openai + nexus URL → the gateway openai mount', () => {
    config.embeddingProvider = 'openai';
    config.nexusOpenAiBaseUrl = 'https://nexus.example/llm/openai/v1';
    expect(createEmbeddingProvider()).toBe('openai-embedding-provider');
    expect(mockCreateOpenAiEmbeddingProvider).toHaveBeenCalledWith(
      'https://nexus.example/llm/openai/v1',
    );
  });

  it('openrouter + no gateway URL → direct openrouter.ai (undefined baseURL)', () => {
    config.embeddingProvider = 'openrouter';
    expect(createEmbeddingProvider()).toBe('openrouter-embedding-provider');
    expect(mockCreateOpenRouterEmbeddingProvider).toHaveBeenCalledWith(undefined);
    expect(mockCreateOpenAiEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('openrouter + gateway URL → the gateway openrouter mount, not the openai one', () => {
    config.embeddingProvider = 'openrouter';
    config.nexusOpenAiBaseUrl = 'https://nexus.example/llm/openai/v1';
    config.nexusOpenRouterBaseUrl = 'https://nexus.example/llm/openrouter/openai/v1';
    expect(createEmbeddingProvider()).toBe('openrouter-embedding-provider');
    expect(mockCreateOpenRouterEmbeddingProvider).toHaveBeenCalledWith(
      'https://nexus.example/llm/openrouter/openai/v1',
    );
  });

  it('each vendor ignores the other vendors’ mounts', () => {
    config.embeddingProvider = 'openai';
    config.nexusLlmBaseUrl = 'https://nexus.example/llm/bedrock/us-east-1';
    config.nexusAzureOpenAiBaseUrl = 'https://nexus.example/llm/azure/openai/v1';
    createEmbeddingProvider();
    expect(mockCreateOpenAiEmbeddingProvider).toHaveBeenCalledWith(undefined);
  });

  it('none → null, no factory called', () => {
    config.embeddingProvider = 'none';
    expect(createEmbeddingProvider()).toBeNull();
    expect(mockCreateBedrockEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockCreateAzureOpenAiEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockCreateOpenAiEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockCreateOpenRouterEmbeddingProvider).not.toHaveBeenCalled();
  });
});
