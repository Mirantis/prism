/**
 * Memory Manager Service
 *
 * Simplified memory system with a flat MemoryEntry table.
 * Agent curates what's worth keeping - no automatic daily grouping.
 *
 * Key insight: Memory ≠ Context
 * - Context: What model sees per request (ephemeral, bounded, expensive)
 * - Memory: What's stored in DB (persistent, unbounded, cheap, searchable)
 *
 * Search uses pgvector cosine similarity (embedding-based).
 */

import { MemoryEntry } from '@prisma/client';
import prisma from '../lib/prisma';
import { embeddingService } from './embedding.service';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export interface MemorySearchResult {
  id: string;
  content: string;
  category: string;
  importance: number;
  createdAt: Date;
}

export interface MemoryWriteInput {
  content: string;
  category: string;
  importance?: number;
}

// ============================================================================
// Memory Manager Service
// ============================================================================

class MemoryManagerService {
  /**
   * Search memory entries using pgvector cosine similarity.
   */
  async search(
    userId: string,
    query: string,
    options: {
      categories?: string[];
      limit?: number;
      daysBack?: number;
      agentId: string;
    }
  ): Promise<MemorySearchResult[]> {
    if (!query) return [];

    const agentId = options.agentId;
    const limit = options.limit ?? 25;
    const daysBack = options.daysBack ?? 365;
    const cutoffDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const queryEmbedding = await embeddingService.generateEmbedding(agentId, query);
    if (!queryEmbedding) {
      return [];
    }

    return embeddingService.searchByEmbedding(agentId, queryEmbedding, {
      categories: options.categories,
      limit,
      cutoffDate,
      similarityThreshold: 0.3,
    });
  }

  /**
   * Write to memory.
   * Generates and stores an embedding asynchronously (fire-and-forget).
   */
  async write(userId: string, input: MemoryWriteInput, options: { agentId: string }): Promise<MemoryEntry> {
    const entry = await prisma.memoryEntry.create({
      data: {
        agentId: options.agentId,
        content: input.content,
        category: input.category,
        importance: input.importance ?? 5,
      },
    });

    // Generate embedding in background — entry exists even if this fails
    embeddingService.generateAndStoreEmbedding(options.agentId, entry.id, input.content)
      .catch(err => logger.warn({ err, entryId: entry.id }, 'Failed to generate embedding for memory entry'));

    return entry;
  }

  /**
   * Delete a memory entry by ID
   */
  async delete(userId: string, entryId: string, agentId: string): Promise<boolean> {
    const result = await prisma.memoryEntry.deleteMany({
      where: {
        id: entryId,
        agentId,
      },
    });

    return result.count > 0;
  }

  /**
   * Delete multiple memory entries by IDs
   */
  async deleteMany(userId: string, entryIds: string[], options: { agentId: string }): Promise<number> {
    const result = await prisma.memoryEntry.deleteMany({
      where: {
        id: { in: entryIds },
        agentId: options.agentId,
      },
    });

    return result.count;
  }

  /**
   * Get entries by category
   */
  async getByCategory(
    userId: string,
    category: string,
    agentId: string,
    limit: number = 20
  ): Promise<MemorySearchResult[]> {
    const entries = await prisma.memoryEntry.findMany({
      where: {
        agentId,
        category,
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });

    return entries.map(entry => ({
      id: entry.id,
      content: entry.content,
      category: entry.category,
      importance: entry.importance,
      createdAt: entry.createdAt,
    }));
  }

  /**
   * Build memory context for automatic injection into LLM system prompt.
   *
   * Returns formatted markdown combining two sources:
   * 1. High-importance entries (importance >= 9) — "pinned" knowledge, no date cutoff
   * 2. Query-relevant entries — embedding-matched against the user's message
   *
   * Returns empty string when no memories match (caller skips injection).
   */
  async buildMemoryContext(userId: string, agentId: string, query?: string): Promise<string> {
    const MAX_IMPORTANT = 15;
    const MAX_RELEVANT = 10;
    const CHAR_BUDGET = 4000;

    // 1. High-importance entries — no date cutoff, these are "pinned" knowledge
    const importantEntries = await prisma.memoryEntry.findMany({
      where: {
        agentId,
        importance: { gte: 9 },
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: MAX_IMPORTANT,
    });

    // 2. Query-relevant entries via semantic search
    let relevantEntries: MemorySearchResult[] = [];
    if (query) {
      relevantEntries = await this.search(userId, query, {
        limit: MAX_RELEVANT,
        daysBack: 365,
        agentId,
      });
      // Deduplicate — remove entries already in the important set
      const importantIds = new Set(importantEntries.map(e => e.id));
      relevantEntries = relevantEntries.filter(e => !importantIds.has(e.id));
    }

    // 3. Bail out early if nothing to show
    if (importantEntries.length === 0 && relevantEntries.length === 0) {
      return '';
    }

    // 4. Format with character budget
    const parts: string[] = [];
    let charCount = 0;

    // Group important entries by category
    if (importantEntries.length > 0) {
      const byCategory = new Map<string, typeof importantEntries>();
      for (const entry of importantEntries) {
        const list = byCategory.get(entry.category) || [];
        list.push(entry);
        byCategory.set(entry.category, list);
      }

      for (const [category, entries] of byCategory) {
        if (charCount >= CHAR_BUDGET) break;
        const header = `## ${category.charAt(0).toUpperCase() + category.slice(1)}s`;
        parts.push(header);
        charCount += header.length + 1; // +1 for newline separator
        for (const entry of entries) {
          if (charCount >= CHAR_BUDGET) break;
          const line = `- ${entry.content}`;
          parts.push(line);
          charCount += line.length + 1; // +1 for newline separator
        }
      }
    }

    // Query-relevant section
    if (relevantEntries.length > 0 && charCount < CHAR_BUDGET) {
      const sectionHeader = '\n## Relevant to Current Query';
      parts.push(sectionHeader);
      charCount += sectionHeader.length + 1; // +1 for newline separator
      for (const entry of relevantEntries) {
        if (charCount >= CHAR_BUDGET) break;
        const line = `- ${entry.content}`;
        parts.push(line);
        charCount += line.length + 1; // +1 for newline separator
      }
    }

    return parts.join('\n');
  }

  /**
   * Cleanup old low-importance memories (retention policy)
   * Only removes entries with importance < threshold that are older than daysToKeep
   */
  async cleanup(
    userId: string,
    agentId: string,
    daysToKeep: number = 30,
    importanceThreshold: number = 3
  ): Promise<number> {
    const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const result = await prisma.memoryEntry.deleteMany({
      where: {
        agentId,
        createdAt: { lt: cutoff },
        importance: { lt: importanceThreshold },
      },
    });

    return result.count;
  }

  /**
   * Get memory stats for a user
   */
  async getStats(userId: string, agentId: string): Promise<{
    totalEntries: number;
    byCategory: Record<string, number>;
    avgImportance: number;
  }> {
    const [totalEntries, categoryStats, avgResult] = await Promise.all([
      prisma.memoryEntry.count({ where: { agentId } }),
      prisma.memoryEntry.groupBy({
        by: ['category'],
        where: { agentId },
        _count: { id: true },
      }),
      prisma.memoryEntry.aggregate({
        where: { agentId },
        _avg: { importance: true },
      }),
    ]);

    const byCategory: Record<string, number> = {};
    for (const stat of categoryStats) {
      byCategory[stat.category] = stat._count.id;
    }

    return {
      totalEntries,
      byCategory,
      avgImportance: avgResult._avg.importance ?? 0,
    };
  }
}

// Export singleton instance
export const memoryManagerService = new MemoryManagerService();
