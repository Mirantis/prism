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

/**
 * Which provider `createProvider()` will pick: `'nexus'` when a Nexus LLM
 * base URL is configured, otherwise `'direct'` Bedrock. Exposed so startup
 * can log the selection once instead of on every (hot-path) invocation.
 */
export function getProviderType(): 'nexus' | 'direct' {
  return config.nexusLlmBaseUrl ? 'nexus' : 'direct';
}

export function createProvider() {
  return getProviderType() === 'nexus'
    ? createNexusProvider(config.nexusLlmBaseUrl!)
    : createBedrockProvider();
}
