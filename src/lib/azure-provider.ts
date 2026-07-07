/**
 * Azure OpenAI Provider for Vercel AI SDK
 *
 * The OpenAI-vendor counterpart to `bedrock-provider.ts`. Unlike Bedrock there
 * is no model-family dispatch — Azure OpenAI is uniformly OpenAI-shaped — so a
 * single `createAzure(...)` instance serves both chat and embeddings.
 *
 * Two routing modes, chosen by whether a `baseURL` is passed:
 *
 * 1. Direct: no baseURL → the SDK builds the URL from `resourceName`
 *    (`https://{resourceName}.openai.azure.com/openai/v1`).
 * 2. Nexus: a baseURL (the Nexus Azure gateway) → the SDK ignores
 *    `resourceName` and prefixes calls with it. Nexus handles auth/usage/audit.
 *
 * Auth: `AZURE_API_KEY` is sent as the `api-key` header. The value may be a
 * `__nexus_cred:<uuid>__` sentinel that the MITM proxy rewrites on the wire to
 * the real key — transparent here, exactly like the Bedrock bearer token.
 */

import { createAzure } from '@ai-sdk/azure';
import type { LanguageModelV3, EmbeddingModelV3 } from '@ai-sdk/provider';
import { config } from '../config';
import { logger } from '../logger';

// The shared provider shape (mirrors bedrock-provider's inferred return). An
// explicit annotation is required here: Azure's SDK re-exports DeepSeek types,
// so the inferred return would reference a nested `@ai-sdk/provider` copy and
// trip TS2742 (non-portable type).
type LlmProvider = ((modelId: string) => LanguageModelV3) & {
  embedding: (modelId: string) => EmbeddingModelV3;
};

export function createAzureProvider(baseURL?: string): LlmProvider {
  logger.info(
    { routing: baseURL ? 'nexus' : 'direct' },
    'Creating Azure OpenAI provider',
  );

  const azure = createAzure({
    apiKey: config.azureApiKey,
    // undefined → SDK default ('preview')
    apiVersion: config.azureApiVersion || undefined,
    // baseURL (Nexus) takes precedence; the SDK ignores resourceName when set.
    ...(baseURL ? { baseURL } : { resourceName: config.azureResourceName }),
  });

  const dispatcher = (modelId: string) => azure(modelId);
  return Object.assign(dispatcher, {
    embedding: (modelId: string) => azure.embedding(modelId),
  });
}

/**
 * Check if Azure is configured: a chat deployment, an api-key, and an endpoint
 * (either a Nexus base URL or a direct resource name).
 */
export function isAzureConfigured(): boolean {
  return Boolean(
    config.azureModelId &&
      config.azureApiKey &&
      (config.nexusAzureBaseUrl || config.azureResourceName),
  );
}
