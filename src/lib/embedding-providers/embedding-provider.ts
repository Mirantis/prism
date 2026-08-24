/**
 * The shape every embedding vendor factory returns.
 *
 * Embeddings are their own feature, decoupled from the chat provider: which
 * vendor embeds memory is selected by `config.embeddingProvider`, not derived
 * from `LLM_PROVIDER`, because the two don't align — a chat vendor may serve
 * no embedding models at all, and a future embedding vendor (Voyage AI) may
 * serve no chat.
 *
 * Same TS2742 rule as `LlmProvider`: the vendor SDKs re-export nested
 * `@ai-sdk/provider` copies, so annotate every factory with this type rather
 * than letting the return be inferred.
 */

import type { EmbeddingModel } from 'ai';
import type { ProviderOptionsFragment } from '../llm-providers/llm-provider';

/**
 * The vector width every vendor must emit — and the width of the sqlite-vec
 * index itself (`sqlite-bootstrap.ts` builds its vec0 table from this same
 * constant, so the two cannot drift apart).
 */
export const EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingProvider = {
  /** The embedding model `embed()`/`embedMany()` consume. */
  model: (modelId: string) => EmbeddingModel;
  /**
   * The `providerOptions` fragment to send with every embedding call. It
   * carries the 1024-dim truncation target under the namespace the serving
   * SDK reads (`bedrock` for Titan, `openai` for the text-embedding-3
   * models). A wrong namespace is silently ignored and yields
   * wrong-dimension vectors, which is why the fragment lives on the provider
   * rather than on the caller.
   */
  providerOptions: ProviderOptionsFragment;
};
