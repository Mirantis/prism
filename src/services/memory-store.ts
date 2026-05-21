/**
 * Memory Embedding Store
 *
 * Provider-aware wrapper around vector storage + search for memory entries.
 * - Postgres: pgvector via Prisma raw SQL (existing behavior, lifted as-is).
 * - SQLite (single-agent mode): sqlite-vec `memory_entry_vec` virtual table
 *   via a sibling better-sqlite3 handle, because Prisma's SQLite engine
 *   refuses `load_extension`.
 *
 * Consumers (`embedding.service.ts`) call through this abstraction rather
 * than inlining raw SQL. The active store is picked once at module load
 * based on `config.singleAgentMode`.
 */

import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { initSqliteVec, EMBEDDING_DIMENSION } from '../lib/sqlite-bootstrap';
import type { MemorySearchResult } from './memory-manager.service';

const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
const MAX_SEARCH_LIMIT = 100;

export interface SearchOptions {
  categories?: string[];
  limit: number;
  cutoffDate: Date;
  similarityThreshold?: number;
}

export interface MemoryEmbeddingStore {
  storeEmbedding(entryId: string, embedding: number[]): Promise<void>;
  searchByEmbedding(
    agentId: string,
    queryEmbedding: number[],
    options: SearchOptions,
  ): Promise<MemorySearchResult[]>;
}

// ============================================================================
// Postgres (pgvector) implementation — current behavior lifted from
// embedding.service.ts without functional change.
// ============================================================================

const pgStore: MemoryEmbeddingStore = {
  async storeEmbedding(entryId, embedding) {
    if (embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding dimensionality mismatch: expected ${EMBEDDING_DIMENSION}, got ${embedding.length}`,
      );
    }
    const vectorStr = `[${embedding.join(',')}]`;
    await prisma.$executeRaw`UPDATE "memory_entries" SET "embedding" = ${vectorStr}::vector WHERE "id" = ${entryId}`;
  },

  async searchByEmbedding(agentId, queryEmbedding, options) {
    const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

    if (queryEmbedding.length !== EMBEDDING_DIMENSION) {
      logger.warn(
        { agentId, actual: queryEmbedding.length, expected: EMBEDDING_DIMENSION },
        'Skipping embedding search due to dimension mismatch',
      );
      return [];
    }

    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const clampedLimit = Math.max(1, Math.min(options.limit, MAX_SEARCH_LIMIT));

    const categoryFilter = options.categories?.length
      ? `AND "category" = ANY($6::text[])`
      : '';

    const sql = `
      SELECT "id", "content", "category", "importance", "createdAt"
      FROM "memory_entries"
      WHERE "agentId" = $1
        AND "embedding" IS NOT NULL
        AND "createdAt" >= $2
        AND 1 - ("embedding" <=> $3::vector) >= $4
        ${categoryFilter}
      ORDER BY "embedding" <=> $3::vector ASC
      LIMIT $5
    `;

    const params: unknown[] = [agentId, options.cutoffDate, vectorStr, threshold, clampedLimit];
    if (options.categories?.length) {
      params.push(options.categories);
    }

    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; content: string; category: string; importance: number; createdAt: Date }>
    >(sql, ...params);

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      importance: row.importance,
      createdAt: row.createdAt,
    }));
  },
};

// ============================================================================
// SQLite (sqlite-vec) implementation — new.
//
// `memory_entries` (Prisma table) stores metadata + a packed Float32Array
// blob in the `embedding` column so the durable source of truth survives
// restarts. `memory_entry_vec` (vec0 virtual table) is the runtime search
// index rebuilt on boot from those blobs.
//
// Both writes run through the **same** `better-sqlite3` handle inside a
// single transaction. If the vec0 upsert fails the blob UPDATE rolls back
// with it, so the two stores can never disagree mid-session. Prisma still
// owns the table's schema (via `prisma/sqlite/schema.prisma`) and all
// reads — this just takes over the one write path where atomicity with
// vec0 is required.
//
// Search returns (id, distance). We join back to `memory_entries` via
// Prisma for the metadata columns, using the ids returned by the vec search.
// ============================================================================

function packEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

const sqliteStore: MemoryEmbeddingStore = {
  async storeEmbedding(entryId, embedding) {
    if (embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Embedding dimensionality mismatch: expected ${EMBEDDING_DIMENSION}, got ${embedding.length}`,
      );
    }

    const blob = packEmbedding(embedding);
    const db = initSqliteVec();

    // One transaction over the shared handle: durable blob + vec0 index
    // move together. vec0 doesn't support ON CONFLICT, so the index
    // upsert is a DELETE+INSERT pair.
    const upsert = db.transaction(() => {
      db.prepare(`UPDATE memory_entries SET embedding = ? WHERE id = ?`).run(blob, entryId);
      db.prepare(`DELETE FROM memory_entry_vec WHERE memory_entry_id = ?`).run(entryId);
      db.prepare(`INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)`).run(
        entryId,
        blob,
      );
    });
    upsert();
  },

  async searchByEmbedding(agentId, queryEmbedding, options) {
    const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

    if (queryEmbedding.length !== EMBEDDING_DIMENSION) {
      logger.warn(
        { agentId, actual: queryEmbedding.length, expected: EMBEDDING_DIMENSION },
        'Skipping embedding search due to dimension mismatch',
      );
      return [];
    }

    const clampedLimit = Math.max(1, Math.min(options.limit, MAX_SEARCH_LIMIT));
    const db = initSqliteVec();

    // sqlite-vec returns cosine distance (1 - similarity). Convert threshold.
    const maxDistance = 1 - threshold;

    // Fetch k nearest by distance. Over-fetch slightly and then filter by
    // agentId + cutoffDate + optional categories via the metadata table,
    // because vec0 doesn't store those attributes.
    const overFetch = Math.min(clampedLimit * 4, MAX_SEARCH_LIMIT * 4);
    const hits = db
      .prepare(
        `SELECT memory_entry_id AS id, distance
         FROM memory_entry_vec
         WHERE embedding MATCH ? AND distance <= ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(packEmbedding(queryEmbedding), maxDistance, overFetch) as Array<{
        id: string;
        distance: number;
      }>;

    if (hits.length === 0) return [];

    const ids = hits.map((h) => h.id);
    const filter: Record<string, unknown> = {
      id: { in: ids },
      agentId,
      createdAt: { gte: options.cutoffDate },
    };
    if (options.categories?.length) {
      filter.category = { in: options.categories };
    }

    const rows = await prisma.memoryEntry.findMany({
      where: filter,
      select: { id: true, content: true, category: true, importance: true, createdAt: true },
    });

    // Preserve distance order returned by vec0.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered: MemorySearchResult[] = [];
    for (const hit of hits) {
      const row = byId.get(hit.id);
      if (row) {
        ordered.push({
          id: row.id,
          content: row.content,
          category: row.category,
          importance: row.importance,
          createdAt: row.createdAt,
        });
        if (ordered.length >= clampedLimit) break;
      }
    }
    return ordered;
  },
};

// ============================================================================
// Module-level selector
// ============================================================================

export const memoryEmbeddingStore: MemoryEmbeddingStore = config.singleAgentMode
  ? sqliteStore
  : pgStore;
