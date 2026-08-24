/**
 * Embedding Service
 *
 * Handles vector embedding generation for memory entries. Storage and
 * search are delegated to `memoryEmbeddingStore` (sqlite-vec backed).
 * The embedding model comes from the active LLM provider: Titan on
 * Bedrock, an Azure OpenAI text-embedding-3 deployment on Azure, Titan
 * again on bedrock-mantle (which serves no embedding models of its own, so
 * its provider reaches bedrock-runtime for this leg), and text-embedding-3
 * on OpenAI. On every vendor but Bedrock the model is optional — when
 * unset, embedding generation fail-opens (returns null) and memory search
 * is effectively disabled.
 */

import { embed, embedMany, type EmbeddingModel } from 'ai';
import { createProvider } from '../lib/llm-providers/create-provider';
import { config } from '../config';
import { logger } from '../logger';
import { langfuseEmbedTelemetry } from '../lib/telemetry';
import { memoryEmbeddingStore, type SearchOptions } from './memory-store';
import type { MemorySearchResult } from './memory-manager.service';

// The sqlite-vec index is fixed at 1024 dims (see EMBEDDING_DIM in
// sqlite-bootstrap.ts), so every vendor must emit exactly that. Titan v2 takes
// the target under the `bedrock` key; the text-embedding-3 models Azure and
// OpenAI serve truncate to it under the `openai` key.
//
// The key must match the SDK actually serving embeddings, not the vendor's name:
// the AI SDK ignores provider options addressed elsewhere, so a mismatch is
// silent — the model returns its native dimensionality and the only symptom is
// vectors the index cannot hold. That is why the arms are split by SDK.
// `bedrock-mantle` is on the `bedrock` arm because it has no embedding surface
// of its own (those calls go to Titan on bedrock-runtime), and `openrouter` is
// on the `openai` arm because it rides the OpenAI provider code.
//
// A function rather than an inline conditional so the rule can be asserted per
// provider without re-importing this module (which drags in the sqlite-vec
// handle) just to vary one env var.
const EMBEDDING_DIMENSIONS = 1024;

export function embeddingProviderOptions(
  provider: string,
): Record<string, Record<string, number>> {
  const openAiShaped = provider === 'azure' || provider === 'openai' || provider === 'openrouter';
  return openAiShaped
    ? { openai: { dimensions: EMBEDDING_DIMENSIONS } }
    : { bedrock: { dimensions: EMBEDDING_DIMENSIONS } };
}

const EMBEDDING_PROVIDER_OPTIONS = embeddingProviderOptions(config.llmProvider);

class EmbeddingService {
  private getEmbeddingModel(): EmbeddingModel {
    return createProvider().embedding(config.embeddingModelId);
  }

  /** Generate an embedding vector for the given text. */
  async generateEmbedding(agentId: string, text: string): Promise<number[] | null> {
    if (!config.embeddingModelId) {
      // No embedding deployment configured (possible on Azure) — skip the SDK
      // call entirely instead of failing on a '' deployment name.
      logger.warn({ agentId }, 'No embedding model configured; skipping embedding generation');
      return null;
    }
    try {
      const { embedding } = await embed({
        model: this.getEmbeddingModel(),
        value: text,
        providerOptions: EMBEDDING_PROVIDER_OPTIONS,
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
      const { embeddings } = await embedMany({
        model: this.getEmbeddingModel(),
        values: texts,
        // Serialize requests: embedMany may otherwise split a large `values`
        // batch and dispatch in parallel, which trips per-account rate limits
        // during heavy backfills (Titan v2 on Bedrock; Azure OpenAI throttles
        // per-deployment the same way). Caller-side BATCH_SIZE keeps the
        // per-call payload small; this guards the rare case where the SDK
        // still parallelizes.
        maxParallelCalls: 1,
        providerOptions: EMBEDDING_PROVIDER_OPTIONS,
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
