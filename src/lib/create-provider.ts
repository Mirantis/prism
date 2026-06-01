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
import { logger } from '../logger';
import { createBedrockProvider } from './bedrock-provider';
import { createNexusProvider } from './nexus-provider';

export function createProvider() {
  logger.info(
    `createProvider: using ${config.nexusLlmBaseUrl ? 'Nexus' : 'direct Bedrock'} provider (nexusLlmBaseUrl=${config.nexusLlmBaseUrl ?? 'null'})`,
  );
  return config.nexusLlmBaseUrl
    ? createNexusProvider(config.nexusLlmBaseUrl)
    : createBedrockProvider();
}
