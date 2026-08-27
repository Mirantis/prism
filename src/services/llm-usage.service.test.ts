/**
 * LLM Usage Service Tests
 *
 * An aggregate over `llm_calls`, so what matters is the cache denominator and
 * the difference between "no cache" and "not measured".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    llmCall: {
      aggregate: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: mockPrisma,
  default: mockPrisma,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { llmUsageService } from './llm-usage.service';
import { config } from '../config';

/** What `llmCall.aggregate` returns, with the cache split filled in. */
function sums(over: Partial<Record<string, number>> = {}, count = 2) {
  return {
    _count: count,
    _sum: {
      totalTokens: 1100,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
      noCacheTokens: 200,
      ...over,
    },
  };
}

/** An aggregate over a window with no calls in it. */
function noSums() {
  return {
    _count: 0,
    _sum: {
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      noCacheTokens: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('llmUsageService.summarize', () => {
  it('sums the window and derives the cache hit rate from the three details', async () => {
    mockPrisma.llmCall.aggregate.mockResolvedValue(sums());

    const summary = await llmUsageService.summarize(24);

    expect(summary.windowHours).toBe(24);
    expect(summary.calls).toBe(2);
    expect(summary.totalTokens).toBe(1100);
    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(100);
    // 700 read of a 1000-token prompt (700+100+200), not of 1100.
    expect(summary.cacheHitPercent).toBe(70);
  });

  it('counts every model call, not only the ones that published a message', async () => {
    // The whole point of the table: a suppressed heartbeat, a compaction and a
    // gate publish nothing, and the service must not filter any of them out.
    mockPrisma.llmCall.aggregate.mockResolvedValue(sums({}, 9));

    expect((await llmUsageService.summarize(24)).calls).toBe(9);

    const where = mockPrisma.llmCall.aggregate.mock.calls[0][0].where;
    expect(Object.keys(where).sort()).toEqual(['agentId', 'createdAt']);
  });

  it('filters on the owning agent, and counts inside the same aggregate', async () => {
    mockPrisma.llmCall.aggregate.mockResolvedValue(noSums());

    await llmUsageService.summarize(24);

    expect(mockPrisma.llmCall.aggregate.mock.calls[0][0].where.agentId).toBe(config.agentId);
    // One read, so the totals and the count cannot straddle a concurrent insert.
    expect(mockPrisma.llmCall.aggregate.mock.calls[0][0]._count).toBe(true);
  });

  it('reads the window back from now, in hours', async () => {
    mockPrisma.llmCall.aggregate.mockResolvedValue(noSums());

    const before = Date.now();
    await llmUsageService.summarize(24);

    const since = mockPrisma.llmCall.aggregate.mock.calls[0][0].where.createdAt.gte as Date;
    expect(Math.abs(since.getTime() - (before - 24 * 60 * 60 * 1000))).toBeLessThan(2000);
  });

  it('reports an unmeasured cache as null, not as 0%', async () => {
    // What an OpenAI-surface provider gives: a prompt size, no cache split.
    mockPrisma.llmCall.aggregate.mockResolvedValue(
      sums({ cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 }),
    );

    const summary = await llmUsageService.summarize(24);

    expect(summary.cacheHitPercent).toBeNull();
    expect(summary.inputTokens).toBe(1000);
  });

  it('reports a real zero hit rate as 0, not as null', async () => {
    mockPrisma.llmCall.aggregate.mockResolvedValue(
      sums({ cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 1000 }),
    );

    expect((await llmUsageService.summarize(24)).cacheHitPercent).toBe(0);
  });

  it("keeps the provider's own total, which can exceed input plus output", async () => {
    mockPrisma.llmCall.aggregate.mockResolvedValue(sums({ totalTokens: 1400 }));

    const summary = await llmUsageService.summarize(24);

    expect(summary.totalTokens).toBe(1400);
    expect(summary.inputTokens).toBe(1000);
  });

  it('is all zeros and a null rate on an empty window', async () => {
    // Prisma returns null sums when nothing matched, not zeros.
    mockPrisma.llmCall.aggregate.mockResolvedValue(noSums());

    const summary = await llmUsageService.summarize(24);

    expect(summary.totalTokens).toBe(0);
    expect(summary.inputTokens).toBe(0);
    expect(summary.calls).toBe(0);
    expect(summary.cacheHitPercent).toBeNull();
  });
});
