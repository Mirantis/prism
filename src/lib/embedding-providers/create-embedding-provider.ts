/**
 * Unified embedding provider factory — the embedding counterpart of
 * `llm-providers/create-provider.ts`, and deliberately separate from it: which
 * vendor embeds memory (`config.embeddingProvider`) is decoupled from which
 * vendor chats (`config.llmProvider`).
 *
 * Each case keys off its *own* endpoint rather than the chat vendor's, so
 * embedding routing survives independently of chat routing — bedrock-mantle
 * chats on its own mount while Titan embeds over `nexusLlmBaseUrl`, and a
 * chat vendor with no gateway mount at all can still embed through the
 * gateway. `OPENAI_BASE_URL` and `OPENROUTER_BASE_URL` are each one endpoint for
 * a whole vendor surface, so the openai and openrouter legs follow the override
 * their chat leg follows.
 *
 * Returns null for `none` — the explicit "no embeddings". Config resolves the
 * embedding model id to '' in that case, so `embedding.service.ts`'s skip
 * guard fires before this factory is ever called.
 */

import { config } from '../../config';
import { createAzureOpenAiEmbeddingProvider } from './azure-openai-embedding-provider';
import { createBedrockEmbeddingProvider } from './bedrock-embedding-provider';
import { createOpenAiEmbeddingProvider } from './openai-embedding-provider';
import { createOpenRouterEmbeddingProvider } from './openrouter-embedding-provider';
import type { EmbeddingProvider } from './embedding-provider';

export function createEmbeddingProvider(): EmbeddingProvider | null {
  switch (config.embeddingProvider) {
    case 'none':
      return null;
    case 'azure-openai':
      return createAzureOpenAiEmbeddingProvider(config.nexusAzureOpenAiBaseUrl ?? undefined);
    case 'openai':
      return createOpenAiEmbeddingProvider(config.openaiEndpoint);
    case 'openrouter':
      return createOpenRouterEmbeddingProvider(config.openrouterEndpoint);
    default:
      return createBedrockEmbeddingProvider(config.nexusLlmBaseUrl ?? undefined);
  }
}
