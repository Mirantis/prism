/**
 * Embedding Service
 *
 * Handles vector embedding generation for memory entries. Storage and
 * search are delegated to `memoryEmbeddingStore` (provider-aware:
 * pgvector in multi-tenant mode, sqlite-vec in single-agent mode).
 * Embedding generation itself routes through Nexus when an agent token
 * is available (usage tracking, audit trail, spending limits).
 */

import { embed, embedMany } from 'ai';
import { createBedrockProvider } from '../lib/bedrock-provider';
import { createNexusProvider } from '../lib/nexus-provider';
import { agentWorkspaceService } from './agent-workspace.service';
import { config } from '../config';
import { logger } from '../logger';
import { memoryEmbeddingStore, type SearchOptions } from './memory-store';
import type { MemorySearchResult } from './memory-manager.service';

const BEDROCK_EMBEDDING_PROVIDER_OPTIONS = {
  bedrock: { dimensions: 1024 as const },
};

class EmbeddingService {
  private async getEmbeddingModel(agentId: string) {
    const agentToken = await agentWorkspaceService.getNexusMcpAgentToken();
    if (agentToken && config.nexusLlmBaseUrl) {
      const provider = createNexusProvider(config.nexusLlmBaseUrl, agentToken);
      return provider.embedding(config.bedrockEmbeddingModelId);
    }

    const provider = createBedrockProvider();
    return provider.embedding(config.bedrockEmbeddingModelId);
  }

  /**
   * Generate an embedding vector for the given text.
   * Multi-tenant routes through Nexus for usage tracking, audit trail, and
   * spending limits. Single-agent mode falls back to the direct Bedrock
   * provider because credentials are injected into the sandbox environment.
   */
  async generateEmbedding(agentId: string, text: string): Promise<number[] | null> {
    try {
      const model = await this.getEmbeddingModel(agentId);
      if (!model) {
        return null;
      }

      const { embedding } = await embed({
        model,
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

  /** Generate embeddings for a batch of texts using the same auth path. */
  async generateEmbeddings(agentId: string, texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) {
      return [];
    }

    try {
      const model = await this.getEmbeddingModel(agentId);
      if (!model) {
        return null;
      }

      const { embeddings } = await embedMany({
        model,
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
