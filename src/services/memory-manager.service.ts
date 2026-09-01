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

/**
 * An entry rendered as one line.
 *
 * Both surfaces are newline-joined lists, so an entry holding a newline and `- ` can
 * append entries of its own — with a `(category, recorded …)` suffix that looks just
 * as authored. That suffix exists because the agent would not use a recall until it
 * could see where each line came from, and provenance the content can forge is not
 * provenance. What an entry may contain is not ours to trust: the agent writes them,
 * but out of whatever it has read.
 */
function oneLine(content: string): string {
  return content.replace(/\s*\n\s*/g, ' ').trim();
}

/** At and above this score an entry is pinned: carried every turn, query or not. */
const PINNED_IMPORTANCE = 9;
const MAX_PINNED = 15;
const MAX_RELEVANT = 10;
const PINNED_CHAR_BUDGET = 4000;
/** Half the pinned budget: this half is billed per turn, the pinned half is cached. */
const RELEVANT_CHAR_BUDGET = 2000;

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
   * The agent's pinned knowledge: every entry it scored `importance >= 9`.
   *
   * No query — these are returned whatever the turn is about, which is why they are
   * a stable system-prompt section rather than part of the per-turn recall. They
   * change only when the agent pins or drops one, so they cache like the rest of the
   * prompt; carried per turn they re-billed the whole conversation behind them on
   * every turn of any thread whose agent had pinned a single entry.
   *
   * Returns an empty string when nothing is pinned (caller drops the section).
   */
  /**
   * The pinned entries that actually fit, in the order they will render.
   *
   * Budget applied here rather than while rendering, so one function decides what is
   * pinned and `buildRelevantMemories` can exclude exactly that set. Excluding by the
   * importance threshold instead left an entry in neither surface whenever the
   * character budget cut it — four pinned entries of 1,500 characters lose the fourth
   * with only three pinned — reachable then only by an explicit search.
   *
   * `id` breaks the sort. `importance >= 9` collapses to a couple of values in
   * practice and `memory_write` can create several entries in one turn, so
   * `createdAt` ties with nothing behind it; a swap there reorders a whole category
   * inside the one cached prefix this section exists to keep stable.
   */
  private async selectPinnedEntries(agentId: string): Promise<MemoryEntry[]> {
    const entries = await prisma.memoryEntry.findMany({
      where: { agentId, importance: { gte: PINNED_IMPORTANCE } },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: MAX_PINNED,
    });

    const fitted: MemoryEntry[] = [];
    let charCount = 0;
    for (const entry of entries) {
      const line = `- ${oneLine(entry.content)}`;
      if (charCount + line.length + 1 > PINNED_CHAR_BUDGET) break;
      fitted.push(entry);
      charCount += line.length + 1;
    }
    return fitted;
  }

  /**
   * The agent's pinned knowledge: the entries it scored `importance >= 9`.
   *
   * No query — these come back whatever the turn is about, which is why they are a
   * stable system-prompt section rather than part of the per-turn recall. They change
   * only when the agent pins or drops one, so they cache like the rest of the prompt;
   * carried per turn they re-billed the whole conversation behind them on every turn
   * of any thread whose agent had pinned a single entry.
   *
   * Returns an empty string when nothing is pinned (caller drops the section).
   */
  async buildPinnedMemories(agentId: string): Promise<string> {
    const entries = await this.selectPinnedEntries(agentId);
    if (entries.length === 0) return '';

    const byCategory = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const list = byCategory.get(entry.category) || [];
      list.push(entry);
      byCategory.set(entry.category, list);
    }

    // Grouped first, so a header cannot render with nothing under it.
    const parts: string[] = [];
    for (const [category, group] of byCategory) {
      parts.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}s`);
      for (const entry of group) parts.push(`- ${oneLine(entry.content)}`);
    }
    return parts.join('\n');
  }

  /**
   * What this turn's message matches, by meaning.
   *
   * Pinned entries are left out: `buildPinnedMemories` already carries them from the
   * system prompt, where they cost nothing per turn.
   *
   * Its budget is smaller than the pinned one because this half is billed on every
   * turn that matches something, while the pinned half is billed once and then read
   * from cache.
   *
   * Returns an empty string when nothing matches (caller sends no block).
   */
  async buildRelevantMemories(userId: string, agentId: string, query?: string): Promise<string> {
    if (!query) return '';

    // Dropped by id, not by importance: only the entries the pinned section actually
    // emits are already in front of the agent. Anything the pinned caps left out is
    // still reachable here, which is what the threshold check got wrong.
    const pinnedIds = new Set((await this.selectPinnedEntries(agentId)).map((e) => e.id));
    const matches = (
      await this.search(userId, query, { limit: MAX_RELEVANT, daysBack: 365, agentId })
    ).filter((entry) => !pinnedIds.has(entry.id));
    if (matches.length === 0) return '';

    // Each line carries when it was recorded and what kind of entry it is. Asked to
    // stand behind a recall, an agent given the bare text answered that it had "no
    // source, timestamp, or citation attached — just an assertion that appeared in
    // the prompt", and declined it. Provenance is what that asks for; an assertion
    // that the entries are trustworthy is what it refuses.
    const parts: string[] = [];
    let charCount = 0;
    for (const entry of matches) {
      const recorded = entry.createdAt.toISOString().slice(0, 10);
      const line = `- ${oneLine(entry.content)} (${entry.category}, recorded ${recorded})`;
      // Tested before the line is added, so the budget is a ceiling. Testing after
      // let the last entry carry the whole block past it.
      if (charCount + line.length + 1 > RELEVANT_CHAR_BUDGET) break;
      parts.push(line);
      charCount += line.length + 1;
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
