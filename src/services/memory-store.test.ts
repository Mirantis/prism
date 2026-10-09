/**
 * Tests for memory-store. The SQLite single-transaction dual-write shape
 * is covered here. The actual sqlite-vec query path needs a live DB, so we
 * inspect which `prepare()` statements flow through the better-sqlite3
 * handle — that's enough to guard against regressions where one of the
 * three writes escapes the transaction. Search stubs the kNN hits and the
 * metadata read, and checks the window, the order and the limit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => ({
  default: {
    memoryEntry: { findMany: vi.fn() },
  },
}));

// Shared spy state across tests so we can inspect prepare() calls.
const { sqliteMock } = vi.hoisted(() => {
  return {
    sqliteMock: {
      prepareCalls: [] as string[],
      transactionCalls: 0,
      runImpls: new Map<string, () => void>(),
      hits: [] as Array<{ id: string; distance: number }>,
      /** The k of each kNN query, in order. */
      ks: [] as number[],
    },
  };
});

vi.mock('../lib/sqlite-bootstrap', () => ({
  initSqliteVec: vi.fn(() => ({
    prepare: (sql: string) => {
      sqliteMock.prepareCalls.push(sql);
      return {
        run: (..._args: unknown[]) => {
          const impl = sqliteMock.runImpls.get(sql);
          if (impl) impl();
        },
        // The kNN's third parameter is k: it returns at most that many of the nearest.
        all: (...args: unknown[]) => {
          const k = args[2] as number;
          sqliteMock.ks.push(k);
          return sqliteMock.hits.slice(0, k);
        },
      };
    },
    // better-sqlite3's transaction(fn) returns a function that, when called,
    // invokes fn inside a transaction. For the tests we invoke fn directly
    // so a throw surfaces as in the real API.
    transaction: (fn: () => void) => () => {
      sqliteMock.transactionCalls++;
      fn();
    },
  })),
  EMBEDDING_DIMENSION: 1024,
}));

async function importFresh() {
  vi.resetModules();
  return import('./memory-store');
}

describe('memory-store', () => {
  beforeEach(() => {
    sqliteMock.prepareCalls = [];
    sqliteMock.transactionCalls = 0;
    sqliteMock.runImpls.clear();
    sqliteMock.hits = [];
    sqliteMock.ks = [];
  });

  it('rejects wrong-dimension embeddings', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    await expect(
      memoryEmbeddingStore.storeEmbedding('entry-1', Array.from({ length: 128 }, () => 0.1)),
    ).rejects.toThrow(/dimensionality mismatch/);
  });

  it('issues UPDATE + DELETE + INSERT inside a single transaction', async () => {
    const { memoryEmbeddingStore } = await importFresh();

    await memoryEmbeddingStore.storeEmbedding('entry-1', Array.from({ length: 1024 }, () => 0.1));

    // All three statements live on the better-sqlite3 handle.
    expect(sqliteMock.transactionCalls).toBe(1);
    expect(sqliteMock.prepareCalls).toHaveLength(3);
    expect(sqliteMock.prepareCalls[0]).toMatch(/^UPDATE memory_entries SET embedding/);
    expect(sqliteMock.prepareCalls[1]).toMatch(/^DELETE FROM memory_entry_vec/);
    expect(sqliteMock.prepareCalls[2]).toMatch(/^INSERT INTO memory_entry_vec/);
  });

  it('propagates vec0 insert failure out of the transaction (so better-sqlite3 rolls back)', async () => {
    const { memoryEmbeddingStore } = await importFresh();
    sqliteMock.runImpls.set(
      'INSERT INTO memory_entry_vec(memory_entry_id, embedding) VALUES (?, ?)',
      () => {
        throw new Error('vec0 full');
      },
    );

    await expect(
      memoryEmbeddingStore.storeEmbedding('entry-1', Array.from({ length: 1024 }, () => 0.1)),
    ).rejects.toThrow(/vec0 full/);

    // All three statements attempted inside the same transaction; rollback
    // is better-sqlite3's guarantee once the callback throws.
    expect(sqliteMock.transactionCalls).toBe(1);
    expect(sqliteMock.prepareCalls).toHaveLength(3);
  });

  describe('searchByEmbedding', () => {
    const query = Array.from({ length: 1024 }, () => 0.1);
    const row = (id: string, createdAt: string) => ({
      id,
      content: id,
      category: 'observation',
      importance: 5,
      createdAt: new Date(createdAt),
    });
    // Nearest first, and the nearest is the oldest.
    const near = row('near', '2026-10-01T00:00:00Z');
    const mid = row('mid', '2026-10-02T00:00:00Z');
    const far = row('far', '2026-10-03T00:00:00Z');

    async function search(options: Partial<import('./memory-store').SearchOptions>) {
      const { memoryEmbeddingStore } = await importFresh();
      const { default: prisma } = await import('../lib/prisma');
      const findMany = vi.mocked(prisma.memoryEntry.findMany);
      // The metadata read has no set order unless it asks for one.
      findMany.mockImplementation((async (args: { orderBy?: unknown; take?: number }) =>
        (args.orderBy ? [far, mid, near] : [mid, far, near]).slice(0, args.take)) as never);
      sqliteMock.hits = [
        { id: 'near', distance: 0.1 },
        { id: 'mid', distance: 0.2 },
        { id: 'far', distance: 0.3 },
      ];
      const results = await memoryEmbeddingStore.searchByEmbedding('agent-1', query, { limit: 2, ...options });
      return { results, findMany };
    }

    it('keeps the closest matches first by default', async () => {
      const { results, findMany } = await search({});

      expect(results.map((r) => r.id)).toEqual(['near', 'mid']);
      expect(findMany.mock.lastCall?.[0]).not.toHaveProperty('orderBy');
    });

    // Ordered before the limit: newest-first chooses among every match, rather than
    // reordering the two closest.
    it('puts the newest matches first when asked', async () => {
      const { results } = await search({ sort: 'newest' });

      expect(results.map((r) => r.id)).toEqual(['far', 'mid']);
    });

    // The window drops the four nearest hits, so the one match inside it is fifth.
    it('fetches further when the filters leave fewer matches than the limit', async () => {
      const { memoryEmbeddingStore } = await importFresh();
      const { default: prisma } = await import('../lib/prisma');
      const inWindow = row('fifth', '2026-10-06T12:00:00Z');
      vi.mocked(prisma.memoryEntry.findMany).mockImplementation((async (args: {
        where: { id: { in: string[] } };
      }) => (args.where.id.in.includes('fifth') ? [inWindow] : [])) as never);
      sqliteMock.hits = ['a', 'b', 'c', 'd', 'fifth'].map((id, i) => ({ id, distance: 0.1 * (i + 1) }));

      const results = await memoryEmbeddingStore.searchByEmbedding('agent-1', query, {
        limit: 1,
        since: new Date('2026-10-06T00:00:00Z'),
      });

      expect(results.map((r) => r.id)).toEqual(['fifth']);
      expect(sqliteMock.ks).toEqual([4, 16]);
    });

    it('reads every match vec0 returns before putting the newest first', async () => {
      await search({ sort: 'newest' });

      expect(sqliteMock.ks).toEqual([4096]);
    });

    it('filters the matches to the window', async () => {
      const since = new Date('2026-10-02T00:00:00Z');
      const until = new Date('2026-10-02T23:59:59.999Z');

      const { findMany } = await search({ since, until });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['near', 'mid', 'far'] }, agentId: 'agent-1', createdAt: { gte: since, lte: until } },
        }),
      );
    });
  });
});
