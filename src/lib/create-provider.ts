/**
 * Unified LLM provider factory.
 *
 * Two orthogonal choices:
 *  - Vendor: `config.llmProvider` (`bedrock` default, or `azure`).
 *  - Routing: direct vs. through the Nexus gateway, decided per vendor by
 *    whether its Nexus base URL is set (`nexusLlmBaseUrl` / `nexusAzureBaseUrl`).
 *
 * Every underlying factory returns the same call shape — a callable
 * `(modelId) => LanguageModel` with `.embedding(modelId)` attached — so callers
 * don't have to care which vendor or route is in use.
 */

import { config } from '../config';
import { createBedrockProvider, isBedrockConfigured } from './bedrock-provider';
import { createNexusProvider } from './nexus-provider';
import { createAzureProvider, isAzureConfigured } from './azure-provider';

export function createProvider() {
  if (config.llmProvider === 'azure') {
    // baseURL set → Nexus routing; unset → direct Azure.
    return createAzureProvider(config.nexusAzureBaseUrl ?? undefined);
  }
  return config.nexusLlmBaseUrl
    ? createNexusProvider(config.nexusLlmBaseUrl)
    : createBedrockProvider();
}

/** Whether the selected provider has the config it needs to serve requests. */
export function isProviderConfigured(): boolean {
  return config.llmProvider === 'azure' ? isAzureConfigured() : isBedrockConfigured();
}
