/**
 * create-provider switch tests: vendor (bedrock/azure) x routing (direct/nexus).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../config';

const {
  mockCreateBedrockProvider,
  mockCreateAzureProvider,
  mockIsBedrockConfigured,
  mockIsAzureConfigured,
} = vi.hoisted(() => ({
  mockCreateBedrockProvider: vi.fn(() => 'bedrock-provider'),
  mockCreateAzureProvider: vi.fn(() => 'azure-provider'),
  mockIsBedrockConfigured: vi.fn(() => true),
  mockIsAzureConfigured: vi.fn(() => true),
}));

vi.mock('./bedrock-provider', () => ({
  createBedrockProvider: mockCreateBedrockProvider,
  isBedrockConfigured: mockIsBedrockConfigured,
}));
vi.mock('./azure-provider', () => ({
  createAzureProvider: mockCreateAzureProvider,
  isAzureConfigured: mockIsAzureConfigured,
}));

import { createProvider, isProviderConfigured } from './create-provider';

describe('createProvider', () => {
  beforeEach(() => {
    config.llmProvider = 'bedrock';
    config.nexusLlmBaseUrl = null;
    config.nexusAzureBaseUrl = null;
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
    config.nexusAzureBaseUrl = 'https://nexus.example/llm/azure/v1';
    expect(createProvider()).toBe('azure-provider');
    expect(mockCreateAzureProvider).toHaveBeenCalledWith('https://nexus.example/llm/azure/v1');
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
  });

  it('delegates to isAzureConfigured for azure', () => {
    config.llmProvider = 'azure';
    mockIsAzureConfigured.mockReturnValue(true);
    expect(isProviderConfigured()).toBe(true);
    expect(mockIsBedrockConfigured).not.toHaveBeenCalled();
  });
});
