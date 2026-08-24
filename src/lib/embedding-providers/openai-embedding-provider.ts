/**
 * OpenAI embeddings (a `text-embedding-3` model) — the `openai` embedding
 * provider. Direct mode honors `OPENAI_BASE_URL`.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { config } from '../../config';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embedding-provider';

export function createOpenAiEmbeddingProvider(baseURL?: string): EmbeddingProvider {
  // Through Nexus the gateway injects the real key on the outbound leg, so no
  // local key is needed — but the SDK insists on one, so fall back to a decoy
  // (the same pattern as the chat factories).
  const openai = createOpenAI({
    apiKey: config.openaiApiKey || (baseURL ? 'managed' : undefined),
    // undefined → the SDK's own default, https://api.openai.com/v1.
    baseURL: baseURL ?? config.openaiBaseUrl,
  });
  return {
    model: (modelId: string) => openai.embedding(modelId),
    // text-embedding-3 truncates to the target under the `openai` key.
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
  };
}
