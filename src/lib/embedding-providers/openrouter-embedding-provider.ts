/**
 * OpenRouter embeddings — the `openrouter` embedding provider. openrouter.ai
 * serves `/embeddings` on its OpenAI-compatible surface, so this is the OpenAI
 * SDK pointed at OpenRouter's endpoint with the OpenRouter key. No default
 * model: the vendors OpenRouter routes differ in native dimensionality while
 * the memory index is fixed, so `OPENROUTER_EMBEDDING_MODEL_ID` stays empty
 * (embeddings off) until the operator names one —
 * `openai/text-embedding-3-small` truncates to 1024 and works.
 *
 * `baseURL` is the resolved endpoint: `OPENROUTER_BASE_URL`, else the gateway's
 * `…/llm/openrouter/openai/v1` mount, else openrouter.ai. That variable is one
 * endpoint for the whole surface, so embeddings follow it wherever chat goes.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { config, isGatewayEndpoint } from '../../config';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embedding-provider';

export function createOpenRouterEmbeddingProvider(baseURL: string): EmbeddingProvider {
  // On the gateway the real key is injected on the outbound leg, so no local key
  // is needed — but the SDK insists on one, so fall back to a decoy (the same
  // pattern as the chat factories).
  const openai = createOpenAI({
    apiKey: config.openrouterApiKey || (isGatewayEndpoint(baseURL) ? 'managed' : undefined),
    baseURL,
  });
  return {
    model: (modelId: string) => openai.embedding(modelId),
    // OpenRouter rides the OpenAI SDK, so the truncation target goes under the
    // `openai` key — a fragment addressed to another SDK is silently ignored
    // and the model returns its native dimensionality.
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
  };
}
