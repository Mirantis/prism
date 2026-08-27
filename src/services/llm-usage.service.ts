/**
 * Token spend, read from `llm_calls`.
 *
 * The table holds one row per model call, written as the call returns, so a
 * suppressed heartbeat, a compaction and a classification gate all count.
 */

import prisma from '../lib/prisma';
import { config } from '../config';

export interface LlmUsageSummary {
  windowHours: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  /**
   * Share of the prompt served from cache, 0-100. Null where nothing in the
   * window reported a cache breakdown.
   */
  cacheHitPercent: number | null;
  /**
   * Model calls in the window: one per step of a turn, plus each gate,
   * compaction and thread title.
   */
  calls: number;
}

/** Zeros and a null rate, for a runtime with no agent resolved yet. */
function emptyUsage(windowHours: number): LlmUsageSummary {
  return {
    windowHours,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    noCacheTokens: 0,
    cacheHitPercent: null,
    calls: 0,
  };
}

class LlmUsageService {
  /**
   * Token usage for the window ending now.
   *
   * Filters on the owning agent alone: subagent work is already recorded
   * against the owner, with the child kept in `subagentId` for provenance.
   */
  async summarize(windowHours: number): Promise<LlmUsageSummary> {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const owner = config.agentId;
    if (!owner) return emptyUsage(windowHours);

    const where = { agentId: owner, createdAt: { gte: since } };

    // Counted inside the same aggregate, so the token total and the call count
    // come from one snapshot. Recording is fire-and-forget, so a call can land
    // between two reads.
    const totals = await prisma.llmCall.aggregate({
      where,
      _count: true,
      _sum: {
        totalTokens: true,
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        noCacheTokens: true,
      },
    });

    const sum = totals._sum;
    const cacheReadTokens = sum.cacheReadTokens ?? 0;
    const cacheWriteTokens = sum.cacheWriteTokens ?? 0;
    const noCacheTokens = sum.noCacheTokens ?? 0;

    // The three details are the prompt, so they are the denominator;
    // `inputTokens` already includes the cache reads and writes.
    const prompt = cacheReadTokens + cacheWriteTokens + noCacheTokens;

    return {
      windowHours,
      totalTokens: sum.totalTokens ?? 0,
      inputTokens: sum.inputTokens ?? 0,
      outputTokens: sum.outputTokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens,
      noCacheTokens,
      cacheHitPercent: prompt > 0 ? Math.round((cacheReadTokens / prompt) * 100) : null,
      calls: totals._count,
    };
  }
}

export const llmUsageService = new LlmUsageService();
