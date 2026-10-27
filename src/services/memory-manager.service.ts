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

/** `relevance` keeps the closest matches first; `newest` the most recently recorded. */
export type MemorySort = 'relevance' | 'newest';

export interface MemorySearchOptions {
  agentId: string;
  categories?: string[];
  limit?: number;
  /** Inclusive bounds on when an entry was recorded. Either may be left out. */
  since?: Date;
  until?: Date;
  sort?: MemorySort;
}

/** A rendered block and the entries it shows, so another block of the same turn can leave them out. */
export interface MemoryBlock {
  text: string;
  entryIds: string[];
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

/** At and above this score an entry is carried every turn, query or not. */
const MIN_IMPORTANT_SCORE = 9;
const MAX_IMPORTANT = 15;
const MAX_RELEVANT = 10;
const IMPORTANT_CHAR_BUDGET = 4000;
/** Half the important budget: this half is billed per turn, the other is cached. */
const RELEVANT_CHAR_BUDGET = 2000;
/** How far back a new conversation looks for what the agent recorded before it. */
const RECENT_WINDOW_MS = 4 * 60 * 60 * 1000;
const MAX_RECENT = 8;
const RECENT_CHAR_BUDGET = 2000;
/** The automatic per-turn recall looks back a year. */
const RELEVANT_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Cosine similarity at which `writeIfNew` treats a stored entry as the same fact.
 * Set high, so a skipped fact is a near-repeat; two facts that differ in one word
 * can still score above it, and the second is then not stored.
 */
const DUPLICATE_SIMILARITY = 0.9;

class MemoryManagerService {
  /**
   * Search memory entries by meaning, inside an optional time window.
   *
   * With no search words it lists the newest entries in the window instead. That read
   * needs no embedding, so it also works with embeddings switched off.
   */
  async search(
    userId: string,
    query: string | undefined,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]> {
    const { agentId, categories, since, until } = options;
    const limit = options.limit ?? 25;
    if (!query?.trim()) return this.listRecent(agentId, { categories, since, until, limit });

    const queryEmbedding = await embeddingService.generateEmbedding(agentId, query);
    if (!queryEmbedding) {
      return [];
    }

    return embeddingService.searchByEmbedding(agentId, queryEmbedding, {
      categories,
      limit,
      since,
      until,
      sort: options.sort,
      similarityThreshold: 0.3,
    });
  }

