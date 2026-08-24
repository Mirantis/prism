/**
 * Azure OpenAI embeddings (a `text-embedding-3` deployment) — the
 * `azure-openai` embedding provider. An AI Services/Foundry resource serving
 * Claude chat on its Anthropic surface serves embeddings from its OpenAI
 * surface with the same resource-level key; the deployment must exist on the
 * resource, else memory embedding fails open (embedding.service catches and
 * returns null).
 *
 * `baseURL` selects routing: set → the Nexus gateway's `…/llm/azure/openai/v1`
 * mount (the SDK treats a non-*.openai.azure.com base as a custom gateway and
 * appends `/embeddings` bare, landing on the resource's
 * `/openai/v1/embeddings`); unset → the endpoint derived from the resource
 * name.
 */

import { createAzure } from '@ai-sdk/azure';
import { config } from '../../config';
import { EMBEDDING_DIMENSIONS, type EmbeddingProvider } from './embedding-provider';

export function createAzureOpenAiEmbeddingProvider(baseURL?: string): EmbeddingProvider {
  // Through Nexus the gateway injects the real key on the outbound leg, so no
  // local key is needed — but the SDK insists on one, so fall back to a decoy
  // (the same pattern as the chat factories).
  const azure = baseURL
    ? createAzure({
        apiKey: config.azureApiKey || 'managed',
        baseURL,
      })
    : createAzure({
        apiKey: config.azureApiKey,
        resourceName: config.azureResourceName,
        // undefined → SDK default
        apiVersion: config.azureApiVersion || undefined,
      });
  return {
    model: (modelId: string) => azure.embedding(modelId),
    // text-embedding-3 truncates to the target under the `openai` key.
    providerOptions: { openai: { dimensions: EMBEDDING_DIMENSIONS } },
  };
}
