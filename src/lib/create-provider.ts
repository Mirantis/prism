/**
 * Unified LLM provider factory.
 *
 * Picks between the direct Bedrock provider and the Nexus-routed provider
 * based on whether `config.nexusLlmBaseUrl` is set. Both underlying
 * factories return the same call shape — a callable
 * `(modelId) => LanguageModel` with `.embedding(modelId)` attached — so
 * callers don't have to care which path is in use.
 */

import { config } from '../config';
import { createBedrockProvider } from './bedrock-provider';
import { createNexusProvider } from './nexus-provider';

export function createProvider() {
  return config.nexusLlmBaseUrl
    ? createNexusProvider(config.nexusLlmBaseUrl)
    : createBedrockProvider();
}
