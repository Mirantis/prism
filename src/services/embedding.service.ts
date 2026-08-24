/**
 * Embedding Service
 *
 * Handles vector embedding generation for memory entries. Storage and
 * search are delegated to `memoryEmbeddingStore` (sqlite-vec backed).
 * The embedding model comes from the embedding provider
 * (`lib/embedding-providers/`), selected by `EMBEDDING_PROVIDER` independently
 * of the chat vendor. The model is optional — when unset (or the provider is
 * `none`), embedding generation fail-opens (returns null) and memory search
 * is effectively disabled.
 */

import { embed, embedMany } from 'ai';
import { createEmbeddingProvider } from '../lib/embedding-providers/create-embedding-provider';
import { config } from '../config';
import { logger } from '../logger';
import { langfuseEmbedTelemetry } from '../lib/telemetry';
import { memoryEmbeddingStore, type SearchOptions } from './memory-store';
import type { MemorySearchResult } from './memory-manager.service';

class EmbeddingService {
  /** Generate an embedding vector for the given text. */
  async generateEmbedding(agentId: string, text: string): Promise<number[] | null> {
    if (!config.embeddingModelId) {
      // No embedding model configured (EMBEDDING_PROVIDER=none, or the active
      // vendor's embedding var set to '') — skip the SDK call entirely instead
      // of failing on a '' model name.
      logger.warn({ agentId }, 'No embedding model configured; skipping embedding generation');
      return null;
    }
    try {
      // Constructed inside the try so a factory that ever starts validating
      // eagerly still fail-opens instead of rejecting past the callers that
      // have no catch of their own (memory search).
      const provider = createEmbeddingProvider();
      if (!provider) {
        // Unreachable via config — `none` resolves the model id to '' and the
        // guard above fires first — kept so the null contract holds if that
        // coupling ever loosens.
        logger.warn({ agentId }, 'No embedding provider configured; skipping embedding generation');
        return null;
      }
      const { embedding } = await embed({
        model: provider.model(config.embeddingModelId),
        value: text,
        providerOptions: provider.providerOptions,
        ...langfuseEmbedTelemetry('memory-embedding'),
      });

      return embedding;
    } catch (err) {
      logger.warn({ err, agentId }, 'Failed to generate embedding');
      return null;
    }
  }

  /** Generate embeddings for a batch of texts. */
  async generateEmbeddings(agentId: string, texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) {
      return [];
    }
    if (!config.embeddingModelId) {
      logger.warn({ agentId }, 'No embedding model configured; skipping embedding backfill');
      return null;
    }

    try {
      const provider = createEmbeddingProvider();
      if (!provider) {
        logger.warn({ agentId }, 'No embedding provider configured; skipping embedding backfill');
        return null;
      }
      const { embeddings } = await embedMany({
        model: provider.model(config.embeddingModelId),
        values: texts,
        // Serialize requests: embedMany may otherwise split a large `values`
        // batch and dispatch in parallel, which trips per-account rate limits
        // during heavy backfills (Titan v2 on Bedrock; Azure OpenAI throttles
        // per-deployment the same way). Caller-side BATCH_SIZE keeps the
        // per-call payload small; this guards the rare case where the SDK
        // still parallelizes.
        maxParallelCalls: 1,
        providerOptions: provider.providerOptions,
        ...langfuseEmbedTelemetry('memory-embedding-backfill'),
      });

      return embeddings;
    } catch (err) {
      logger.warn({ err, agentId }, 'Failed to generate embeddings');
      return null;
    }
  }

  /** Persist an embedding for a memory entry (provider-aware). */
  async storeEmbedding(entryId: string, embedding: number[]): Promise<void> {
    await memoryEmbeddingStore.storeEmbedding(entryId, embedding);
  }

  /** Generate embedding and store it for a memory entry. */
  async generateAndStoreEmbedding(agentId: string, entryId: string, content: string): Promise<void> {
    const embedding = await this.generateEmbedding(agentId, content);
    if (embedding) {
      await this.storeEmbedding(entryId, embedding);
    }
  }

  /** Cosine-similarity search over memory embeddings (provider-aware). */
  async searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    options: SearchOptions,
  ): Promise<MemorySearchResult[]> {
    return memoryEmbeddingStore.searchByEmbedding(agentId, queryEmbedding, options);
  }
}

export const embeddingService = new EmbeddingService();
