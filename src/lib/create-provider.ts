/**
 * Unified LLM provider factory.
 *
 * Two orthogonal choices:
 *  - Vendor: `config.llmProvider` (`bedrock` default, or `azure`).
 *  - Routing: each vendor's factory takes an optional Nexus base URL — set →
 *    route through the Nexus gateway, unset → direct to the vendor.
 *
 * Every underlying factory returns the same call shape — a callable
 * `(modelId) => LanguageModel` with `.embedding(modelId)` attached — so callers
 * don't have to care which vendor or route is in use.
 */

import { config } from '../config';
import { createBedrockProvider, isBedrockConfigured } from './bedrock-provider';
import { createAzureProvider, isAzureConfigured } from './azure-provider';

export function createProvider() {
  return config.llmProvider === 'azure'
    ? createAzureProvider(config.nexusAzureBaseUrl ?? undefined)
    : createBedrockProvider(config.nexusLlmBaseUrl ?? undefined);
}

/** Whether the selected provider has the config it needs to serve requests. */
export function isProviderConfigured(): boolean {
  return config.llmProvider === 'azure' ? isAzureConfigured() : isBedrockConfigured();
}