  /** The newest entries in a time window. `id` breaks a tie, so the order is stable. */
  private async listRecent(
    agentId: string,
    options: {
      categories?: string[];
      since?: Date;
      until?: Date;
      excludeIds?: string[];
      limit: number;
    },
  ): Promise<MemorySearchResult[]> {
    return prisma.memoryEntry.findMany({
      where: {
        agentId,
        createdAt: { gte: options.since, lte: options.until },
        ...(options.categories?.length ? { category: { in: options.categories } } : {}),
        ...(options.excludeIds?.length ? { id: { notIn: options.excludeIds } } : {}),
      },
      select: { id: true, content: true, category: true, importance: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: options.limit,
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
   * Write, unless an entry with the same meaning is stored already: one at
   * `DUPLICATE_SIMILARITY` or closer, or with embeddings off, one with the same text.
   * For writes nobody reviews, which can repeat what an earlier one stored. Returns
   * null when it wrote nothing.
   */
  async writeIfNew(userId: string, input: MemoryWriteInput, options: { agentId: string }): Promise<MemoryEntry | null> {
    const { agentId } = options;
    const embedding = await embeddingService.generateEmbedding(agentId, input.content);
    const known = embedding
      ? (await embeddingService.searchByEmbedding(agentId, embedding, {
          limit: 1,
          similarityThreshold: DUPLICATE_SIMILARITY,
        })).length > 0
      : (await prisma.memoryEntry.count({ where: { agentId, content: input.content } })) > 0;
    if (known) return null;

    const entry = await prisma.memoryEntry.create({
      data: { agentId, content: input.content, category: input.category, importance: input.importance ?? 5 },
    });
    if (embedding) {
      await embeddingService
        .storeEmbedding(entry.id, embedding)
        .catch((err) => logger.warn({ err, entryId: entry.id }, 'Failed to store embedding for memory entry'));
    }
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
   * The important entries that fit the budget, in the order they will render.
   *
   * The budget is applied here rather than while rendering, so one function decides
   * the set and `buildRelevantMemories` can exclude exactly it. Excluding by the score
   * threshold instead leaves an entry in neither surface whenever the character budget
   * cuts it, reachable only by an explicit search.
   *
   * `id` breaks the sort. The scores that qualify collapse to a couple of values, and
   * `memory_write` can create several entries in one turn, so `createdAt` can tie with
   * nothing behind it — and a swap reorders a whole category inside the cached prefix
   * this section exists to keep stable.
   */
  private async selectImportantEntries(agentId: string): Promise<MemoryEntry[]> {
    const entries = await prisma.memoryEntry.findMany({
      where: { agentId, importance: { gte: MIN_IMPORTANT_SCORE } },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: MAX_IMPORTANT,
    });

    const fitted: MemoryEntry[] = [];
    let charCount = 0;
    for (const entry of entries) {
      const line = `- ${oneLine(entry.content)}`;
      if (charCount + line.length + 1 > IMPORTANT_CHAR_BUDGET) break;
      fitted.push(entry);
      charCount += line.length + 1;
    }
    return fitted;
  }

  /**
   * The entries the agent scored most important, rendered for the system prompt.
   *
   * No query: these come back whatever the turn is about, which is why they are a
   * stable section rather than part of the per-turn recall. They change only when the
   * agent writes or drops one, so they cache like the rest of the prompt.
   *
   * Returns an empty string when there are none, and the caller drops the section.
   */
  async buildImportantMemories(agentId: string): Promise<string> {
    const entries = await this.selectImportantEntries(agentId);
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
   * What the agent recorded in the hours before a conversation, newest first, for the
   * conversation to open with.
   *
   * Pinned entries are left out, since the system prompt already carries them. A line
   * names the category and not the date, since every entry is from the last four hours.
   *
   * The text is empty when nothing recent is left (caller sends no block).
   */
  async buildRecentMemories(agentId: string): Promise<MemoryBlock> {
    const importantIds = (await this.selectImportantEntries(agentId)).map((e) => e.id);
    const entries = await this.listRecent(agentId, {
      since: new Date(Date.now() - RECENT_WINDOW_MS),
      excludeIds: importantIds,
      limit: MAX_RECENT,
    });

    const lines: string[] = [];
    const entryIds: string[] = [];
    let charCount = 0;
    for (const entry of entries) {
      const line = `- ${oneLine(entry.content)} (${entry.category})`;
      if (charCount + line.length + 1 > RECENT_CHAR_BUDGET) break;
      lines.push(line);
      entryIds.push(entry.id);
      charCount += line.length + 1;
    }
    return { text: lines.join('\n'), entryIds };
  }

  /**
   * What this turn's message matches, by meaning.
   *
   * Pinned entries are left out: `buildImportantMemories` already carries them from the
   * system prompt, where they cost nothing per turn. So is every entry in `shownIds`,
   * which another block of the same turn shows.
   *
   * Its budget is smaller than the pinned one because this half is billed on every
   * turn that matches something, while the pinned half is billed once and then read
   * from cache.
   *
   * Returns an empty string when nothing matches (caller sends no block).
   */
  async buildRelevantMemories(
    userId: string,
    agentId: string,
    query?: string,
    shownIds: string[] = [],
  ): Promise<string> {
    if (!query) return '';

    // Dropped by id, not by importance: only the entries the pinned section actually
    // emits are already in front of the agent. Anything the pinned caps left out is
    // still reachable here, which is what the threshold check got wrong.
    const importantIds = (await this.selectImportantEntries(agentId)).map((e) => e.id);
    const excluded = new Set([...importantIds, ...shownIds]);
    const since = new Date(Date.now() - RELEVANT_WINDOW_MS);
    const matches = (
      await this.search(userId, query, { limit: MAX_RELEVANT, since, agentId })
    ).filter((entry) => !excluded.has(entry.id));
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
      // The budget is a ceiling, so the line has to fit before it is added.
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
