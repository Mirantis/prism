/**
 * Embedding Service
 *
 * Handles vector embedding generation for memory entries. Storage and
 * search are delegated to `memoryEmbeddingStore` (sqlite-vec backed).
 * Bedrock credentials are injected into the sandbox environment.
 */

import { embed, embedMany, type EmbeddingModel } from 'ai';
import { createProvider } from '../lib/create-provider';
import { config } from '../config';
import { logger } from '../logger';
import { memoryEmbeddingStore, type SearchOptions } from './memory-store';
import type { MemorySearchResult } from './memory-manager.service';

const BEDROCK_EMBEDDING_PROVIDER_OPTIONS = {
  bedrock: { dimensions: 1024 as const },
};

class EmbeddingService {
  private getEmbeddingModel(): EmbeddingModel {
    return createProvider().embedding(config.bedrockEmbeddingModelId);
  }

  /** Generate an embedding vector for the given text. */
  async generateEmbedding(agentId: string, text: string): Promise<number[] | null> {
    try {
      const { embedding } = await embed({
        model: this.getEmbeddingModel(),
        value: text,
        providerOptions: BEDROCK_EMBEDDING_PROVIDER_OPTIONS,
        experimental_telemetry: { isEnabled: true, functionId: 'memory-embedding' },
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

    try {
      const { embeddings } = await embedMany({
        model: this.getEmbeddingModel(),
        values: texts,
        // Serialize requests through the Bedrock proxy. embedMany may
        // otherwise split a large `values` batch and dispatch in parallel,
        // which trips Titan v2's per-account rate limit during heavy
        // backfills. Caller-side BATCH_SIZE keeps the per-call payload
        // small; this guards the rare case where the SDK still parallelizes.
        maxParallelCalls: 1,
        providerOptions: BEDROCK_EMBEDDING_PROVIDER_OPTIONS,
        experimental_telemetry: { isEnabled: true, functionId: 'memory-embedding-backfill' },
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
