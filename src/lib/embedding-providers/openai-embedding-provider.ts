/**
 * OpenAI embeddings (a `text-embedding-3` model) — the `openai` embedding
 * provider. `OPENAI_BASE_URL` is one variable for the whole OpenAI surface, so
 * embeddings follow it wherever chat goes; `config.openaiEndpoint` resolves it
 * against the gateway mount and this factory takes the result.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { config, isGatewayEndpoint } from '../../config';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embedding-provider';

export function createOpenAiEmbeddingProvider(baseURL?: string): EmbeddingProvider {
  // On the gateway the real key is injected on the outbound leg, so no local key
  // is needed — but the SDK insists on one, so fall back to a decoy (the same
  // pattern as the chat factories).
  const openai = createOpenAI({
    apiKey: config.openaiApiKey || (isGatewayEndpoint(baseURL) ? 'managed' : undefined),
    // undefined → the SDK's own default, https://api.openai.com/v1.
    baseURL,
  });
  return {
    model: (modelId: string) => openai.embedding(modelId),
    // text-embedding-3 truncates to the target under the `openai` key.
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
  };
}
